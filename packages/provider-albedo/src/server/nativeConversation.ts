import type { OrchestrationV2TurnItem, ProviderThreadId, ThreadId } from "@t3tools/contracts";
import type { IdAllocatorV2 } from "@t3tools/provider-core/server/IdAllocator";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import { makeSubagentConversationArtifacts } from "@t3tools/provider-core/server/subagentProjection";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AlbedoClient } from "./AlbedoClient.ts";
import { AlbedoNativeOutcomes, type Outcome } from "./AlbedoNativeOutcomes.ts";
import * as ActiveOutput from "./activeOutput.ts";
import * as Content from "./historyContent.ts";
import * as Observation from "./observation.ts";
import * as Replay from "./sessionReplay.ts";
import * as Session from "./sessionProtocol.ts";
import * as Projection from "./turnProjection.ts";
import { driver, providerRef } from "./turnProjection.ts";

type Entry = (typeof Session.HistoryPage.Type.items)[number];
const autonomous = (entry: Entry) => entry.turn_type !== "user" || entry.mail !== null;
const belongsTo = (entry: Entry, runs: ReadonlySet<string>) =>
  autonomous(entry) || (entry.turn_id !== null && runs.has(entry.turn_id));
const encodeEntry = Schema.encodeSync(Schema.fromJsonString(Session.HistoryEntry));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

export const make = Effect.fn("AlbedoNativeConversation.make")(function* (input: {
  readonly nativeId: string;
  readonly providerInstanceId: string;
  readonly threadId: ThreadId;
  readonly ownerThreadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
  readonly ids: IdAllocatorV2["Service"]["derive"];
  readonly startedAt: DateTime.Utc;
  readonly autonomousOnly?: boolean;
}) {
  const client = yield* AlbedoClient;
  const fs = yield* FileSystem.FileSystem;
  const outcomeStore = yield* AlbedoNativeOutcomes;
  const outcomeKey = { providerInstanceId: input.providerInstanceId, sessionId: input.nativeId };
  const rootNodeId = input.ids.nodeFromProviderItem({
    driver,
    nativeItemId: `${input.providerThreadId}/conversation`,
  });
  const owner = { driver, backgroundOwnerThreadId: input.ownerThreadId };
  const context = {
    threadId: input.threadId,
    providerThread: { id: input.providerThreadId },
    rootNodeId,
    runId: null,
  };
  let cursor: Session.Cursor | undefined;
  let savedRunId: string | null = null;
  let savedLatestRunId: string | null = null;
  let savedNative: Session.Session | undefined;
  let savedPendingInputs = new Set<string>();
  let savedProjections = new Map<string, Projection.Projection>();
  let savedHistory = new Map<string, Entry>();
  let savedEmitted = new Map<string, OrchestrationV2TurnItem>();
  let savedOutcomes = new Map<string, Outcome>();
  const accept = Effect.fn("AlbedoNativeConversation.accept")(
    function* (batch: Session.Batch, _connection = client) {
      const delivery = yield* Replay.prepare(input.nativeId, cursor, batch);
      let observedRunId = savedRunId;
      let latestRunId = savedLatestRunId;
      let native = savedNative;
      let pendingInputs = new Set(savedPendingInputs);
      let projections = new Map(savedProjections);
      let history = new Map(savedHistory);
      const emitted = new Map(savedEmitted);
      const outcomes = new Map(savedOutcomes);
      const content = yield* Content.makeReader(input.nativeId);
      const changed = new Set<string>();
      const events: ProviderAdapterV2Event[] = [];
      const now = yield* DateTime.now;
      const publish = (row: OrchestrationV2TurnItem) => {
        const previous = emitted.get(row.id);
        if (
          Projection.unchanged(previous, row) ||
          (previous?.type === "user_message" &&
            row.type === "user_message" &&
            previous.text === row.text) ||
          (previous?.type === "system_notice" &&
            row.type === "system_notice" &&
            previous.message === row.message)
        )
          return;
        emitted.set(row.id, row);
        if (row.type === "assistant_message")
          events.push({
            ...owner,
            type: "message.updated",
            message: {
              id: row.messageId,
              threadId: input.threadId,
              runId: null,
              nodeId: rootNodeId,
              role: "assistant",
              text: row.text,
              attachments: [],
              streaming: row.streaming,
              createdAt: row.startedAt ?? input.startedAt,
              updatedAt: now,
              createdBy: "agent",
              creationSource: "provider",
            },
          });
        events.push({ ...owner, type: "turn_item.updated", turnItem: row });
      };
      const notice = (key: string, message: string, ordinal: number, observedAt = now) =>
        publish({
          id: input.ids.turnItemFromProviderItem({
            driver,
            nativeItemId: `${input.providerThreadId}/${key}`,
          }),
          threadId: input.threadId,
          runId: null,
          nodeId: rootNodeId,
          providerThreadId: input.providerThreadId,
          providerTurnId: null,
          nativeItemRef: providerRef(key),
          parentItemId: null,
          ordinal,
          status: "completed",
          title: null,
          startedAt: observedAt,
          completedAt: observedAt,
          updatedAt: observedAt,
          type: "system_notice",
          message,
        });
      if (delivery.snapshot !== undefined) {
        const snapshot = delivery.snapshot;
        native = snapshot;
        pendingInputs = new Set(snapshot.pending_inputs.map((input) => input.id));
        const raw = yield* Content.readHistory(input.nativeId, 0, snapshot.history.high_water);
        // Albedo labels initiating entries; their replies retain ownership through turn_id.
        const nativeRuns = new Set(
          raw.flatMap((entry) =>
            autonomous(entry) && entry.turn_id !== null ? [entry.turn_id] : [],
          ),
        );
        const entries = yield* content.entries(
          input.autonomousOnly ? raw.filter((entry) => belongsTo(entry, nativeRuns)) : raw,
        );
        history = new Map(entries.map((entry) => [entry.id, entry]));
        observedRunId = snapshot.status.run_id;
        latestRunId =
          observedRunId ?? raw.findLast((entry) => entry.turn_id !== null)?.turn_id ?? null;
        const staged = yield* ActiveOutput.stage(
          input.autonomousOnly
            ? {
                ...snapshot,
                active_output: snapshot.active_output.filter((output) =>
                  nativeRuns.has(output.run_id),
                ),
              }
            : snapshot,
        );
        const outputs = yield* Effect.forEach(staged, ({ output, content }) =>
          Stream.runFold(
            content,
            () => "",
            (text, chunk) => text + chunk,
          ).pipe(Effect.map((text) => ({ output, text }))),
        );
        const runs = new Set(
          entries.flatMap((entry) => (entry.turn_id === null ? [] : [entry.turn_id])),
        );
        if (observedRunId !== null && !input.autonomousOnly) runs.add(observedRunId);
        for (const outcome of [
          ...(yield* outcomeStore.read(outcomeKey)),
          ...(yield* outcomeStore.read(outcomeKey, [...runs])),
        ])
          outcomes.set(outcome.runId, outcome);
        projections = new Map();
        for (const runId of runs) {
          projections.set(
            runId,
            yield* Projection.restore(runId, entries, outputs, snapshot.current_progress, snapshot),
          );
          changed.add(runId);
        }
        events.push({
          ...owner,
          type: "node.updated",
          node: {
            id: rootNodeId,
            threadId: input.threadId,
            runId: null,
            parentNodeId: null,
            rootNodeId,
            kind: "root_turn",
            status: "idle",
            countsForRun: false,
            providerThreadId: input.providerThreadId,
            providerTurnId: null,
            nativeItemRef: providerRef(input.nativeId),
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: input.startedAt,
            completedAt: null,
          },
        });
      }
      const visibleRuns = new Set(
        [...history.values()].flatMap((entry) => (entry.turn_id === null ? [] : [entry.turn_id])),
      );
      for (const event of delivery.events)
        if (
          event.type === "message" &&
          autonomous(event.data.entry) &&
          event.data.entry.turn_id !== null
        )
          visibleRuns.add(event.data.entry.turn_id);
      const includeRun = (runId: string) => !input.autonomousOnly || visibleRuns.has(runId);
      const expanded = yield* content.events(
        delivery.events.filter(
          (event) =>
            !input.autonomousOnly ||
            event.type !== "message" ||
            belongsTo(event.data.entry, visibleRuns),
        ),
      );
      const grouped = new Map<string, Session.Event[]>();
      for (const event of expanded) {
        if (event.type === "status") {
          observedRunId = event.data.run_id;
          if (observedRunId !== null) latestRunId = observedRunId;
          if (native !== undefined) native = { ...native, status: event.data };
        }
        if (event.type === "kernel" && native !== undefined)
          native = { ...native, kernel: event.data.kernel };
        if (event.type === "input") {
          const input = event.data.input;
          if (input.admission === "accepted" && input.delivery === "pending")
            pendingInputs.add(input.id);
          else pendingInputs.delete(input.id);
        }
        if (event.type === "message") {
          history.set(event.data.entry.id, event.data.entry);
          if (event.data.entry.turn_id !== null) {
            visibleRuns.add(event.data.entry.turn_id);
            latestRunId = event.data.entry.turn_id;
          }
        }
        const runId =
          event.type === "message"
            ? event.data.entry.turn_id
            : "run_id" in event.data
              ? event.data.run_id
              : observedRunId;
        if (runId !== null && includeRun(runId)) {
          const group = grouped.get(runId) ?? [];
          group.push(event);
          grouped.set(runId, group);
        }
        if (event.type === "turn_completed" && includeRun(event.data.run_id)) {
          latestRunId = event.data.run_id;
          const outcome = yield* outcomeStore.record(outcomeKey, {
            runId: event.data.run_id,
            state: event.data.state,
            ordinal:
              (Math.max(0, ...[...history.values()].map((entry) => entry.position)) + 1) * 10 + 9,
            observedAt: now,
          });
          outcomes.set(outcome.runId, outcome);
        }
        if (event.type === "error" && (runId === null || includeRun(runId)))
          notice(
            `error/${batch.generation}/${event.sequence}`,
            `${event.data.code}: ${event.data.message}`,
            (history.size + 1) * 10 + 8,
          );
      }
      for (const [runId, values] of grouped) {
        const previous = projections.get(runId) ?? { ...Projection.empty(), observedRunId: runId };
        projections.set(runId, yield* Projection.reduce(previous, runId, values, delivery.cursor));
        changed.add(runId);
      }
      // Bound the whole conversation, including JSON tool output, rather than each native turn alone.
      let characters = 0;
      for (const entry of history.values()) characters += encodeEntry(entry).length;
      for (const state of projections.values()) {
        for (const live of state.live.values()) characters += live.text.length;
        for (const tool of state.tools.values())
          characters += encodeJson([tool.arguments, tool.result, tool.trace]).length;
      }
      if (history.size > 8192 || projections.size > 8192 || characters > 16 * 1024 * 1024)
        return yield* new Projection.AlbedoProjectionError({
          detail:
            "Albedo's native conversation exceeds T3's activity limit; its full history remains in Albedo.",
        });
      for (const runId of changed) {
        const state = projections.get(runId)!;
        const first = [...state.history.values()].find((entry) => entry.created_at !== null);
        const startedAt =
          first?.created_at == null ? input.startedAt : DateTime.makeUnsafe(first.created_at);
        for (const row of Projection.render(
          state,
          context,
          { id: null, startedAt },
          runId,
          input.ids,
          now,
        )) {
          const outcome = outcomes.get(runId)?.state;
          const ended = outcome !== undefined && row.status === "running";
          const terminal = ended
            ? {
                ...row,
                status: outcome === "abandoned" ? ("failed" as const) : outcome,
                completedAt: now,
              }
            : row;
          publish(
            ended && (terminal.type === "assistant_message" || terminal.type === "reasoning")
              ? { ...terminal, streaming: false }
              : terminal,
          );
        }
      }
      for (const entry of history.values()) {
        const createdAt =
          entry.created_at === null ? input.startedAt : DateTime.makeUnsafe(entry.created_at);
        if (entry.kind === "user") {
          const text = entry.content
            .flatMap((part) => (part.kind === "text" ? [part.text] : []))
            .join("");
          const artifacts = makeSubagentConversationArtifacts({
            messageId: input.ids.messageFromProviderItem({
              driver,
              nativeItemId: `${input.providerThreadId}/history/${entry.id}`,
            }),
            turnItemId: input.ids.turnItemFromProviderItem({
              driver,
              nativeItemId: `${input.providerThreadId}/history/${entry.id}`,
            }),
            threadId: input.threadId,
            rootNodeId,
            providerThreadId: input.providerThreadId,
            providerTurnId: null,
            nativeItemRef: providerRef(entry.id),
            role: "user",
            text,
            ordinal: entry.position * 10,
            now: createdAt,
          });
          const previous = emitted.get(artifacts.turnItem.id);
          if (previous?.type !== "user_message" || previous.text !== text)
            events.push({ ...owner, type: "message.updated", message: artifacts.message });
          publish(artifacts.turnItem);
          if (entry.mail !== null)
            notice(
              `mail/${entry.mail.mail_id}`,
              `Native ${entry.mail.kind} from ${entry.mail.sender_label}${entry.mail.answer ? " (answer)" : ""}`,
              entry.position * 10 - 1,
              createdAt,
            );
        }
        if (entry.kind === "note" || entry.kind === "compaction")
          notice(
            `history/${entry.id}`,
            entry.content.flatMap((part) => (part.kind === "text" ? [part.text] : [])).join(""),
            entry.position * 10,
            createdAt,
          );
      }
      for (const outcome of outcomes.values()) {
        if (!includeRun(outcome.runId)) continue;
        notice(
          `outcome/${outcome.runId}`,
          `Native turn ${outcome.state}. Result verification is recorded in Albedo mail.`,
          outcome.ordinal,
          outcome.observedAt,
        );
      }
      cursor = delivery.cursor;
      savedRunId = observedRunId;
      savedLatestRunId = latestRunId;
      savedNative = native;
      savedPendingInputs = pendingInputs;
      savedProjections = projections;
      savedHistory = history;
      savedEmitted = emitted;
      savedOutcomes = outcomes;
      return {
        events,
        characters,
        outcome: latestRunId === null ? undefined : outcomes.get(latestRunId),
        pending:
          native === undefined ||
          pendingInputs.size > 0 ||
          Observation.pending({ ...native, pending_inputs: [] }),
      };
    },
    Effect.scoped,
    (effect, _batch, connection = client) =>
      effect.pipe(Effect.provideService(AlbedoClient, connection)),
    Effect.provideService(FileSystem.FileSystem, fs),
  );
  return { accept, cursor: () => cursor };
});
