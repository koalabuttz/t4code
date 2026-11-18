import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { AlbedoClient } from "./AlbedoClient.ts";
import * as Content from "./historyContent.ts";
import { fakeDaemon } from "./adapter.test-fixtures.ts";
import { sessionId } from "./session.test-fixtures.ts";
import type * as Protocol from "./sessionProtocol.ts";

const url = `/sessions/${sessionId}/history/2`;
const entry = {
  id: "2",
  position: 2,
  kind: "assistant",
  turn_type: "user",
  turn_id: "run",
  input_id: null,
  created_at: null,
  mail: null,
  checkpoint_id: null,
  content_complete: false,
  tool: null,
  content: [{ kind: "reference", reference: { url, field: "text", bytes: 10 } }],
} satisfies (typeof Protocol.HistoryPage.Type.items)[number];
const part = (field: string, text: string, offset_bytes = 0, complete = true) => ({
  field,
  text,
  offset_bytes,
  complete,
  encoding: "utf8" as const,
});

describe("Albedo full history content", () => {
  it.effect(
    "reassembles UTF-8 fields, shared argument references, and large live tool results",
    () =>
      Effect.gen(function* () {
        const fake = yield* fakeDaemon;
        const reads: Array<{ resource: string; next: string | undefined }> = [];
        const reader = yield* Content.makeReader(sessionId).pipe(
          Effect.provideService(AlbedoClient, {
            ...fake.client,
            readHistoryContent: (_id, resource, next) => {
              reads.push({ resource, next });
              return Effect.succeed(
                resource === url
                  ? {
                      entry_id: "2",
                      next: next === undefined ? "continuation" : null,
                      parts: [
                        next === undefined
                          ? part("text", "café ", 0, false)
                          : part("text", "🌍", 6),
                      ],
                    }
                  : {
                      entry_id: "3",
                      next: null,
                      parts: [part("result", '"42"'), part("arguments", '{"code":"answer"}')],
                    },
              );
            },
          }),
        );
        const full = yield* reader.entries([entry, { ...entry, id: "another-reference" }]);
        expect(full.map((value) => value.content)).toEqual([
          [{ kind: "text", text: "café 🌍" }],
          [{ kind: "text", text: "café 🌍" }],
        ]);
        const [tool] = yield* reader.events([
          {
            type: "tool",
            sequence: 1,
            data: {
              tool_call_id: "call",
              progress_call_id: "progress",
              name: "python",
              arguments: null,
              result: null,
              trace: null,
              content_complete: false,
              reference: { url: url.replace(/2$/, "3"), field: "result", bytes: 4 },
            },
          },
        ]);
        expect(tool).toMatchObject({
          data: {
            arguments: { code: "answer" },
            result: "42",
            content_complete: true,
            reference: null,
          },
        });
        expect(reads).toHaveLength(3);
      }).pipe(Effect.scoped),
  );
  it.effect.each(["offset", "size", "truncated", "loop", "surrogate", "oversized"] as const)(
    "refuses %s content before replacing any visible history",
    (fault) =>
      Effect.gen(function* () {
        const fake = yield* fakeDaemon;
        const reader = yield* Content.makeReader(sessionId).pipe(
          Effect.provideService(AlbedoClient, {
            ...fake.client,
            readHistoryContent: () =>
              Effect.succeed({
                entry_id: "2",
                next: fault === "loop" ? "again" : null,
                parts: [
                  part(
                    "text",
                    fault === "surrogate"
                      ? "\ud800"
                      : fault === "oversized"
                        ? "x".repeat(262145)
                        : "café 🌍",
                    fault === "offset" ? 1 : 0,
                    fault !== "truncated",
                  ),
                ],
              }),
          }),
        );
        const result = yield* reader
          .entries([
            {
              ...entry,
              content: [
                {
                  kind: "reference",
                  reference: { ...entry.content[0]!.reference, bytes: fault === "size" ? 11 : 10 },
                },
              ],
            },
          ])
          .pipe(Effect.result);
        expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "AlbedoProtocolError" } });
      }).pipe(Effect.scoped),
  );
});
