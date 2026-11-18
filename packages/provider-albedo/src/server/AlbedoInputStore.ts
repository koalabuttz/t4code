import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";

import * as Protocol from "./protocol.ts";

const Key = Schema.Struct({
  providerInstanceId: Schema.NonEmptyString,
  runId: Schema.NonEmptyString,
  messageId: Schema.NonEmptyString,
});
type Key = typeof Key.Type;
const MAX_RUN_INPUTS = 256;
const Intent = Schema.Struct({
  ...Key.fields,
  sessionId: Protocol.Submission.fields.sessionId,
  request: Protocol.InputRequest,
});
type Intent = typeof Intent.Type;
const decodeIntent = Schema.decodeEffect(Intent);
const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(Protocol.InputRequest));
const decodeStored = Schema.decodeUnknownEffect(
  Schema.Struct({
    sessionId: Protocol.Submission.fields.sessionId,
    inputId: Protocol.Submission.fields.inputId,
    request: Schema.fromJsonString(Protocol.InputRequest),
  }),
);

const decodeMember = Schema.decodeUnknownEffect(
  Schema.Struct({
    messageId: Key.fields.messageId,
    sessionId: Protocol.Submission.fields.sessionId,
    inputId: Protocol.Submission.fields.inputId,
    request: Schema.fromJsonString(Protocol.InputRequest),
  }),
);

export class AlbedoInputStoreError extends Schema.TaggedError<AlbedoInputStoreError>()(
  "AlbedoInputStoreError",
  { operation: Schema.Literals(["initialize", "prepare", "read"]), cause: Schema.Defect() },
) {
  override get message() {
    return "Albedo input intent could not be persisted or recovered. No new input can be dispatched until storage is available.";
  }
}

export class AlbedoInputConflict extends Schema.TaggedError<AlbedoInputConflict>()(
  "AlbedoInputConflict",
  {},
) {
  override get message() {
    return "This T3 message already has a different Albedo input intent. Recover its original submission before starting new work.";
  }
}

export class AlbedoInputLimit extends Schema.TaggedError<AlbedoInputLimit>()(
  "AlbedoInputLimit",
  {},
) {
  override get message() {
    return "This T3 turn has reached its limit of 256 Albedo inputs. Existing work remains active; wait for it to finish before sending another message.";
  }
}

export class AlbedoInputStore extends Context.Service<
  AlbedoInputStore,
  {
    readonly prepare: (
      intent: Intent,
    ) => Effect.Effect<
      Protocol.Submission,
      AlbedoInputStoreError | AlbedoInputConflict | AlbedoInputLimit
    >;
    readonly get: (key: Key) => Effect.Effect<Protocol.Submission | null, AlbedoInputStoreError>;
    readonly listRun: (
      key: Pick<Key, "providerInstanceId" | "runId">,
    ) => Effect.Effect<
      ReadonlyArray<Protocol.Submission & { readonly messageId: string }>,
      AlbedoInputStoreError | AlbedoInputLimit
    >;
  }
>()("@t3tools/provider-albedo/server/AlbedoInputStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;
  // The driver supplies its own state database, never the daemon's or T3's live install database.
  yield* sql`
    CREATE TABLE IF NOT EXISTS albedo_input_intents (
      provider_instance_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      input_id TEXT NOT NULL UNIQUE,
      request_json TEXT NOT NULL,
      PRIMARY KEY (provider_instance_id, run_id, message_id)
    )
  `.pipe(Effect.mapError((cause) => new AlbedoInputStoreError({ operation: "initialize", cause })));

  const read = Effect.fn("AlbedoInputStore.read")(function* (key: Key) {
    const rows = yield* sql`
      SELECT session_id AS sessionId, input_id AS inputId, request_json AS request
      FROM albedo_input_intents
      WHERE provider_instance_id = ${key.providerInstanceId}
        AND run_id = ${key.runId} AND message_id = ${key.messageId}
    `;
    return rows[0] === undefined ? null : yield* decodeStored(rows[0]);
  });

  const prepare = Effect.fn("AlbedoInputStore.prepare")(
    function* (intent: Intent) {
      const checked = yield* decodeIntent(intent, { onExcessProperty: "error" });
      const encoded = yield* encodeRequest(checked.request);
      // Encoding through the same schema fixes field order while preserving string and attachment bytes.
      const existing = yield* read(checked);
      if (existing !== null) {
        if (
          existing.sessionId !== checked.sessionId ||
          (yield* encodeRequest(existing.request)) !== encoded
        ) {
          return yield* new AlbedoInputConflict();
        }
        return existing;
      }
      const inputId = yield* random.uuidV7();
      const count = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM albedo_input_intents
        WHERE provider_instance_id = ${checked.providerInstanceId} AND run_id = ${checked.runId}`;
      if (count[0]!.count >= MAX_RUN_INPUTS) return yield* new AlbedoInputLimit();
      yield* sql`
      INSERT INTO albedo_input_intents
        (provider_instance_id, run_id, message_id, session_id, input_id, request_json)
      VALUES (${checked.providerInstanceId}, ${checked.runId}, ${checked.messageId},
        ${checked.sessionId}, ${inputId}, ${encoded})
    `;
      return { sessionId: checked.sessionId, inputId, request: checked.request };
    },
    (effect) => sql.withTransaction(effect),
    Effect.catchTags({
      SqlError: (cause) => Effect.fail(new AlbedoInputStoreError({ operation: "prepare", cause })),
      SchemaError: (cause) =>
        Effect.fail(new AlbedoInputStoreError({ operation: "prepare", cause })),
    }),
  );

  const get = Effect.fn("AlbedoInputStore.get")(
    (key: Key) => read(key),
    Effect.mapError((cause) => new AlbedoInputStoreError({ operation: "read", cause })),
  );

  const listRun = Effect.fn("AlbedoInputStore.listRun")(
    function* (key: Pick<Key, "providerInstanceId" | "runId">) {
      const rows =
        yield* sql`SELECT message_id AS messageId, session_id AS sessionId, input_id AS inputId, request_json AS request
        FROM albedo_input_intents
        WHERE provider_instance_id = ${key.providerInstanceId} AND run_id = ${key.runId}
        ORDER BY rowid LIMIT ${MAX_RUN_INPUTS + 1}`;
      if (rows.length > MAX_RUN_INPUTS) return yield* new AlbedoInputLimit();
      return yield* Effect.forEach(rows, (row) => decodeMember(row));
    },
    Effect.catchTags({
      SqlError: (cause) => Effect.fail(new AlbedoInputStoreError({ operation: "read", cause })),
      SchemaError: (cause) => Effect.fail(new AlbedoInputStoreError({ operation: "read", cause })),
    }),
  );
  return AlbedoInputStore.of({ prepare, get, listRun });
});

export const layer = Layer.effect(AlbedoInputStore, make);
