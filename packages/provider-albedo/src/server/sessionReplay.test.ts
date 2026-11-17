import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { generation, reset, sessionId, textEvent } from "./session.test-fixtures.ts";
import * as Protocol from "./sessionProtocol.ts";
import * as Replay from "./sessionReplay.ts";
import fixture from "./fixtures/native-session-stream.json" with { type: "json" };
import persistentPython from "./fixtures/native-persistent-python.json" with { type: "json" };

const decode = Schema.decodeUnknownEffect(Protocol.Batch);
const previous = { generation, sequence: 4 };

describe("Albedo session replay", () => {
  it.effect("replays native Python state across client detach and a daemon generation reset", () =>
    Effect.gen(function* () {
      let cursor: Protocol.Cursor | undefined;
      const kernels = new Set<string>();
      const generations = new Set<string>();
      const outputs: string[] = [];
      let completed = 0;
      const nativeSessionId = persistentPython.batches[0]?.snapshot?.id;
      expect(nativeSessionId).toBeDefined();
      for (const raw of persistentPython.batches) {
        const batch = yield* decode(raw);
        const delivery = yield* Replay.prepare(nativeSessionId!, cursor, batch);
        generations.add(batch.generation);
        const kernel = delivery.snapshot?.kernel.instance_id;
        if (kernel != null) kernels.add(kernel);
        for (const event of delivery.events) {
          if (event.type === "kernel" && event.data.kernel.instance_id !== null)
            kernels.add(event.data.kernel.instance_id);
          if (event.type === "tool") {
            expect(event.data.status).toBe("completed");
            expect(typeof event.data.result).toBe("string");
            if (typeof event.data.result === "string") {
              const result = JSON.parse(event.data.result);
              expect(result.status).toBe("ok");
              outputs.push(result.output);
            }
          }
          if (event.type === "turn_completed" && event.data.state === "completed") completed++;
        }
        cursor = delivery.cursor;
      }
      expect(outputs).toEqual(["41\n", "42\n", "43\n"]);
      expect(kernels.size).toBe(1);
      expect(generations.size).toBe(2);
      expect(completed).toBe(3);
    }),
  );

  it.effect(
    "consumes recorded native reasoning, text, history commits and the input's terminal outcome",
    () =>
      Effect.gen(function* () {
        let cursor: Protocol.Cursor | undefined;
        const events: Protocol.Event[] = [];
        const nativeSessionId = fixture.batches[0]?.snapshot?.id;
        expect(nativeSessionId).toBeDefined();
        for (const raw of fixture.batches) {
          const batch = yield* decode(raw);
          const delivery = yield* Replay.prepare(nativeSessionId!, cursor, batch);
          events.push(...delivery.events);
          cursor = delivery.cursor;
        }
        expect(
          events
            .filter((event) => event.type === "thinking")
            .map((event) => event.data.text)
            .join(""),
        ).toBe("Checking the native stream.");
        expect(
          events
            .filter((event) => event.type === "text")
            .map((event) => event.data.text)
            .join(""),
        ).toBe("T3 native Albedo proof: café 🌍");
        const terminal = events.find((event) => event.type === "turn_completed");
        expect(terminal?.data.state).toBe("completed");
        const input = events.filter((event) => event.type === "input").at(-1)?.data.input;
        expect(input?.turn?.id).toBe(terminal?.data.run_id);
        expect(input?.turn?.state).toBe("completed");
        expect(cursor?.sequence).toBe(23);
      }),
  );

  it.effect("validates every event before offering a batch and accepts unchanged keepalives", () =>
    Effect.gen(function* () {
      const initial = yield* Replay.prepare(sessionId, undefined, reset());
      expect(initial.cursor).toEqual({ generation, sequence: 0 });
      const delta = { generation, cursor: 2, events: [textEvent(1), textEvent(2)] };
      const delivery = yield* Replay.prepare(sessionId, initial.cursor, delta);
      expect(delivery.events).toEqual(delta.events);
      expect(delivery.snapshot).toBeUndefined();
      expect(
        (yield* Replay.prepare(sessionId, delivery.cursor, { generation, cursor: 2, events: [] }))
          .cursor,
      ).toEqual(delivery.cursor);
      const malformed = {
        ...delta,
        events: [textEvent(1), { ...textEvent(2), data: { text: "missing identities" } }],
      };
      expect((yield* Effect.flip(decode(malformed)))._tag).toBe("SchemaError");
      const progress = {
        call_id: "native-call",
        tool_call_id: null,
        name: "python",
        phase: "running",
        intent: "run",
        title: "🌍".repeat(160),
        preview: { offset_scalars: 0, text: "🌍".repeat(512) },
      };
      const unicode = {
        generation,
        cursor: 1,
        events: [{ type: "tool_progress", sequence: 1, data: { progress } }],
      };
      expect(yield* decode(unicode)).toEqual(unicode);
      expect(
        (yield* Effect.flip(
          decode({
            ...unicode,
            events: [
              {
                ...unicode.events[0],
                data: { progress: { ...progress, title: progress.title + "x" } },
              },
            ],
          }),
        ))._tag,
      ).toBe("SchemaError");
    }),
  );

  it.effect(
    "allows a reset to replace an older cursor and delivers later events after its snapshot",
    () =>
      Effect.gen(function* () {
        const batch = { ...reset(), cursor: 1, events: [...reset().events, textEvent(1)] };
        const delivery = yield* Replay.prepare(sessionId, previous, batch);
        expect(delivery.snapshot?.cursor).toEqual({ generation, sequence: 0 });
        expect(delivery.cursor.sequence).toBe(1);
        expect(delivery.events).toEqual([textEvent(1)]);
        const changed = "n0e_WR6iy5sG82Q_cbZBaw";
        const fresh = reset();
        const result = yield* Replay.prepare(sessionId, previous, {
          ...fresh,
          generation: changed,
          snapshot: { ...fresh.snapshot!, cursor: { generation: changed, sequence: 0 } },
        });
        expect(result.cursor).toEqual({ generation: changed, sequence: 0 });
      }),
  );

  it.effect.each([
    [
      "first batch without reset",
      undefined,
      { generation, cursor: 0, events: [] },
      "missing_reset",
    ],
    [
      "generation change without reset",
      previous,
      { generation: "n0e_WR6iy5sG82Q_cbZBaw", cursor: 4, events: [] },
      "missing_reset",
    ],
    [
      "missing sequence",
      previous,
      { generation, cursor: 6, events: [textEvent(6)] },
      "sequence_gap",
    ],
    [
      "repeated sequence",
      previous,
      { generation, cursor: 4, events: [textEvent(4)] },
      "sequence_gap",
    ],
    ["keepalive advancing cursor", previous, { generation, cursor: 5, events: [] }, "sequence_gap"],
    [
      "envelope skipping an event",
      previous,
      { generation, cursor: 6, events: [textEvent(5)] },
      "sequence_gap",
    ],
    ["reset without snapshot", previous, { ...reset(), snapshot: undefined }, "invalid_batch"],
    ["snapshot without reset", previous, { ...reset(), events: [] }, "invalid_batch"],
    [
      "misplaced reset",
      previous,
      { generation, cursor: 5, events: [textEvent(5), ...reset().events] },
      "invalid_batch",
    ],
    [
      "mixed failure",
      previous,
      {
        generation,
        cursor: 5,
        events: [
          textEvent(5),
          { type: "failure", data: { code: "history_unavailable", detail: "Unavailable" } },
        ],
      },
      "invalid_batch",
    ],
  ] as const)("rejects %s", ([, cursor, batch, reason]) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Replay.prepare(sessionId, cursor, batch));
      expect(error).toMatchObject({ _tag: "AlbedoReplayError", reason });
    }),
  );

  it.effect("surfaces failure before attachment without committing its replacement cursor", () =>
    Effect.gen(function* () {
      const batch = {
        generation,
        cursor: 100,
        events: [
          {
            type: "failure" as const,
            data: { code: "history_unavailable", detail: "History could not be loaded" },
          },
        ],
      };
      expect(yield* Effect.flip(Replay.prepare(sessionId, undefined, batch))).toMatchObject({
        _tag: "AlbedoStreamFailure",
        code: "history_unavailable",
      });
      expect(
        yield* Effect.flip(
          Replay.prepare(sessionId, previous, { ...batch, snapshot: reset().snapshot }),
        ),
      ).toMatchObject({ _tag: "AlbedoReplayError", reason: "invalid_batch" });
      expect(yield* Effect.flip(Replay.prepare("wrong-session", previous, reset()))).toMatchObject({
        _tag: "AlbedoReplayError",
        reason: "identity_mismatch",
      });
    }),
  );
});
