import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { CompactionResult } from "./protocol.ts";

const Key = Schema.Struct({
  providerInstanceId: Schema.NonEmptyString,
  runId: Schema.NonEmptyString,
  messageId: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
});
type Key = typeof Key.Type;
const decodeKey = Schema.decodeEffect(Key);
const Stored = Schema.Struct({
  messageId: Key.fields.messageId,
  sessionId: Key.fields.sessionId,
  result: Schema.NullOr(Schema.fromJsonString(CompactionResult)),
});
const decode = Schema.decodeUnknownEffect(Stored);
const encode = Schema.encodeEffect(Schema.fromJsonString(CompactionResult));

export class AlbedoCompactionStoreError extends Schema.TaggedError<AlbedoCompactionStoreError>()(
  "AlbedoCompactionStoreError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Albedo's compaction receipt could not be saved or recovered. An uncertain compaction must not be repeated automatically.";
  }
}

export class AlbedoCompactionStore extends Context.Service<
  AlbedoCompactionStore,
  {
    readonly read: (
      key: Pick<Key, "providerInstanceId" | "runId">,
    ) => Effect.Effect<typeof Stored.Type | null, AlbedoCompactionStoreError>;
    readonly claim: (
      key: Key,
    ) => Effect.Effect<
      { readonly dispatch: boolean; readonly result: typeof CompactionResult.Type | null },
      AlbedoCompactionStoreError
    >;
    readonly complete: (
      key: Key,
      result: typeof CompactionResult.Type,
    ) => Effect.Effect<void, AlbedoCompactionStoreError>;
  }
>()("@t3tools/provider-albedo/server/AlbedoCompactionStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS albedo_compactions (
    provider_instance_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    result_json TEXT,
    PRIMARY KEY (provider_instance_id, run_id)
  )`.pipe(Effect.mapError((cause) => new AlbedoCompactionStoreError({ cause })));

  const read = Effect.fn("AlbedoCompactionStore.read")(
    function* (key: Pick<Key, "providerInstanceId" | "runId">) {
      const rows =
        yield* sql`SELECT message_id AS messageId, session_id AS sessionId, result_json AS result
        FROM albedo_compactions WHERE provider_instance_id = ${key.providerInstanceId} AND run_id = ${key.runId}`;
      return rows[0] === undefined ? null : yield* decode(rows[0]);
    },
    Effect.mapError((cause) => new AlbedoCompactionStoreError({ cause })),
  );
  const claim = Effect.fn("AlbedoCompactionStore.claim")(
    function* (key: Key) {
      yield* decodeKey(key);
      const rows =
        yield* sql`INSERT INTO albedo_compactions (provider_instance_id, run_id, message_id, session_id)
        VALUES (${key.providerInstanceId}, ${key.runId}, ${key.messageId}, ${key.sessionId})
        ON CONFLICT (provider_instance_id, run_id) DO NOTHING RETURNING run_id`;
      const stored = yield* read(key);
      if (
        stored === null ||
        stored.sessionId !== key.sessionId ||
        stored.messageId !== key.messageId
      )
        return yield* new AlbedoCompactionStoreError({ cause: "Compaction ownership changed" });
      return { dispatch: rows.length === 1, result: stored.result };
    },
    (effect) => sql.withTransaction(effect),
    Effect.mapError((cause) => new AlbedoCompactionStoreError({ cause })),
  );
  const complete = Effect.fn("AlbedoCompactionStore.complete")(
    function* (key: Key, result: typeof CompactionResult.Type) {
      const encoded = yield* encode(result);
      const stored = yield* read(key);
      if (
        stored === null ||
        stored.sessionId !== key.sessionId ||
        stored.messageId !== key.messageId ||
        (stored.result !== null && (yield* encode(stored.result)) !== encoded)
      )
        return yield* new AlbedoCompactionStoreError({
          cause: "Compaction receipt conflicts with its owner or outcome",
        });
      yield* sql`UPDATE albedo_compactions SET result_json = ${encoded}
        WHERE provider_instance_id = ${key.providerInstanceId} AND run_id = ${key.runId}`;
    },
    (effect) => sql.withTransaction(effect),
    Effect.mapError((cause) => new AlbedoCompactionStoreError({ cause })),
  );
  return AlbedoCompactionStore.of({ read, claim, complete });
});

export const layer = Layer.effect(AlbedoCompactionStore, make);
