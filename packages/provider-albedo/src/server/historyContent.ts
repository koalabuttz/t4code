import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { AlbedoClient, AlbedoProtocolError } from "./AlbedoClient.ts";
import type * as Protocol from "./sessionProtocol.ts";

type Entry = (typeof Protocol.HistoryPage.Type.items)[number];
export const readHistory = Effect.fn("AlbedoHistoryContent.readHistory")(function* (
  sessionId: string,
  after = 0,
  through = Number.MAX_SAFE_INTEGER,
) {
  const client = yield* AlbedoClient;
  const rows: Entry[] = [];
  const visited = new Set<string>();
  let next: string | undefined;
  do {
    const page = yield* client.readHistory(sessionId, next === undefined ? { after } : { next });
    rows.push(...page.items.filter((entry) => entry.position <= through));
    next = page.items.some((entry) => entry.position > through)
      ? undefined
      : (page.newer ?? undefined);
    if (rows.length > 8192 || (next !== undefined && (visited.has(next) || visited.size >= 1024)))
      return yield* new AlbedoProtocolError({
        operation: "history.read",
        reason: "response_too_large",
      });
    if (next !== undefined) visited.add(next);
  } while (next !== undefined);
  return rows;
});
type Reference = Extract<Entry["content"][number], { kind: "reference" }>["reference"];
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Json));
const decodeTrace = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);
const invalid = () =>
  new AlbedoProtocolError({ operation: "content.read", reason: "invalid_response" });
const limit = 16 * 1024 * 1024;

export const makeReader = Effect.fn("AlbedoHistoryContent.makeReader")(function* (
  sessionId: string,
) {
  const client = yield* AlbedoClient;
  const cache = new Map<
    string,
    ReadonlyMap<string, { readonly text: string; readonly bytes: number }>
  >();
  const encoder = new TextEncoder();
  let bytes = 0;
  const read = Effect.fn("AlbedoHistoryContent.read")(function* (reference: Reference) {
    const saved = cache.get(reference.url);
    if (saved !== undefined) return saved;
    if (reference.bytes > limit || cache.size >= 8192) return yield* invalid();
    const fields = new Map<string, { text: string; bytes: number; complete: boolean }>();
    const visited = new Set<string>();
    let next: string | undefined;
    do {
      const page = yield* client.readHistoryContent(sessionId, reference.url, next);
      if (page.parts.length === 0) return yield* invalid();
      let pageBytes = 0;
      for (const part of page.parts) {
        const previous = fields.get(part.field);
        if (
          previous?.complete ||
          part.offset_bytes !== (previous?.bytes ?? 0) ||
          !part.text.isWellFormed() ||
          (part.text === "" && !part.complete)
        )
          return yield* invalid();
        const size = encoder.encode(part.text).byteLength;
        bytes += size;
        pageBytes += size;
        if (bytes > limit || pageBytes > 262144 || (previous === undefined && fields.size >= 200))
          return yield* invalid();
        fields.set(part.field, {
          text: (previous?.text ?? "") + part.text,
          bytes: (previous?.bytes ?? 0) + size,
          complete: part.complete,
        });
      }
      if (page.next !== null) {
        if (visited.has(page.next) || visited.size >= 4096) return yield* invalid();
        visited.add(page.next);
      }
      next = page.next ?? undefined;
    } while (next !== undefined);
    if ([...fields.values()].some((field) => !field.complete)) return yield* invalid();
    cache.set(reference.url, fields);
    return fields;
  });
  const field = Effect.fn("AlbedoHistoryContent.field")(function* (reference: Reference) {
    const fields = yield* read(reference);
    const value = fields.get(reference.field);
    if (value === undefined || value.bytes !== reference.bytes) return yield* invalid();
    return value.text;
  });
  const entries = Effect.fn("AlbedoHistoryContent.entries")(function* (
    values: ReadonlyArray<Entry>,
  ) {
    return yield* Effect.forEach(
      values,
      Effect.fn("AlbedoHistoryContent.entry")(function* (entry) {
        if (!entry.content.some((part) => part.kind === "reference")) return entry;
        const content = yield* Effect.forEach(
          entry.content,
          Effect.fn("AlbedoHistoryContent.part")(function* (part) {
            if (part.kind !== "reference") return part;
            const text = yield* field(part.reference);
            if (part.reference.field === "text") return { kind: "text" as const, text };
            if (part.reference.field === "trace")
              return {
                kind: "trace" as const,
                trace: yield* decodeTrace(text).pipe(Effect.mapError(invalid)),
              };
            return {
              kind: "json" as const,
              field: part.reference.field,
              value: yield* decodeJson(text).pipe(Effect.mapError(invalid)),
            };
          }),
        );
        return {
          ...entry,
          content,
          content_complete: !content.some((part) => part.kind === "image"),
        };
      }),
    );
  });
  const events = Effect.fn("AlbedoHistoryContent.events")(function* (
    values: ReadonlyArray<Protocol.Event>,
  ) {
    return yield* Effect.forEach(
      values,
      Effect.fn("AlbedoHistoryContent.event")(function* (event) {
        if (event.type === "message") {
          const [entry] = yield* entries([event.data.entry]);
          return { ...event, data: { ...event.data, entry: entry! } };
        }
        if (event.type !== "tool" || event.data.content_complete) return event;
        const reference = event.data.reference;
        if (reference === null || reference.field !== "result") return yield* invalid();
        const body = yield* read(reference);
        const result = yield* field(reference);
        const args = body.get("arguments");
        const trace = body.get("trace");
        if (args === undefined) return yield* invalid();
        return {
          ...event,
          data: {
            ...event.data,
            arguments: yield* decodeJson(args.text).pipe(Effect.mapError(invalid)),
            result: yield* decodeJson(result).pipe(Effect.mapError(invalid)),
            trace:
              trace === undefined
                ? event.data.trace
                : yield* decodeTrace(trace.text).pipe(Effect.mapError(invalid)),
            content_complete: true,
            reference: null,
          },
        };
      }),
    );
  });
  return { entries, events };
});
