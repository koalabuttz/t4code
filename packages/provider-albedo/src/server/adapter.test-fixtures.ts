// @effect-diagnostics effectFnOpportunity:off -- These callbacks script a test daemon, not reusable services.
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import type { ProviderAdapterV2TurnInput } from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AlbedoClient, AlbedoTransportError } from "./AlbedoClient.ts";
import * as Protocol from "./protocol.ts";
import type * as Session from "./sessionProtocol.ts";
import { generation, session } from "./session.test-fixtures.ts";

const decodeSubmission = Schema.decodeEffect(Protocol.Submission);

export const instanceId = ProviderInstanceId.make("albedo-test");
export const threadId = ThreadId.make("thread-albedo-test");
export const providerSessionId = ProviderSessionId.make("session-albedo-test");
export const selection = { instanceId, model: "fixture/fixture-model" };
export const policy = {
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
} as const;
export const at = DateTime.makeUnsafe("2026-11-16T12:00:00Z");
export const nativeRunId = "native-run-1";

export function turnInput(
  providerThread: OrchestrationV2ProviderThread,
): ProviderAdapterV2TurnInput {
  return {
    appThread: {
      id: threadId,
      projectId: ProjectId.make("albedo-project"),
      title: "Albedo test",
      providerInstanceId: instanceId,
      modelSelection: selection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
      createdBy: "user",
      creationSource: "web",
    },
    threadId,
    runId: RunId.make("run-albedo-test"),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make("attempt-albedo-test"),
    rootNodeId: NodeId.make("node-albedo-test"),
    providerThread,
    modelSelection: selection,
    runtimePolicy: policy,
    message: {
      messageId: MessageId.make("message-albedo-test"),
      text: "Keep Python state.",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
  };
}

export const fakeDaemon = Effect.gen(function* () {
  const queue = yield* Effect.acquireRelease(Queue.unbounded<Session.Batch>(), Queue.shutdown);
  const collectionQueue = yield* Effect.acquireRelease(
    Queue.unbounded<Session.CollectionBatch>(),
    Queue.shutdown,
  );
  const helpers = new Map<string, Session.Session>();
  const helperQueues = yield* Effect.acquireRelease(
    Effect.sync(() => new Map<string, Queue.Queue<Session.Batch, Cause.Done>>()),
    (queues) => Effect.forEach(queues.values(), Queue.shutdown),
  );
  const helperQueue = Effect.fn("FakeAlbedo.helperQueue")(function* (id: string) {
    const existing = helperQueues.get(id);
    if (existing !== undefined) return existing;
    const created = yield* Queue.unbounded<Session.Batch, Cause.Done>();
    helperQueues.set(id, created);
    return created;
  });
  let collectionSubscriptions = 0;
  const interrupted = yield* Deferred.make<void>();
  const watching = yield* Deferred.make<void>();
  let native = session();
  let decision: Protocol.Input | null = null;
  const decisions = new Map<string, Protocol.Input>();
  let loseInputReply = false;
  let sequence = 0;
  const submissions: Protocol.Submission[] = [];
  const creations: Protocol.SessionCreation[] = [];
  const configurations: Array<typeof Protocol.SessionSelection.Type> = [];
  const compactions: string[] = [];
  let compactionResult: typeof Protocol.CompactionResult.Type = {
    selection_applied: true,
    effective_strategy: "summary",
    state: "compacted",
    observation: {
      strategy: "summary",
      before_tokens: 12000,
      after_tokens: 3000,
      evicted_entries: 8,
      summary: "Retained Python variables and the working plan.",
    },
    failure: null,
  };
  let loseCompactionReply = false;
  const send = Effect.fn("FakeAlbedo.send")(function* (values: ReadonlyArray<Session.Event>) {
    const events = values.map((event) => ({ ...event, sequence: ++sequence }));
    native = { ...native, cursor: { generation, sequence } };
    for (const event of events) {
      if (event.type === "input") {
        decision = event.data.input;
        decisions.set(decision.id, decision);
      }
      if (event.type === "status") native = { ...native, status: event.data };
      if (event.type === "message")
        native = {
          ...native,
          history: {
            ...native.history,
            items: [...native.history.items, event.data.entry],
            high_water: event.data.entry.position,
          },
        };
    }
    yield* Queue.offer(queue, { generation, cursor: sequence, events });
  });
  const client = AlbedoClient.of({
    compactSession: (id) =>
      Effect.suspend(() => {
        compactions.push(id);
        return loseCompactionReply
          ? Effect.fail(
              new AlbedoTransportError({
                operation: "session.compact",
                cause: "Response lost after compaction",
              }),
            )
          : Effect.succeed(compactionResult);
      }),
    server: {
      instance_id: "daemon-test",
      protocol: 3,
      state: "ready",
      capabilities: {
        durable_inputs: 1,
        session_replay: 2,
        collection_invalidation: 1,
        tool_progress: 1,
      },
      build: null,
      digest: null,
      extensions: [],
      quota: null,
      notices: [],
    },
    readProviderSettings: Effect.succeed({
      default_profile: "fixture",
      profiles: {
        fixture: { extension: "openai", model: "fixture-model", effort: null, has_key: true },
      },
    }),
    readModels: () =>
      Effect.succeed({
        items: [
          {
            id: "fixture-model",
            label: "Fixture",
            efforts: [{ id: "high", label: "High" }],
            effective_context_tokens: 100000,
            max_context_tokens: 100000,
            max_output_tokens: 10000,
            input_modalities: ["text", "image"],
          },
        ],
        next: null,
      }),
    createSession: (creation) =>
      Effect.sync(() => {
        creations.push(creation);
        native = {
          ...native,
          id: creation.sessionId,
          root_id: creation.sessionId,
          workspace: creation.request.workspace,
          creation: { submitted: creation.request },
        };
        return native;
      }),
    readSession: (id) => Effect.sync(() => helpers.get(id) ?? native),
    closeAgent: (id) =>
      Effect.sync(() => {
        const helper = helpers.get(id);
        if (helper === undefined) throw new Error("No fixture helper to close");
        const closed = {
          ...helper,
          closed: true,
          status: session().status,
          kernel: session().kernel,
        };
        helpers.set(id, closed);
        return closed;
      }),
    stopJob: () => Effect.die("Fixture has no native jobs to stop"),
    readSessions: () => Effect.sync(() => ({ items: [native, ...helpers.values()], next: null })),
    watchSessions: () =>
      Stream.fromEffect(
        Effect.sync(() => {
          collectionSubscriptions++;
          return {
            events: [
              { type: "ready", data: {} },
              { type: "reset", data: { reason: "initial" } },
            ],
          } satisfies Session.CollectionBatch;
        }),
      ).pipe(Stream.concat(Stream.fromQueue(collectionQueue))),
    readHistory: (id) => Effect.sync(() => (helpers.get(id) ?? native).history),
    readActiveContent: () => Effect.die("Fixture has no spilled output"),
    readHistoryContent: () => Effect.die("Fixture has no referenced history"),
    configureSession: (_id, choice) =>
      Effect.sync(() => {
        configurations.push(choice);
        native = { ...native, ...choice };
      }),
    watchSession: (id) =>
      id !== native.id && helpers.has(id)
        ? Stream.unwrap(
            helperQueue(id).pipe(
              Effect.map((events) =>
                Stream.succeed({
                  generation,
                  cursor: helpers.get(id)!.cursor?.sequence ?? 0,
                  snapshot: helpers.get(id)!,
                  events: [{ type: "reset", data: { reason: "initial" } }],
                } satisfies Session.Batch).pipe(Stream.concat(Stream.fromQueue(events))),
              ),
            ),
          )
        : Stream.fromEffect(
            Effect.sync(() => ({
              generation,
              cursor: sequence,
              snapshot: native,
              events: [{ type: "reset" as const, data: { reason: "initial" as const } }],
            })).pipe(Effect.tap(() => Deferred.succeed(watching, undefined))),
          ).pipe(Stream.concat(Stream.fromQueue(queue))),
    readInput: ({ inputId }) => Effect.sync(() => decisions.get(inputId) ?? null),
    submitInput: (submission) =>
      decodeSubmission(submission, {
        onExcessProperty: "error",
      }).pipe(
        Effect.orDie,
        Effect.andThen(
          Effect.sync(() => {
            submissions.push(submission);
            decision = {
              id: submission.inputId,
              session_id: submission.sessionId,
              kind: submission.request.kind,
              admission: "accepted",
              http_status: 202,
              problem: null,
              accepted_at: DateTime.formatIso(at),
              acceptance_order: submissions.length,
              delivery: "pending",
              turn: null,
              blocking_reason: null,
              transcript_position: null,
              client_id: null,
            };
            decisions.set(submission.inputId, decision);
            return decision;
          }).pipe(
            Effect.filterOrFail(
              () => !loseInputReply,
              () =>
                new AlbedoTransportError({
                  operation: "input.submit",
                  cause: "Response lost after acceptance",
                }),
            ),
          ),
        ),
      ),
    interruptSession: (_id, captured) =>
      Deferred.succeed(interrupted, undefined).pipe(
        Effect.as({
          run_id: captured.run_id,
          state: "requested" as const,
          cancelled_input_ids: [],
          warnings: [],
        }),
      ),
    cancelInput: Effect.fn("FakeAlbedo.cancelInput")(function* ({ inputId }) {
      decision = decisions.get(inputId) ?? null;
      if (decision === null || decision.admission !== "accepted")
        return yield* Effect.die("No accepted input");
      yield* Deferred.succeed(interrupted, undefined);
      if (decision.delivery === "pending") {
        decision = { ...decision, delivery: "cancelled" };
        decisions.set(inputId, decision);
        return { input: decision, result: "cancelled" as const };
      }
      return { input: decision, result: "interrupt_requested" as const };
    }),
  });
  const beginInput = Effect.fn("FakeAlbedo.beginInput")(function* (
    index = submissions.length - 1,
    runId = nativeRunId,
  ) {
    decision = decisions.get(submissions[index]!.inputId) ?? null;
    if (decision === null || decision.admission !== "accepted")
      return yield* Effect.die("No fixture input");
    yield* send([
      { type: "status", sequence: 0, data: { ...native.status, phase: "running", run_id: runId } },
      {
        type: "input",
        sequence: 0,
        data: {
          input: {
            ...decision,
            delivery: "committed",
            transcript_position: index * 2 + 1,
            turn: {
              id: runId,
              state: "running",
              started_at: DateTime.formatIso(at),
              ended_at: null,
              outcome: null,
            },
          },
        },
      },
    ]);
  });
  const finishInput = Effect.fn("FakeAlbedo.finishInput")(function* (
    index: number,
    state: "completed" | "interrupted" | "abandoned",
  ) {
    decision = decisions.get(submissions[index]!.inputId) ?? null;
    if (decision === null || decision.admission !== "accepted" || decision.turn === null)
      return yield* Effect.die("No running fixture input");
    const entry: (typeof Session.HistoryPage.Type.items)[number] = {
      id: `${index * 2 + 2}`,
      position: index * 2 + 2,
      kind: "assistant",
      turn_type: "user",
      turn_id: decision.turn.id,
      input_id: null,
      created_at: DateTime.formatIso(at),
      mail: null,
      content: [{ kind: "text", text: "Kept." }],
      checkpoint_id: `${index * 2 + 2}`,
      content_complete: true,
      tool: null,
      phase: "final",
    };
    yield* send([
      { type: "message", sequence: 0, data: { entry, replaces_live_ids: ["live-reply"] } },
      ...(native.status.run_id === decision.turn.id
        ? [{ type: "status" as const, sequence: 0, data: session().status }]
        : []),
      {
        type: "input",
        sequence: 0,
        data: {
          input: {
            ...decision,
            turn: { ...decision.turn, state, ended_at: DateTime.formatIso(at) },
          },
        },
      },
      {
        type: "turn_completed",
        sequence: 0,
        data: {
          run_id: decision.turn.id,
          state,
          input_ids: [decision.id],
          input_count: 1,
          truncated: false,
        },
      },
    ]);
  });
  return {
    client,
    submissions,
    creations,
    configurations,
    compactions,
    setCompactionResult: (result: typeof Protocol.CompactionResult.Type) => {
      compactionResult = result;
    },
    loseCompactionReply: () => {
      loseCompactionReply = true;
    },
    loseInputReply: () => {
      loseInputReply = true;
    },
    send,
    begin: Effect.suspend(() => beginInput()),
    beginInput,
    finish: (state: "completed" | "interrupted" | "abandoned") =>
      finishInput(submissions.length - 1, state),
    finishInput,
    decisions,
    interrupted,
    watching,
    helpers,
    endHelperStream: (id: string) => helperQueue(id).pipe(Effect.flatMap(Queue.end)),
    sendHelper: Effect.fn("FakeAlbedo.sendHelper")(function* (
      id: string,
      values: ReadonlyArray<Session.Event>,
    ) {
      let helper = helpers.get(id)!;
      let status = helper.status;
      let kernel = helper.kernel;
      let sequence = helper.cursor?.sequence ?? 0;
      const events = values.map((event) => ({ ...event, sequence: ++sequence }));
      const entries: (typeof Session.HistoryEntry.Type)[] = [];
      for (const event of events) {
        if (event.type === "status") status = event.data;
        if (event.type === "kernel") kernel = event.data.kernel;
        if (event.type === "message") entries.push(event.data.entry);
      }
      if (entries.length > 0)
        helper = {
          ...helper,
          history: {
            ...helper.history,
            items: [...helper.history.items, ...entries],
            high_water: entries.at(-1)!.position,
          },
        };
      helpers.set(id, { ...helper, status, kernel, cursor: { generation, sequence } });
      yield* Queue.offer(yield* helperQueue(id), { generation, cursor: sequence, events });
    }),
    collectionSubscriptions: () => collectionSubscriptions,
    refreshHelpers: Queue.offer(collectionQueue, {
      events: [
        { type: "invalidate", data: { urls: ["/sessions"], session_ids: [], scope_dirty: true } },
      ],
    }),
  };
});
