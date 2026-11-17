import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";

import * as Protocol from "./protocol.ts";

const Key = Schema.Struct({
  providerInstanceId: Schema.NonEmptyString,
  providerThreadId: Schema.NonEmptyString,
});
type Key = typeof Key.Type;
const Intent = Schema.Struct({
  ...Key.fields,
  daemonHome: Schema.NonEmptyString,
  request: Protocol.NewSession,
});
type Intent = typeof Intent.Type;
const Binding = Schema.Struct({
  daemonHome: Schema.NonEmptyString,
  creation: Protocol.SessionCreation,
});
type Binding = typeof Binding.Type;
const decodeIntent = Schema.decodeEffect(Intent);
const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(Protocol.NewSession));
const decodeStored = Schema.decodeUnknownEffect(
  Schema.Struct({
    daemonHome: Schema.NonEmptyString,
    sessionId: Protocol.SessionCreation.fields.sessionId,
    request: Schema.fromJsonString(Protocol.NewSession),
  }),
);

export class AlbedoSessionStoreError extends Schema.TaggedError<AlbedoSessionStoreError>()(
  "AlbedoSessionStoreError",
  { operation: Schema.Literals(["initialize", "prepare", "read"]), cause: Schema.Defect() },
) {
  override get message() {
    return "Albedo session binding could not be persisted or recovered. Restore storage before creating another native session.";
  }
}

export class AlbedoSessionConflict extends Schema.TaggedError<AlbedoSessionConflict>()(
  "AlbedoSessionConflict",
  {},
) {
  override get message() {
    return "This T3 conversation is already bound to a different Albedo home or creation intent. Reconnect to the original session before changing its configuration.";
  }
}

export class AlbedoSessionStore extends Context.Service<
  AlbedoSessionStore,
  {
    readonly prepare: (
      intent: Intent,
    ) => Effect.Effect<Binding, AlbedoSessionStoreError | AlbedoSessionConflict>;
    readonly get: (key: Key) => Effect.Effect<Binding | null, AlbedoSessionStoreError>;
  }
>()("@t3tools/provider-albedo/server/AlbedoSessionStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;
  yield* sql`
    CREATE TABLE IF NOT EXISTS albedo_session_bindings (
      provider_instance_id TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL,
      daemon_home TEXT NOT NULL,
      session_id TEXT NOT NULL UNIQUE,
      request_json TEXT NOT NULL,
      PRIMARY KEY (provider_instance_id, provider_thread_id)
    )
  `.pipe(
    Effect.mapError((cause) => new AlbedoSessionStoreError({ operation: "initialize", cause })),
  );

  const read = Effect.fn("AlbedoSessionStore.read")(function* (key: Key) {
    const rows = yield* sql`
      SELECT daemon_home AS daemonHome, session_id AS sessionId, request_json AS request
      FROM albedo_session_bindings
      WHERE provider_instance_id = ${key.providerInstanceId} AND provider_thread_id = ${key.providerThreadId}
    `;
    if (rows[0] === undefined) return null;
    const record = yield* decodeStored(rows[0]);
    return {
      daemonHome: record.daemonHome,
      creation: { sessionId: record.sessionId, request: record.request },
    };
  });

  const prepare = Effect.fn("AlbedoSessionStore.prepare")(
    function* (intent: Intent) {
      const checked = yield* decodeIntent(intent, { onExcessProperty: "error" });
      const encoded = yield* encodeRequest(checked.request);
      const existing = yield* read(checked);
      if (existing !== null) {
        if (
          existing.daemonHome !== checked.daemonHome ||
          (yield* encodeRequest(existing.creation.request)) !== encoded
        ) {
          return yield* new AlbedoSessionConflict();
        }
        return existing;
      }
      const sessionId = yield* random.uuidV7();
      yield* sql`
      INSERT INTO albedo_session_bindings
        (provider_instance_id, provider_thread_id, daemon_home, session_id, request_json)
      VALUES (${checked.providerInstanceId}, ${checked.providerThreadId}, ${checked.daemonHome}, ${sessionId}, ${encoded})
    `;
      return { daemonHome: checked.daemonHome, creation: { sessionId, request: checked.request } };
    },
    (effect) => sql.withTransaction(effect),
    Effect.catchTags({
      SqlError: (cause) =>
        Effect.fail(new AlbedoSessionStoreError({ operation: "prepare", cause })),
      SchemaError: (cause) =>
        Effect.fail(new AlbedoSessionStoreError({ operation: "prepare", cause })),
    }),
  );

  const get = Effect.fn("AlbedoSessionStore.get")(
    (key: Key) => read(key),
    Effect.mapError((cause) => new AlbedoSessionStoreError({ operation: "read", cause })),
  );
  return AlbedoSessionStore.of({ prepare, get });
});

export const layer = Layer.effect(AlbedoSessionStore, make);
