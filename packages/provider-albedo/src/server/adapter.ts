import { MessageId, isCompactionCommandMessage } from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import type {
  OrchestrationV2AppThread,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2TurnItem,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { IdAllocatorV2 } from "@t3tools/provider-core/server/IdAllocator";
import { McpProviderSessions } from "@t3tools/provider-core/server/McpProviderSessions";
import * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  AlbedoClient,
  type AlbedoConnectionError,
  type AlbedoHttpError,
  type AlbedoProtocolError,
  type AlbedoTransportError,
} from "./AlbedoClient.ts";
import { AlbedoInputStore } from "./AlbedoInputStore.ts";
import * as CompactionStore from "./AlbedoCompactionStore.ts";
import { AlbedoSessionStore } from "./AlbedoSessionStore.ts";
import { AlbedoNativeOutcomes, type Outcome } from "./AlbedoNativeOutcomes.ts";
import * as ActiveOutput from "./activeOutput.ts";
import * as Attachments from "./attachments.ts";
import * as Collection from "./collection.ts";
import { capabilities } from "./capabilities.ts";
import * as HistoryContent from "./historyContent.ts";
import { promptWithInstructions } from "./instructions.ts";
import * as Models from "./models.ts";
import * as NativeAgents from "./nativeAgents.ts";
import * as NativeConversation from "./nativeConversation.ts";
import * as McpBridge from "./mcpBridge.ts";
import * as Observation from "./observation.ts";
import type * as Protocol from "./protocol.ts";
import type * as Session from "./sessionProtocol.ts";
import * as Replay from "./sessionReplay.ts";
import * as ScopeStop from "./scopeStop.ts";
import * as Projection from "./turnProjection.ts";
import { driver, providerRef } from "./turnProjection.ts";

type ClientError =
  | AlbedoConnectionError
  | AlbedoHttpError
  | AlbedoProtocolError
  | AlbedoTransportError;
const failure = (detail: string, cause?: unknown) =>
  new Adapter.ProviderAdapterProtocolError({
    driver,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });
const isProtocolError = Schema.is(Adapter.ProviderAdapterProtocolError);
const isSteerDeclined = Schema.is(Adapter.ProviderAdapterSteerDeclinedError);
const isTurnStartError = Schema.is(Adapter.ProviderAdapterTurnStartError);
const wrap = (cause: { readonly message: string }) =>
  isProtocolError(cause) || isTurnStartError(cause) || isSteerDeclined(cause)
    ? cause
    : failure(cause.message, cause);
const validatePolicy = (policy: Adapter.ProviderAdapterV2RuntimePolicy) =>
  policy.runtimeMode !== "full-access" ||
  (policy.maxRuntimeMode !== undefined && policy.maxRuntimeMode !== "full-access")
    ? Effect.fail(
        failure(
          "Albedo currently requires Full access; no native approval or sandbox mode is available",
        ),
      )
    : policy.interactionMode !== "default"
      ? Effect.fail(
          failure(
            "Albedo does not expose a native Plan mode. Use the Crew brief approval before launching work",
          ),
        )
      : policy.cwd === null || policy.cwd.trim() === ""
        ? Effect.fail(failure("Choose a workspace before starting Albedo"))
        : Effect.void;

interface ActiveInput {
  readonly submission: Protocol.Submission;
  readonly messageId: MessageId;
  decision: Protocol.Input | null;
  shownStatus?: "pending" | "completed" | "cancelled";
}

interface ActiveTurn {
  readonly input: Adapter.ProviderAdapterV2TurnInput;
  readonly submission: Protocol.Submission;
  readonly done: Deferred.Deferred<void>;
  turn: OrchestrationV2ProviderTurn;
  decision: Protocol.Input;
  readonly inputs: Map<string, ActiveInput>;
  readonly projections: Map<string, Projection.Projection>;
  readonly emitted: Map<string, OrchestrationV2TurnItem>;
}

const nativeRunIds = (turn: ActiveTurn) =>
  new Set(
    [...turn.inputs.values()].flatMap(({ decision }) =>
      decision?.turn?.id === undefined ? [] : [decision.turn.id],
    ),
  );

const updateInput = (turn: ActiveTurn, decision: Protocol.Input) => {
  const member = turn.inputs.get(decision.id);
  if (member === undefined) return;
  member.decision = decision;
  if (decision.id === turn.submission.inputId) turn.decision = decision;
};

export const makeAdapter = Effect.fn("AlbedoAdapter.make")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly homeDirectory: string;
  readonly connect: Effect.Effect<AlbedoClient["Service"], ClientError>;
}) {
  const ids = yield* IdAllocatorV2;
  const sessions = yield* AlbedoSessionStore;
  const inputs = yield* AlbedoInputStore;
  const compactions = yield* CompactionStore.AlbedoCompactionStore;
  const nativeOutcomes = yield* AlbedoNativeOutcomes;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const host = yield* ProviderHost;
  const mcpSessions = yield* McpProviderSessions;
  const conversationSlots = new Map<symbol, number>();
  const collection = yield* Collection.share(options.connect);
  return Adapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver,
    getCapabilities: Effect.fn("AlbedoAdapter.getCapabilities")(() => Effect.succeed(capabilities)),
    planSelectionTransition: Effect.fn("AlbedoAdapter.planSelectionTransition")(() =>
      Effect.succeed({ type: "apply_on_next_turn" as const }),
    ),
    openSession: Effect.fn("AlbedoAdapter.openSession")(function* (open) {
      yield* validatePolicy(open.runtimePolicy);
      let client = yield* options.connect.pipe(Effect.mapError(wrap));
      const scope = yield* Effect.scope;
      const events = yield* Effect.acquireRelease(
        Queue.bounded<Adapter.ProviderAdapterV2Event, Adapter.ProviderAdapterV2Error>(256),
        Queue.shutdown,
      );
      const gate = yield* Semaphore.make(1);
      const controls = yield* Semaphore.make(1);
      const createdAt = yield* DateTime.now;
      const providerSession = {
        id: open.providerSessionId,
        driver,
        providerInstanceId: options.instanceId,
        status: "ready" as const,
        cwd: open.runtimePolicy.cwd!,
        model: open.modelSelection.model,
        capabilities,
        extensionStatuses: [] as Array<{ key: string; text: string }>,
        createdAt,
        updatedAt: createdAt,
        lastError: null,
      };
      let thread: OrchestrationV2ProviderThread | null = null;
      let snapshot: Session.Session | null = null;
      let active: ActiveTurn | null = null;
      let watcher: Fiber.Fiber<void, never> | null = null;
      let agentWatcher: Fiber.Fiber<void, never> | null = null;
      let appThread: OrchestrationV2AppThread | undefined;
      let agentSnapshot: Collection.Snapshot | undefined;
      let nativeConversation:
        | Effect.Success<ReturnType<typeof NativeConversation.make>>
        | undefined;
      const shownAgents = new Map<string, string>();
      const firstSeenAgents = new Map<string, DateTime.Utc>();
      const helperOutcomes = new Map<
        string,
        { readonly outcome: Outcome; readonly cursor: Session.Cursor }
      >();
      const helperOutcome = (native: typeof Session.SessionSummary.Type) => {
        const known = helperOutcomes.get(native.id);
        return native.status.phase === "idle" &&
          native.cursor !== null &&
          known?.cursor.generation === native.cursor.generation &&
          known.cursor.sequence >= native.cursor.sequence
          ? known.outcome
          : undefined;
      };
      const conversationWatchers = new Map<string, Fiber.Fiber<void, never>>();
      let cursor: Session.Cursor | undefined;
      const pendingHelpers = () => {
        const nativeId = thread?.nativeThreadRef?.nativeId;
        return agentSnapshot === undefined || nativeId == null
          ? []
          : Collection.owned(agentSnapshot, nativeId).filter(
              (helper) => !helper.closed && helperOutcome(helper) === undefined,
            );
      };
      const emit = (event: Adapter.ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);

      const watchConversation = Effect.fn("AlbedoAdapter.watchConversation")(
        function* (
          native: typeof Session.SessionSummary.Type,
          ownerThreadId: OrchestrationV2AppThread["id"],
        ) {
          const key = Symbol(native.id);
          yield* Effect.acquireRelease(
            Effect.gen(function* () {
              if (conversationSlots.size >= 64)
                return yield* failure(
                  "Albedo has more than 64 attached helper conversations. Their remaining state is unresolved; close an inactive T3 conversation before reconnecting.",
                );
              conversationSlots.set(key, 0);
            }),
            () =>
              Effect.sync(() => {
                conversationSlots.delete(key);
              }),
          );
          const identity = {
            driver,
            providerInstanceId: options.instanceId,
            nativeThreadId: native.id,
          };
          const view = yield* NativeConversation.make({
            nativeId: native.id,
            providerInstanceId: options.instanceId,
            threadId: ids.derive.subagentThread(identity),
            providerThreadId: ids.derive.providerThread(identity),
            ownerThreadId,
            ids: ids.derive,
            startedAt:
              native.created_at == null
                ? (firstSeenAgents.get(native.id) ?? createdAt)
                : DateTime.makeUnsafe(native.created_at),
          }).pipe(
            Effect.provideService(AlbedoClient, client),
            Effect.provideService(AlbedoNativeOutcomes, nativeOutcomes),
            Effect.provideService(FileSystem.FileSystem, fs),
          );
          yield* Effect.gen(function* () {
            const connection = yield* options.connect;
            const closed = (agentSnapshot?.get(native.id) ?? native).closed;
            const stream = connection.watchSession(native.id, view.cursor());
            yield* (closed ? stream.pipe(Stream.take(1)) : stream).pipe(
              Stream.runForEach(
                Effect.fn("AlbedoAdapter.publishNativeConversation")(function* (batch) {
                  const update = yield* view.accept(batch, connection);
                  conversationSlots.set(key, update.characters);
                  let retained = 0;
                  for (const characters of conversationSlots.values()) retained += characters;
                  if (retained > 64 * 1024 * 1024)
                    return yield* failure(
                      "Albedo helper conversations exceed T3's retained history limit. Their full history remains in Albedo.",
                    );
                  yield* Effect.gen(function* () {
                    const outcome = update.pending ? undefined : update.outcome;
                    const latest = agentSnapshot?.get(native.id);
                    const previous = latest === undefined ? undefined : helperOutcome(latest);
                    if (outcome === undefined) helperOutcomes.delete(native.id);
                    else helperOutcomes.set(native.id, { outcome, cursor: view.cursor()! });
                    if (
                      latest !== undefined &&
                      previous !== helperOutcome(latest) &&
                      agentSnapshot !== undefined
                    )
                      yield* projectAgents(agentSnapshot);
                  }).pipe(gate.withPermit);
                  for (const event of update.events) yield* emit(event);
                }),
              ),
            );
            if (!closed)
              return yield* failure(
                "Albedo's native helper stream ended; reconnecting to its existing conversation",
              );
          }).pipe(Effect.retry({ schedule: Schedule.spaced("1 second"), times: 3 }));
        },
        Effect.scoped,
        Effect.catch((cause) =>
          Queue.fail(
            events,
            failure("Albedo's native helper conversation could not be reconciled", cause),
          ).pipe(Effect.asVoid),
        ),
      );

      const projectAgents = Effect.fn("AlbedoAdapter.projectAgents")(function* (
        next: Collection.Snapshot,
      ): Effect.fn.Return<void> {
        agentSnapshot = next;
        const nativeId = thread?.nativeThreadRef?.nativeId;
        if (thread === null || nativeId == null) return;
        appThread ??= yield* open.readAppThread ?? Effect.undefined;
        if (appThread === undefined) return;
        const now = yield* DateTime.now;
        const changedIds = new Set<string>();
        const retained = new Set<string>();
        let removed = false;
        const owned = Collection.owned(next, nativeId);
        for (const native of owned) {
          retained.add(native.id);
          const outcome = helperOutcome(native);
          const key = NativeAgents.displayKey(native, outcome);
          if (shownAgents.get(native.id) === key) continue;
          changedIds.add(native.id);
          shownAgents.set(native.id, key);
          if (!firstSeenAgents.has(native.id)) firstSeenAgents.set(native.id, now);
        }
        for (const id of shownAgents.keys()) {
          if (!retained.has(id)) {
            removed = true;
            const conversation = conversationWatchers.get(id);
            if (conversation !== undefined) yield* Fiber.interrupt(conversation);
            conversationWatchers.delete(id);
            shownAgents.delete(id);
            firstSeenAgents.delete(id);
            helperOutcomes.delete(id);
          }
        }
        for (const event of changedIds.size === 0
          ? []
          : NativeAgents.project({
              appThread,
              providerThread: thread,
              snapshot: next,
              ids: ids.derive,
              now,
              changedIds,
              firstSeen: firstSeenAgents,
              outcomes: new Map(
                owned.flatMap((native) => {
                  const outcome = helperOutcome(native);
                  return outcome === undefined ? [] : [[native.id, outcome] as const];
                }),
              ),
            }))
          yield* emit(event);
        for (const native of owned) {
          if (
            native.model === null ||
            native.provider_profile === null ||
            conversationWatchers.has(native.id)
          )
            continue;
          conversationWatchers.set(
            native.id,
            yield* watchConversation(native, appThread.id).pipe(Effect.forkIn(scope)),
          );
        }
        if ((changedIds.size > 0 || removed) && snapshot !== null) yield* observe(snapshot);
      });

      const bindTools = Effect.fn("AlbedoAdapter.bindTools")(function* (nativeId: string) {
        const config = yield* mcpSessions.read(open.threadId);
        if (config === undefined) return undefined;
        if (config.threadId !== open.threadId || config.providerInstanceId !== options.instanceId)
          return yield* failure("Albedo's T3 tool identity belongs to another provider or thread");
        yield* McpBridge.bind(options.homeDirectory, nativeId, config).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
        return config;
      });

      const observe = Effect.fn("AlbedoAdapter.observe")(function* (native: Session.Session) {
        const now = yield* DateTime.now;
        const statuses = Observation.statuses(native, active !== null);
        if (
          statuses.length !== providerSession.extensionStatuses.length ||
          statuses.some(
            (status, index) =>
              status.key !== providerSession.extensionStatuses[index]?.key ||
              status.text !== providerSession.extensionStatuses[index]?.text,
          )
        ) {
          providerSession.extensionStatuses = statuses;
          providerSession.updatedAt = now;
          yield* emit({
            type: "provider_session.updated",
            driver,
            providerSession: { ...providerSession },
          });
        }
        if (thread !== null) {
          thread = {
            ...thread,
            pendingBackgroundTasks: [
              ...Observation.tasks(native),
              ...pendingHelpers().map((helper) => ({
                taskId: helper.id,
                kind: "subagent" as const,
                description: helper.role || `Native Albedo agent ${helper.id}`,
              })),
            ],
            contextUsage: Observation.context(native),
            updatedAt: now,
          };
          yield* emit({
            type: "provider_thread.updated",
            driver,
            providerThread: thread,
            sessionScoped: true,
            pendingBackgroundWork: Observation.pending(native) || pendingHelpers().length > 0,
          });
        }
      });

      const historyFor = Effect.fn("AlbedoAdapter.historyFor")(function* (
        sessionId: string,
        after = 0,
        through = Number.MAX_SAFE_INTEGER,
      ) {
        return yield* HistoryContent.readHistory(sessionId, after, through).pipe(
          Effect.provideService(AlbedoClient, client),
        );
      });

      const hydrate = Effect.fn("AlbedoAdapter.hydrate")(function* (
        turn: ActiveTurn,
        native: Session.Session,
      ) {
        const nativeRuns = nativeRunIds(turn);
        const positions = [...turn.inputs.values()].flatMap(({ decision }) =>
          decision?.transcript_position == null ? [] : [decision.transcript_position],
        );
        const history = yield* historyFor(
          native.id,
          Math.max(0, (positions.length === 0 ? 1 : Math.min(...positions)) - 1),
          native.history.high_water,
        );
        const content = yield* HistoryContent.makeReader(native.id).pipe(
          Effect.provideService(AlbedoClient, client),
        );
        const entries = yield* content.entries(
          history.filter((entry) => entry.turn_id !== null && nativeRuns.has(entry.turn_id)),
        );
        const staged = yield* ActiveOutput.stage(native).pipe(
          Effect.provideService(AlbedoClient, client),
          Effect.provideService(FileSystem.FileSystem, fs),
        );
        const outputs = yield* Effect.forEach(staged, ({ output, content }) =>
          Stream.runFold(
            content,
            () => "",
            (text, chunk) => text + chunk,
          ).pipe(Effect.map((text) => ({ output, text }))),
        );
        turn.projections.clear();
        for (const nativeRunId of nativeRuns) {
          turn.projections.set(
            nativeRunId,
            yield* Projection.restore(
              nativeRunId,
              entries,
              outputs,
              native.current_progress,
              native,
            ),
          );
        }
        yield* Projection.validateAll(turn.projections.values());
      }, Effect.scoped);

      const publish = Effect.fn("AlbedoAdapter.publish")(function* (turn: ActiveTurn) {
        const nativeRunId = turn.decision.turn?.id;
        for (const member of turn.inputs.values()) {
          if (member.messageId === turn.input.message.messageId) continue;
          const decision = member.decision;
          const status =
            decision === null ||
            (decision.admission === "accepted" && decision.delivery === "pending")
              ? "pending"
              : decision.admission === "rejected" || decision.delivery === "cancelled"
                ? "cancelled"
                : "completed";
          if (status === member.shownStatus) continue;
          member.shownStatus = status;
          yield* emit({
            type: "steer.updated",
            driver,
            threadId: turn.input.threadId,
            runId: turn.input.runId,
            messageId: member.messageId,
            status,
          });
        }
        const now = yield* DateTime.now;
        if (nativeRunId !== undefined && turn.turn.nativeTurnRef?.nativeId !== nativeRunId) {
          turn.turn = {
            ...turn.turn,
            nativeTurnRef: providerRef(nativeRunId),
            startedAt: DateTime.makeUnsafe(turn.decision.turn!.started_at),
          };
          yield* emit({
            type: "provider_turn.updated",
            driver,
            threadId: turn.input.threadId,
            providerTurn: turn.turn,
          });
        }
        yield* Projection.validateAll(turn.projections.values());
        for (const [nativeRunId, projection] of turn.projections)
          for (const row of Projection.render(
            projection,
            turn.input,
            turn.turn,
            nativeRunId,
            ids.derive,
            now,
          )) {
            const previous = turn.emitted.get(row.id);
            if (Projection.unchanged(previous, row)) continue;
            turn.emitted.set(row.id, row);
            if (row.type === "assistant_message")
              yield* emit({
                type: "message.updated",
                driver,
                message: {
                  id: row.messageId,
                  threadId: row.threadId,
                  runId: row.runId,
                  nodeId: row.nodeId,
                  role: "assistant",
                  text: row.text,
                  attachments: [],
                  streaming: row.streaming,
                  createdAt: row.startedAt ?? now,
                  updatedAt: now,
                  createdBy: "agent",
                  creationSource: "provider",
                },
              });
            yield* emit({ type: "turn_item.updated", driver, turnItem: row });
          }
      });

      const settle = Effect.fn("AlbedoAdapter.settle")(function* (turn: ActiveTurn) {
        const decisions: Protocol.Input[] = [];
        for (const member of turn.inputs.values()) {
          const decision = member.decision;
          if (
            decision === null ||
            (decision.admission === "accepted" &&
              decision.delivery !== "cancelled" &&
              (decision.turn === null || decision.turn.state === "running"))
          )
            return;
          decisions.push(decision);
        }
        const decision =
          decisions.find(
            (input) =>
              input.admission === "rejected" ||
              input.turn?.state === "failed" ||
              input.turn?.state === "abandoned",
          ) ??
          decisions.find((input) => input.turn?.state === "interrupted") ??
          decisions.find((input) => input.delivery === "cancelled") ??
          turn.decision;
        const now = yield* DateTime.now;
        const state =
          decision.admission === "rejected"
            ? "failed"
            : decision.delivery === "cancelled"
              ? "cancelled"
              : decision.turn!.state;
        const status = state === "abandoned" ? "failed" : state;
        if (status === "running") return;
        if (decision.turn !== null) {
          snapshot = yield* client.readSession(turn.submission.sessionId);
          yield* observe(snapshot);
          yield* hydrate(turn, snapshot);
          yield* publish(turn);
        }
        for (const row of turn.emitted.values()) {
          if (row.status !== "running") continue;
          const ended = {
            ...row,
            status: status === "failed" ? ("failed" as const) : ("interrupted" as const),
            completedAt: now,
            updatedAt: now,
          };
          const item =
            ended.type === "assistant_message" || ended.type === "reasoning"
              ? { ...ended, streaming: false }
              : ended;
          if (item.type === "assistant_message")
            yield* emit({
              type: "message.updated",
              driver,
              message: {
                id: item.messageId,
                threadId: item.threadId,
                runId: item.runId,
                nodeId: item.nodeId,
                role: "assistant",
                text: item.text,
                attachments: [],
                streaming: false,
                createdAt: item.startedAt ?? now,
                updatedAt: now,
                createdBy: "agent",
                creationSource: "provider",
              },
            });
          yield* emit({ type: "turn_item.updated", driver, turnItem: item });
        }
        turn.turn = { ...turn.turn, status, completedAt: now };
        yield* emit({
          type: "provider_turn.updated",
          driver,
          threadId: turn.input.threadId,
          providerTurn: turn.turn,
        });
        if (status === "failed")
          yield* emit({
            type: "turn.terminal",
            driver,
            providerThreadId: turn.input.providerThread.id,
            providerTurnId: turn.turn.id,
            runOrdinal: turn.input.runOrdinal,
            failureItemOrdinal: turn.emitted.size + 1,
            status,
            threadDisposition: "reusable",
            failure: {
              class: "provider_error",
              code: decision.admission === "rejected" ? decision.problem.code : state,
              message:
                decision.admission === "rejected"
                  ? decision.problem.detail
                  : (decision.turn?.outcome?.detail ?? `Albedo reported ${state} work.`),
              retryable: false,
            },
          });
        else
          yield* emit({
            type: "turn.terminal",
            driver,
            providerThreadId: turn.input.providerThread.id,
            providerTurnId: turn.turn.id,
            runOrdinal: turn.input.runOrdinal,
            status,
            failure: null,
            threadDisposition: "reusable",
          });
        if (active === turn) active = null;
        yield* Deferred.succeed(turn.done, undefined);
      });

      const process = Effect.fn("AlbedoAdapter.process")(function* (
        sessionId: string,
        batch: Session.Batch,
      ) {
        const delivery = yield* Replay.prepare(sessionId, cursor, batch);
        let observationChanged = delivery.snapshot !== undefined;
        if (delivery.snapshot !== undefined) snapshot = delivery.snapshot;
        for (const event of delivery.events) {
          if (snapshot === null) break;
          if (event.type === "kernel") {
            snapshot = { ...snapshot, kernel: event.data.kernel };
            observationChanged = true;
          }
          if (event.type === "usage") {
            snapshot = { ...snapshot, usage: event.data };
            observationChanged = true;
          }
          if (event.type === "status") {
            snapshot = { ...snapshot, status: event.data };
            observationChanged = true;
          }
        }
        if (observationChanged && snapshot !== null) yield* observe(snapshot);
        const turn = active;
        if (turn !== null) {
          if (delivery.snapshot !== undefined) {
            for (const member of turn.inputs.values()) {
              const decision = yield* client.readInput(member.submission);
              if (decision === null)
                return yield* failure(
                  "Albedo no longer reports an accepted input; its outcome is unresolved",
                );
              updateInput(turn, decision);
            }
            yield* hydrate(turn, delivery.snapshot);
          }
          for (const event of delivery.events)
            if (event.type === "input") updateInput(turn, event.data.input);
          if (
            delivery.events.some(
              (event) =>
                event.type === "turn_completed" && nativeRunIds(turn).has(event.data.run_id),
            )
          ) {
            for (const member of turn.inputs.values()) {
              const decision = yield* client.readInput(member.submission);
              if (decision === null)
                return yield* failure(
                  "Albedo no longer reports an accepted input; its outcome is unresolved",
                );
              updateInput(turn, decision);
            }
          }
          const content = yield* HistoryContent.makeReader(sessionId).pipe(
            Effect.provideService(AlbedoClient, client),
          );
          const expanded = yield* content.events(delivery.events);
          for (const nativeRunId of nativeRunIds(turn)) {
            turn.projections.set(
              nativeRunId,
              yield* Projection.reduce(
                turn.projections.get(nativeRunId) ?? Projection.empty(),
                nativeRunId,
                expanded,
                delivery.cursor,
              ),
            );
          }
          yield* publish(turn);
          yield* settle(turn);
        }
        if (nativeConversation !== undefined) {
          const update = yield* nativeConversation.accept(batch, client);
          for (const event of update.events) yield* emit(event);
        }
        cursor = delivery.cursor;
      }, gate.withPermit);

      const watch = Effect.fn("AlbedoAdapter.watch")(
        function* (sessionId: string) {
          client = yield* options.connect;
          yield* client
            .watchSession(sessionId, cursor)
            .pipe(Stream.runForEach((batch) => process(sessionId, batch)));
          return yield* failure("Albedo's session stream ended; reconnecting to the existing work");
        },
        Effect.retry({ schedule: Schedule.spaced("1 second"), times: 3 }),
        Effect.catch((cause) =>
          Queue.fail(
            events,
            failure(
              "Albedo's session stream is unavailable. Reconnect to recover existing work",
              cause,
            ),
          ).pipe(Effect.asVoid),
        ),
      );

      const ensure = Effect.fn("AlbedoAdapter.ensureThread")(
        function* (input: Adapter.ProviderAdapterV2EnsureThreadInput) {
          yield* validatePolicy(input.runtimePolicy);
          if (active !== null || input.forceNewNativeThread === true)
            return yield* failure(
              "The persistent Albedo session cannot be replaced while attached",
            );
          const providerThreadId =
            input.existingProviderThread?.id ??
            ids.derive.providerThread({
              driver,
              providerInstanceId: options.instanceId,
              nativeThreadId: input.threadId,
            });
          const key = { providerInstanceId: options.instanceId, providerThreadId };
          const existing = yield* sessions.get(key);
          if (existing !== null && existing.daemonHome !== options.homeDirectory)
            return yield* failure(
              "This conversation belongs to another Albedo home. Reconnect to its original daemon",
            );
          const selected =
            existing === null
              ? yield* Models.resolve(input.modelSelection).pipe(
                  Effect.provideService(AlbedoClient, client),
                )
              : null;
          const binding =
            existing ??
            (yield* sessions.prepare({
              ...key,
              daemonHome: options.homeDirectory,
              request: {
                kind: "new",
                workspace: input.runtimePolicy.cwd!,
                name: input.title ?? null,
                provider_profile: selected!.profile,
                model: selected!.model,
                effort: selected!.effort,
              },
            }));
          if (
            input.existingProviderThread?.nativeThreadRef?.nativeId !== undefined &&
            input.existingProviderThread.nativeThreadRef.nativeId !== binding.creation.sessionId
          )
            return yield* failure("The saved Albedo session does not match this provider thread");
          yield* client.createSession(binding.creation);
          const native = yield* client.readSession(binding.creation.sessionId);
          if (native.workspace !== input.runtimePolicy.cwd)
            return yield* failure(
              "Albedo's workspace differs from the requested workspace. Rebind it before executing this assignment",
            );
          yield* bindTools(native.id);
          const now = yield* DateTime.now;
          thread = {
            ...(input.existingProviderThread ?? {
              id: providerThreadId,
              driver,
              providerInstanceId: options.instanceId,
              appThreadId: input.threadId,
              ownerNodeId: null,
              nativeConversationHeadRef: null,
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
            }),
            providerSessionId: open.providerSessionId,
            nativeThreadRef: providerRef(native.id),
            status: "idle",
            updatedAt: now,
          };
          snapshot = native;
          yield* observe(native);
          if (watcher !== null) yield* Fiber.interrupt(watcher);
          cursor = undefined;
          nativeConversation = yield* NativeConversation.make({
            nativeId: native.id,
            providerInstanceId: options.instanceId,
            threadId: input.threadId,
            ownerThreadId: input.threadId,
            providerThreadId: thread.id,
            ids: ids.derive,
            startedAt: thread.createdAt,
            autonomousOnly: true,
          }).pipe(
            Effect.provideService(AlbedoClient, client),
            Effect.provideService(AlbedoNativeOutcomes, nativeOutcomes),
            Effect.provideService(FileSystem.FileSystem, fs),
          );
          watcher = yield* watch(native.id).pipe(Effect.forkIn(scope));
          if (agentWatcher === null) {
            agentWatcher = yield* (yield* collection).pipe(
              Stream.runForEach((next) => projectAgents(next).pipe(gate.withPermit)),
              Effect.catch((cause) =>
                Queue.fail(
                  events,
                  failure(
                    "Albedo's native agent graph is unavailable; reconnect to reconcile it",
                    cause,
                  ),
                ).pipe(Effect.asVoid),
              ),
              Effect.forkIn(scope),
            );
          }
          yield* emit({ type: "provider_thread.updated", driver, providerThread: thread });
          return thread;
        },
        gate.withPermit,
        controls.withPermit,
        Effect.mapError(wrap),
      );

      const compact = Effect.fn("AlbedoAdapter.compactThread")(function* (
        input: Adapter.ProviderAdapterV2TurnInput,
        nativeId: string,
      ) {
        const key = {
          providerInstanceId: options.instanceId,
          runId: input.runId,
          messageId: input.message.messageId,
          sessionId: nativeId,
        };
        const unresolved = (cause: unknown) =>
          new Adapter.ProviderAdapterTurnStartError({
            driver,
            threadId: input.threadId,
            providerThreadId: input.providerThread.id,
            runId: input.runId,
            outcomeUnresolved: true,
            cause,
          });
        const claim = yield* compactions.claim(key);
        let outcome = claim.outcome;
        if (outcome === null) {
          const { actionId } = claim;
          if (actionId === null)
            return yield* unresolved(
              failure(
                "This compaction was started before Albedo offered durable receipts. Its effects are unknown; inspect the native session before requesting another compaction.",
              ),
            );

          const read = client.readCompaction(nativeId, actionId).pipe(Effect.mapError(unresolved));
          const put = client.compactSession(nativeId, actionId);
          const submit = put.pipe(
            Effect.catchIf(
              (cause) => cause._tag !== "AlbedoHttpError" || cause.status >= 500,
              () =>
                read.pipe(
                  Effect.flatMap((known) =>
                    known === null ? put.pipe(Effect.mapError(unresolved)) : Effect.succeed(known),
                  ),
                ),
            ),
            Effect.mapError((cause) =>
              cause._tag === "AlbedoHttpError" && cause.status === 410 ? unresolved(cause) : cause,
            ),
          );
          outcome = yield* Effect.gen(function* () {
            const existing = claim.dispatch ? null : yield* read;
            let receipt = existing ?? (yield* submit);
            for (let delay = 200; receipt.state === "running"; delay = Math.min(delay * 2, 2_000)) {
              yield* Effect.sleep(delay);
              const updated = yield* read;
              if (updated === null)
                return yield* unresolved(
                  failure("Albedo's accepted compaction receipt disappeared."),
                );
              receipt = updated;
            }
            return receipt.state === "completed" ? receipt.result : ("interrupted" as const);
          }).pipe(
            Effect.timeout("200 seconds"),
            Effect.catchTags({
              TimeoutError: (cause) => Effect.fail(unresolved(cause)),
            }),
          );
          yield* compactions
            .complete({ ...key, actionId }, outcome)
            .pipe(Effect.mapError(unresolved));
        }
        snapshot = yield* client.readSession(nativeId).pipe(Effect.mapError(unresolved));
        yield* observe(snapshot);
        const now = yield* DateTime.now;
        const result = outcome === "interrupted" ? null : outcome;
        const compactionFailure =
          result === null
            ? {
                code: "compaction_interrupted",
                detail:
                  "Albedo interrupted compaction. Context or strategy changes may already have been applied. Inspect the session before requesting another compaction.",
              }
            : result.failure;
        const status = result === null || result.state === "failed" ? "failed" : "completed";
        const identity = `${input.providerThread.id}/compaction/${input.runId}`;
        const providerTurnId = ids.derive.providerTurn({ driver, nativeTurnId: identity });
        const observation = result?.observation;
        yield* emit({
          type: "provider_turn.updated",
          driver,
          threadId: input.threadId,
          providerTurn: {
            id: providerTurnId,
            providerThreadId: input.providerThread.id,
            nodeId: input.rootNodeId,
            runAttemptId: input.attemptId,
            nativeTurnRef: null,
            ordinal: input.providerTurnOrdinal,
            status,
            startedAt: now,
            completedAt: now,
          },
        });
        yield* emit({
          type: "turn_item.updated",
          driver,
          turnItem: {
            id: ids.derive.turnItemFromProviderItem({ driver, nativeItemId: identity }),
            threadId: input.threadId,
            runId: input.runId,
            nodeId: input.rootNodeId,
            providerThreadId: input.providerThread.id,
            providerTurnId,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            type: "compaction",
            driver,
            title: null,
            status,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            summary:
              observation?.summary ??
              (result?.state === "unchanged"
                ? "Albedo left the context unchanged."
                : (compactionFailure?.detail ??
                  (result?.state === "compacted"
                    ? "Albedo compacted the session context."
                    : "Albedo could not compact this session."))),
            ...(observation?.before_tokens == null
              ? {}
              : { beforeTokenCount: observation.before_tokens }),
            ...(observation?.after_tokens == null
              ? {}
              : { afterTokenCount: observation.after_tokens }),
          },
        });
        yield* emit({
          type: "turn.terminal",
          driver,
          providerThreadId: input.providerThread.id,
          providerTurnId,
          runOrdinal: input.runOrdinal,
          threadDisposition: "reusable",
          ...(status === "failed"
            ? {
                status,
                failureItemOrdinal: 2,
                failure: {
                  class: "provider_error",
                  code: compactionFailure?.code ?? "compaction_failed",
                  message: compactionFailure?.detail ?? "Albedo could not compact this session.",
                  retryable: false,
                },
              }
            : { status, failure: null }),
        });
      });

      const start = Effect.fn("AlbedoAdapter.startTurn")(
        function* (
          input: Adapter.ProviderAdapterV2TurnInput,
          unsubmittedMessage?: Adapter.ProviderAdapterV2ResumeTurnInput["unsubmittedMessage"],
          compactRequested = false,
        ) {
          yield* validatePolicy(input.runtimePolicy);
          if (active !== null) return yield* failure("Albedo already has an active T3 turn");
          const nativeId = thread?.nativeThreadRef?.nativeId;
          if (thread === null || thread.id !== input.providerThread.id || nativeId == null)
            return yield* failure("Albedo's native session is not bound to this thread");
          appThread = input.appThread;
          if (agentSnapshot !== undefined) yield* projectAgents(agentSnapshot);
          const key = {
            providerInstanceId: options.instanceId,
            runId: input.runId,
            messageId: input.message.messageId,
          };
          const stored = yield* inputs.get(key);
          const compaction = yield* compactions.read(key);
          if (
            input.resume &&
            stored === null &&
            compaction === null &&
            unsubmittedMessage === undefined
          )
            return yield* failure("This Albedo turn has no persisted input identity to recover");
          const native = yield* client.readSession(nativeId);
          if (native.workspace !== input.runtimePolicy.cwd)
            return yield* failure("Albedo's workspace changed; no input was sent");
          if (stored === null && compaction === null && native.status.phase !== "idle")
            return yield* failure(
              "Albedo has native work in progress. Recover that work before starting another T3 turn",
            );
          if (stored === null && compaction === null && unsubmittedMessage !== undefined) {
            const message = yield* unsubmittedMessage;
            if (message.messageId !== input.message.messageId)
              return yield* failure("The recovered message does not match this Albedo input");
            input = { ...input, message };
          }
          if (
            compaction !== null ||
            compactRequested ||
            isCompactionCommandMessage({ ...input.message, role: "user" })
          ) {
            if (stored !== null)
              return yield* failure("This Albedo run already owns a native message input");
            return yield* compact(input, nativeId);
          }
          const tools = yield* bindTools(nativeId);
          if (stored === null) {
            const selected = yield* Models.resolve(input.modelSelection).pipe(
              Effect.provideService(AlbedoClient, client),
            );
            yield* client.configureSession(nativeId, {
              provider_profile: selected.profile,
              model: selected.model,
              effort: selected.effort,
            });
          }
          const request =
            input.resume && stored !== null
              ? stored.request
              : yield* Attachments.message(
                  promptWithInstructions(
                    [
                      ...(input.appContext?.map((entry) => entry.text) ?? []),
                      input.message.text,
                    ].join("\n\n"),
                    tools,
                  ),
                  input.message.attachments,
                ).pipe(
                  Effect.provideService(ProviderHost, host),
                  Effect.provideService(FileSystem.FileSystem, fs),
                );
          const submission = yield* inputs.prepare({ ...key, sessionId: nativeId, request });
          yield* Effect.gen(function* () {
            const members = yield* inputs.listRun(key);
            if (members.some((member) => member.sessionId !== nativeId))
              return yield* failure("Stored Albedo inputs belong to another native session");
            const recovered = new Map<string, ActiveInput>();
            for (const { messageId, ...member } of members)
              recovered.set(member.inputId, {
                submission: member,
                messageId: MessageId.make(messageId),
                decision: (yield* client.readInput(member)) ?? (yield* client.submitInput(member)),
              });
            const decision = recovered.get(submission.inputId)!.decision!;
            const now = yield* DateTime.now;
            const turn: ActiveTurn = {
              input,
              submission,
              decision,
              done: yield* Deferred.make<void>(),
              inputs: recovered,
              projections: new Map(),
              emitted: new Map(),
              turn: {
                id: ids.derive.providerTurn({
                  driver,
                  nativeTurnId: `${input.providerThread.id}/input/${submission.inputId}`,
                }),
                providerThreadId: input.providerThread.id,
                nodeId: input.rootNodeId,
                runAttemptId: input.attemptId,
                nativeTurnRef: decision.turn === null ? null : providerRef(decision.turn.id),
                ordinal: input.providerTurnOrdinal,
                status: "running",
                startedAt: now,
                completedAt: null,
              },
            };
            active = turn;
            yield* emit({
              type: "provider_turn.updated",
              driver,
              threadId: input.threadId,
              providerTurn: turn.turn,
            });
            snapshot = yield* client.readSession(nativeId);
            yield* hydrate(turn, snapshot);
            yield* publish(turn);
            yield* settle(turn);
          }).pipe(
            Effect.mapError(
              (cause) =>
                new Adapter.ProviderAdapterTurnStartError({
                  driver,
                  threadId: input.threadId,
                  providerThreadId: input.providerThread.id,
                  runId: input.runId,
                  outcomeUnresolved: true,
                  cause,
                }),
            ),
          );
        },
        gate.withPermit,
        controls.withPermit,
        Effect.mapError(wrap),
      );

      const stopScope = Effect.fn("AlbedoAdapter.stopScope")(function* (
        providerThread: OrchestrationV2ProviderThread,
      ) {
        const nativeId = thread?.nativeThreadRef?.nativeId;
        if (thread?.id !== providerThread.id || nativeId == null)
          return yield* failure("No matching native session is bound for Stop");
        const stopped = yield* ScopeStop.stop(client, nativeId).pipe(Effect.mapError(wrap));
        yield* Effect.gen(function* () {
          snapshot = stopped;
          yield* projectAgents(yield* Collection.readSnapshot(client));
          yield* observe(stopped);
          if (active !== null) {
            for (const member of active.inputs.values()) {
              const decision = yield* client.readInput(member.submission);
              if (decision !== null) updateInput(active, decision);
            }
            yield* publish(active);
            yield* settle(active);
          }
        }).pipe(gate.withPermit, Effect.mapError(wrap));
      });

      const runtime: Adapter.ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver,
        providerSessionId: open.providerSessionId,
        providerSession,
        canResumeAfterRestart: true,
        events: Stream.fromQueue(events),
        hasPendingBackgroundWork: Effect.sync(
          () =>
            active !== null ||
            pendingHelpers().length > 0 ||
            (snapshot !== null && Observation.pending(snapshot)),
        ).pipe(gate.withPermit),
        ensureThread: ensure,
        resumeThread: (input) =>
          ensure({
            threadId: input.threadId ?? input.providerThread.appThreadId ?? open.threadId,
            existingProviderThread: input.providerThread,
            modelSelection: input.modelSelection ?? open.modelSelection,
            runtimePolicy: input.runtimePolicy ?? open.runtimePolicy,
          }),
        startTurn: start,
        compactThread: (input) => start(input, undefined, true),
        resumeTurn: (input) => start(Adapter.resumeTurnInput(input), input.unsubmittedMessage),
        steerTurn: Effect.fn("AlbedoAdapter.steerTurn")(
          function* (input) {
            const declined = () =>
              new Adapter.ProviderAdapterSteerDeclinedError({
                driver,
                providerThreadId: input.providerThread.id,
                providerTurnId: input.providerTurnId,
              });
            const key = {
              providerInstanceId: options.instanceId,
              runId: input.runId,
              messageId: input.message.messageId,
            };
            const stored = yield* inputs.get(key);
            const turn = active;
            const nativeId = thread?.nativeThreadRef?.nativeId;
            if (stored !== null && stored.sessionId !== nativeId)
              return yield* failure("The steering input belongs to another native session");
            if (
              turn === null ||
              turn.input.runId !== input.runId ||
              turn.input.threadId !== input.threadId ||
              turn.turn.id !== input.providerTurnId ||
              thread?.id !== input.providerThread.id ||
              nativeId == null
            ) {
              if (stored === null) return yield* declined();
              const decision = yield* client.readInput(stored);
              if (decision === null)
                return yield* failure(
                  "The existing steering input is unresolved; recover its original run",
                );
              if (decision.admission === "rejected") return yield* declined();
              return;
            }
            if (
              stored === null &&
              input.modelSelection !== undefined &&
              !modelSelectionsEqual(input.modelSelection, turn.input.modelSelection)
            )
              return yield* declined();
            if (stored === null) {
              const native = yield* client.readSession(nativeId);
              if (native.workspace !== turn.input.runtimePolicy.cwd)
                return yield* failure("Albedo's workspace changed; no steering input was sent");
              if (
                native.closed ||
                native.status.interrupt_requested ||
                native.status.phase === "interrupting"
              )
                return yield* declined();
            }
            const request =
              stored?.request ??
              (yield* Attachments.message(input.message.text, input.message.attachments).pipe(
                Effect.provideService(ProviderHost, host),
                Effect.provideService(FileSystem.FileSystem, fs),
              ));
            const submission =
              stored ?? (yield* inputs.prepare({ ...key, sessionId: nativeId, request }));
            if (!turn.inputs.has(submission.inputId))
              turn.inputs.set(submission.inputId, {
                submission,
                messageId: input.message.messageId,
                decision: null,
              });
            yield* publish(turn);
            const decision =
              (yield* client.readInput(submission)) ?? (yield* client.submitInput(submission));
            updateInput(turn, decision);
            snapshot = yield* client.readSession(nativeId);
            yield* hydrate(turn, snapshot);
            yield* publish(turn);
            if (decision.admission === "rejected") {
              turn.inputs.delete(submission.inputId);
              return yield* declined();
            }
            yield* settle(turn);
          },
          gate.withPermit,
          controls.withPermit,
          Effect.mapError(wrap),
        ),
        stopThread: (input) => stopScope(input.providerThread).pipe(controls.withPermit),
        interruptTurn: Effect.fn("AlbedoAdapter.interruptTurn")(function* (input) {
          const turn = active;
          if (
            (turn === null && !input.requestRuntimeRestart) ||
            (turn !== null && turn.turn.id !== input.providerTurnId) ||
            thread?.id !== input.providerThread.id
          )
            return yield* failure("No matching Albedo turn is active");
          if (turn !== null) {
            yield* Effect.gen(function* () {
              for (const member of turn.inputs.values()) {
                const cancellation = yield* client.cancelInput(member.submission);
                updateInput(turn, cancellation.input);
                if (
                  cancellation.result === "shared_running" &&
                  cancellation.input.admission === "accepted"
                ) {
                  yield* client.interruptSession(turn.submission.sessionId, {
                    run_id: cancellation.input.turn?.id ?? null,
                    through_input_order: cancellation.input.acceptance_order,
                  });
                }
              }
              yield* publish(turn);
              yield* settle(turn);
            }).pipe(gate.withPermit, Effect.mapError(wrap));
            yield* Deferred.await(turn.done).pipe(
              Effect.timeoutOrElse({
                duration: "15 seconds",
                orElse: () =>
                  Effect.fail(
                    new Adapter.ProviderAdapterInterruptTimeoutError({
                      driver,
                      providerThreadId: input.providerThread.id,
                      providerTurnId: input.providerTurnId,
                      timeoutMs: 15000,
                    }),
                  ),
              }),
            );
          }
          if (input.requestRuntimeRestart) {
            yield* stopScope(input.providerThread);
          }
        }, controls.withPermit),
        readThreadSnapshot: Effect.fn("AlbedoAdapter.readThreadSnapshot")(function* (input) {
          const nativeId = input.providerThread.nativeThreadRef?.nativeId;
          if (nativeId == null)
            return yield* failure("This Albedo thread has no native session identity");
          const content = yield* HistoryContent.makeReader(nativeId).pipe(
            Effect.provideService(AlbedoClient, client),
          );
          const entries = yield* content.entries(yield* historyFor(nativeId));
          const now = yield* DateTime.now;
          return {
            providerThread: input.providerThread,
            providerTurns: [],
            runtimeRequests: [],
            messages: entries
              .filter((entry) => entry.kind === "user" || entry.kind === "assistant")
              .map((entry) => ({
                id: ids.derive.messageFromProviderItem({
                  driver,
                  nativeItemId: `${input.providerThread.id}/history/${entry.id}`,
                }),
                threadId: input.providerThread.appThreadId ?? open.threadId,
                runId: null,
                nodeId: null,
                role: entry.kind === "user" ? ("user" as const) : ("assistant" as const),
                text: entry.content
                  .flatMap((part) => (part.kind === "text" ? [part.text] : []))
                  .join(""),
                attachments: [],
                streaming: false,
                createdAt: entry.created_at === null ? now : DateTime.makeUnsafe(entry.created_at),
                updatedAt: now,
                createdBy: entry.kind === "user" ? ("user" as const) : ("agent" as const),
                creationSource: "provider" as const,
              })),
          };
        }, Effect.mapError(wrap)),
        rollbackThread: () =>
          Effect.fail(failure("Albedo conversation rollback is unsupported; no state was changed")),
        forkThread: () =>
          Effect.fail(failure("Albedo native forking is unsupported; no state was changed")),
        respondToRuntimeRequest: () =>
          Effect.fail(failure("Albedo exposes no T3 runtime approval requests")),
      };
      return runtime;
    }),
  });
});
