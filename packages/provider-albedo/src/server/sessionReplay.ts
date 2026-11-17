import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as Protocol from "./sessionProtocol.ts";

export class AlbedoReplayError extends Schema.TaggedError<AlbedoReplayError>()(
  "AlbedoReplayError",
  {
    reason: Schema.Literals([
      "invalid_batch",
      "missing_reset",
      "sequence_gap",
      "identity_mismatch",
    ]),
  },
) {
  override get message() {
    return "Albedo's event stream lost continuity. Reload the native session snapshot before resuming live updates.";
  }
}

export class AlbedoStreamFailure extends Schema.TaggedError<AlbedoStreamFailure>()(
  "AlbedoStreamFailure",
  { code: Schema.String, detail: Schema.String },
) {
  override get message() {
    return `Albedo could not restore its session stream (${this.code}): ${this.detail}`;
  }
}

export interface Delivery {
  readonly cursor: Protocol.Cursor;
  readonly snapshot: Protocol.Session | undefined;
  readonly events: ReadonlyArray<Protocol.Event>;
}

// Validate the whole batch before exposing any part of it to the projection.
export const prepare = Effect.fn("AlbedoReplay.prepare")(function* (
  sessionId: string,
  previous: Protocol.Cursor | undefined,
  batch: Protocol.Batch,
) {
  const first = batch.events[0];
  if (first?.type === "failure") {
    if (batch.events.length !== 1 || batch.snapshot !== undefined) {
      return yield* new AlbedoReplayError({ reason: "invalid_batch" });
    }
    return yield* new AlbedoStreamFailure(first.data);
  }
  const reset = first?.type === "reset";
  const snapshot = batch.snapshot;
  if (reset !== (snapshot !== undefined)) {
    return yield* new AlbedoReplayError({ reason: "invalid_batch" });
  }
  if (!reset && (previous === undefined || previous.generation !== batch.generation)) {
    return yield* new AlbedoReplayError({ reason: "missing_reset" });
  }
  if (snapshot !== undefined && snapshot.id !== sessionId) {
    return yield* new AlbedoReplayError({ reason: "identity_mismatch" });
  }
  const start = snapshot !== undefined ? snapshot.cursor : previous;
  if (start == null || start.generation !== batch.generation) {
    return yield* new AlbedoReplayError({ reason: "invalid_batch" });
  }
  let sequence = start.sequence;
  const events: Protocol.Event[] = [];
  for (const event of batch.events.slice(reset ? 1 : 0)) {
    if (event.type === "reset" || event.type === "failure") {
      return yield* new AlbedoReplayError({ reason: "invalid_batch" });
    }
    if (event.sequence !== sequence + 1 || !Number.isSafeInteger(event.sequence)) {
      return yield* new AlbedoReplayError({ reason: "sequence_gap" });
    }
    sequence = event.sequence;
    events.push(event);
  }
  if (batch.cursor !== sequence) {
    return yield* new AlbedoReplayError({ reason: "sequence_gap" });
  }
  return {
    cursor: { generation: batch.generation, sequence },
    snapshot,
    events,
  } satisfies Delivery;
});
