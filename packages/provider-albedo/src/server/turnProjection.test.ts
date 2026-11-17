import { describe, expect, it } from "@effect/vitest";
import {
  ProviderThreadId,
  ProviderTurnId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import { derive } from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { at, instanceId, providerSessionId, threadId, turnInput } from "./adapter.test-fixtures.ts";
import * as Session from "./sessionProtocol.ts";
import * as Projection from "./turnProjection.ts";
import { generation, session } from "./session.test-fixtures.ts";
import fixture from "./fixtures/native-session-stream.json" with { type: "json" };
import python from "./fixtures/native-persistent-python.json" with { type: "json" };

const decode = Schema.decodeUnknownEffect(Session.Batch);
const providerThread: OrchestrationV2ProviderThread = {
  id: ProviderThreadId.make("albedo-projection-thread"),
  driver: Projection.driver,
  providerInstanceId: instanceId,
  providerSessionId,
  appThreadId: threadId,
  ownerNodeId: null,
  nativeThreadRef: Projection.providerRef("native-session"),
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  createdAt: at,
  updatedAt: at,
};
const input = turnInput(providerThread);
const turn: OrchestrationV2ProviderTurn = {
  id: ProviderTurnId.make("albedo-projection-turn"),
  providerThreadId: providerThread.id,
  nodeId: input.rootNodeId,
  runAttemptId: input.attemptId,
  nativeTurnRef: null,
  ordinal: 1,
  status: "running",
  startedAt: at,
  completedAt: null,
};

describe("Albedo T3 activity projection", () => {
  it.effect("bounds the combined output of native turns joined by steering", () =>
    Effect.gen(function* () {
      const state = {
        ...Projection.empty(),
        live: new Map([
          [
            "message",
            { kind: "text" as const, runId: "native", text: "x".repeat(9 * 1024 * 1024) },
          ],
        ]),
      };
      yield* Projection.validateAll([state]);
      expect((yield* Effect.flip(Projection.validateAll([state, state])))._tag).toBe(
        "AlbedoProjectionError",
      );
    }),
  );
  it.effect(
    "keeps streamed reasoning and reply IDs when their commit is lost and recovery reads history",
    () =>
      Effect.gen(function* () {
        const batches = yield* Effect.forEach(fixture.batches, (batch) => decode(batch));
        const events = batches
          .flatMap((batch) => batch.events)
          .filter((event): event is Session.Event => "sequence" in event);
        const nativeRun = events.find((event) => event.type === "text");
        if (nativeRun?.type !== "text") throw new Error("Missing recorded text");
        const id = nativeRun.data.run_id;
        const streaming = yield* Projection.reduce(
          Projection.empty(),
          id,
          events.filter((event) => event.type !== "message"),
          { generation: batches[0]!.generation, sequence: events.at(-1)!.sequence },
        );
        const streamed = Projection.render(streaming, input, turn, id, derive, at);
        const history = events.flatMap((event) =>
          event.type === "message" ? [event.data.entry] : [],
        );
        const recovered = yield* Projection.restore(id, history, [], [], {
          ...session(),
          history: {
            ...session().history,
            high_water: Math.max(...history.map((entry) => entry.position)),
          },
        });
        const rows = Projection.render(recovered, input, turn, id, derive, at);
        expect(rows.map((row) => row.id)).toEqual(streamed.map((row) => row.id));
        expect(rows).toMatchObject([
          { type: "reasoning", text: "Checking the native stream.", streaming: false },
          { type: "assistant_message", text: "T3 native Albedo proof: café 🌍", streaming: false },
        ]);
      }),
  );

  it.effect(
    "recovers the recorded Python call under its progress identity with complete arguments and output",
    () =>
      Effect.gen(function* () {
        const batches = yield* Effect.forEach(python.batches, (batch) => decode(batch));
        const firstTool = batches
          .flatMap((batch) => batch.events)
          .find((event) => event.type === "tool");
        if (firstTool?.type !== "tool") throw new Error("Missing native tool");
        const recovery = batches.find((batch) =>
          batch.snapshot?.history.items.some((entry) => entry.kind === "tool_result"),
        );
        const history = recovery?.snapshot?.history.items;
        if (history === undefined) throw new Error("Missing native tool history");
        const nativeRun = history.find((entry) => entry.kind === "tool_result")?.turn_id;
        if (nativeRun == null) throw new Error("Missing tool turn");
        const live = yield* Projection.reduce(
          Projection.empty(),
          nativeRun,
          [
            {
              type: "status",
              sequence: firstTool.sequence - 1,
              data: { ...session().status, run_id: nativeRun },
            },
            firstTool,
          ],
          { generation, sequence: firstTool.sequence },
        );
        const liveTool = Projection.render(live, input, turn, nativeRun, derive, at).find(
          (row) => row.type === "dynamic_tool",
        );
        const state = yield* Projection.restore(nativeRun, history, [], [], recovery!.snapshot!);
        const restoredTool = Projection.render(state, input, turn, nativeRun, derive, at).find(
          (row) => row.type === "dynamic_tool",
        );
        expect(restoredTool?.id).toBe(liveTool?.id);
        expect(restoredTool).toMatchObject({
          type: "dynamic_tool",
          status: "completed",
          input: firstTool.data.arguments,
          output: firstTool.data.result,
        });
        expect(
          Projection.render(state, input, turn, "different-native-run", derive, at)[0]?.id,
        ).not.toBe(liveTool?.id);
        const later = yield* Projection.reduce(
          live,
          nativeRun,
          [
            {
              type: "status",
              sequence: firstTool.sequence + 1,
              data: { ...session().status, phase: "running", run_id: "later-native-run" },
            },
            {
              ...firstTool,
              sequence: firstTool.sequence + 2,
              data: { ...firstTool.data, progress_call_id: "another-turn-tool" },
            },
          ],
          { generation, sequence: firstTool.sequence + 2 },
        );
        expect([...later.tools.keys()]).toEqual([...live.tools.keys()]);
      }),
  );

  it.effect(
    "restores only the captured history and ignores stream output already in the snapshot",
    () =>
      Effect.gen(function* () {
        const batches = yield* Effect.forEach(fixture.batches, (batch) => decode(batch));
        const text = batches
          .flatMap((batch) => batch.events)
          .find((event) => event.type === "text");
        const entry = batches
          .flatMap((batch) => batch.events)
          .find((event) => event.type === "message" && event.data.entry.kind === "assistant");
        if (text?.type !== "text" || entry?.type !== "message")
          throw new Error("Missing recorded reply");
        const checkpoint = {
          cursor: { generation, sequence: text.sequence },
          status: { ...session().status, run_id: text.data.run_id },
          history: { ...session().history, high_water: entry.data.entry.position - 1 },
        };
        const restored = yield* Projection.restore(
          text.data.run_id,
          [entry.data.entry],
          [
            {
              output: {
                kind: "text",
                run_id: text.data.run_id,
                message_id: text.data.message_id,
                text: text.data.text,
                bytes: new TextEncoder().encode(text.data.text).byteLength,
                elapsed_ms: null,
                reference: null,
              },
              text: text.data.text,
            },
          ],
          [],
          checkpoint,
        );
        expect(restored.history.size).toBe(0);
        const replayed = yield* Projection.reduce(
          restored,
          text.data.run_id,
          [text],
          checkpoint.cursor,
        );
        expect(
          Projection.render(replayed, input, turn, text.data.run_id, derive, at),
        ).toMatchObject([{ type: "assistant_message", text: text.data.text, streaming: true }]);
      }),
  );
});
