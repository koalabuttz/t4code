import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { AlbedoClient, AlbedoProtocolError } from "./AlbedoClient.ts";
import type * as Protocol from "./sessionProtocol.ts";

const encodeText = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const invalid = () =>
  new AlbedoProtocolError({ operation: "content.read", reason: "invalid_response" });

// Spilled output is staged on disk before the reset can replace visible state.
export const stage = Effect.fn("AlbedoActiveOutput.stage")(function* (session: Protocol.Session) {
  const fs = yield* FileSystem.FileSystem;
  const client = yield* AlbedoClient;
  const encoder = new TextEncoder();
  const identities = new Set<string>();
  let total = 0;
  let inline = 0;
  for (const output of session.active_output) {
    total += output.bytes;
    if (identities.has(output.message_id) || total > 64 * 1024 * 1024) return yield* invalid();
    identities.add(output.message_id);
    if (output.text !== null) {
      inline += encoder.encode(encodeText(output.text)).byteLength;
      if (
        !output.text.isWellFormed() ||
        encoder.encode(output.text).byteLength !== output.bytes ||
        inline > 65536
      ) {
        return yield* invalid();
      }
    } else if (
      output.reference === null ||
      output.reference.bytes !== output.bytes ||
      output.reference.field !== output.kind
    ) {
      return yield* invalid();
    }
  }

  return yield* Effect.forEach(
    session.active_output,
    Effect.fn("AlbedoActiveOutput.stageSegment")(function* (output) {
      if (output.text !== null) return { output, content: Stream.succeed(output.text) };
      const reference = output.reference;
      if (reference === null) return yield* invalid();
      const path = yield* fs.makeTempFileScoped({ prefix: "t3-albedo-output-" });
      const file = yield* fs.open(path, { flag: "w" });
      const visited = new Set<string>();
      let next: string | undefined;
      let offset = 0;
      let complete = false;
      do {
        const page = yield* client.readActiveContent(session.id, reference.url, next);
        if (page.parts.length === 0 || complete) return yield* invalid();
        let pageBytes = 0;
        for (const part of page.parts) {
          if (
            part.field !== output.kind ||
            part.offset_bytes !== offset ||
            !part.text.isWellFormed() ||
            complete ||
            (part.text === "" && !part.complete)
          ) {
            return yield* invalid();
          }
          const bytes = encoder.encode(part.text);
          offset += bytes.byteLength;
          pageBytes += bytes.byteLength;
          if (offset > output.bytes || pageBytes > 262144) return yield* invalid();
          yield* file.writeAll(bytes);
          complete = part.complete;
        }
        if (page.next === null ? !complete || offset !== output.bytes : complete)
          return yield* invalid();
        if (page.next !== null) {
          if (visited.has(page.next) || visited.size >= 4096) return yield* invalid();
          visited.add(page.next);
        }
        next = page.next ?? undefined;
      } while (next !== undefined);
      return { output, content: fs.stream(path, { chunkSize: 65536 }).pipe(Stream.decodeText) };
    }),
  );
});
