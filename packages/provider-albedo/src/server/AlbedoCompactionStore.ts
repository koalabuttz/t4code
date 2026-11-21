import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";

import { CompactionResult, UuidV7 } from "./protocol.ts";

const Key = Schema.Struct({
  providerInstanceId: Schema.NonEmptyString,
  runId: Schema.NonEmptyString,
  messageId: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
});
type Key = typeof Key.Type;
const decodeKey = Schema.decodeEffect(Key);
const Outcome = Schema.Union([CompactionResult, Schema.Literal("interrupted")]);
type Outcome = typeof Outcome.Type;
const EncodedOutcome = Schema.fromJsonString(Outcome);
const Stored = Schema.Struct({
  messageId: Key.fields.messageId,
  sessionId: Key.fields.sessionId,
  actionId: Schema.NullOr(UuidV7),
  outcome: Schema.NullOr(EncodedOutcome),
});
const decode = Schema.decodeUnknownEffect(Stored);
const encode = Schema.encodeEffect(EncodedOutcome);

export class AlbedoCompactionStoreError extends Schema.TaggedError<AlbedoCompactionStoreError>()(
  "AlbedoCompactionStoreError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Albedo's compaction receipt could not be saved or recovered. Reconnect to recover the original action before requesting another compaction.";
  }
}

export class AlbedoCompactionStore extends Context.Service<
  AlbedoCompactionStore,
  {
    readonly read: (
      key: Pick<Key, "providerInstanceId" | "runId">,
    ) => Effect.Effect<typeof Stored.Type | null, AlbedoCompactionStoreError>;
    readonly claim: (key: Key) => Effect.Effect<
      {
        readonly dispatch: boolean;
        readonly actionId: string | null;
        readonly outcome: Outcome | null;
      },
      AlbedoCompactionStoreError
    >;
    readonly complete: (
      key: Key & { readonly actionId: string },
      outcome: Outcome,
    ) => Effect.Effect<void, AlbedoCompactionStoreError>;
  }
>()("@t3tools/provider-albedo/server/AlbedoCompactionStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;
  yield* Effect.gen(function* () {
    yield* sql`CREATE TABLE IF NOT EXISTS albedo_compactions (
      provider_instance_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      action_id TEXT,
      result_json TEXT,
      PRIMARY KEY (provider_instance_id, run_id)
    )`;
    const columns = yield* sql<{ name: string }>`PRAGMA table_info(albedo_compactions)`;
    // Legacy incomplete rows have no daemon identity and must never acquire one.
    if (!columns.some((column) => column.name === "action_id")) {
      yield* sql`ALTER TABLE albedo_compactions ADD COLUMN action_id TEXT`;
    }
  }).pipe(
    (effect) => sql.withTransaction(effect),
    Effect.mapError((cause) => new AlbedoCompactionStoreError({ cause })),
  );

  const read = Effect.fn("AlbedoCompactionStore.read")(
    function* (key: Pick<Key, "providerInstanceId" | "runId">) {
      const rows = yield* sql`SELECT message_id AS messageId, session_id AS sessionId,
          action_id AS actionId, result_json AS outcome
        FROM albedo_compactions WHERE provider_instance_id = ${key.providerInstanceId} AND run_id = ${key.runId}`;
      return rows[0] === undefined ? null : yield* decode(rows[0]);
    },
    Effect.mapError((cause) => new AlbedoCompactionStoreError({ cause })),
  );
  const claim = Effect.fn("AlbedoCompactionStore.claim")(
    function* (key: Key) {
      yield* decodeKey(key);
      const stored = yield* read(key);
      if (stored !== null) {
        if (stored.sessionId !== key.sessionId || stored.messageId !== key.messageId) {
          return yield* new AlbedoCompactionStoreError({ cause: "Compaction ownership changed" });
        }
        return { dispatch: false, actionId: stored.actionId, outcome: stored.outcome };
      }
      const actionId = yield* random.uuidV7();
      yield* sql`INSERT INTO albedo_compactions
        (provider_instance_id, run_id, message_id, session_id, action_id)
        VALUES (${key.providerInstanceId}, ${key.runId}, ${key.messageId}, ${key.sessionId}, ${actionId})`;
      return { dispatch: true, actionId, outcome: null };
    },
    (effect) => sql.withTransaction(effect),
    Effect.mapError((cause) => new AlbedoCompactionStoreError({ cause })),
  );
  const complete = Effect.fn("AlbedoCompactionStore.complete")(
    function* (key: Key & { readonly actionId: string }, outcome: Outcome) {
      const encoded = yield* encode(outcome);
      const stored = yield* read(key);
      if (
        stored === null ||
        stored.sessionId !== key.sessionId ||
        stored.messageId !== key.messageId ||
        stored.actionId !== key.actionId ||
        (stored.outcome !== null && (yield* encode(stored.outcome)) !== encoded)
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
