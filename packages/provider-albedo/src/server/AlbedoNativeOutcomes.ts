import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const Outcome = Schema.Struct({
  runId: Schema.NonEmptyString,
  state: Schema.Literals(["completed", "interrupted", "failed", "abandoned"]),
  ordinal: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  observedAt: Schema.DateTimeUtcFromString,
});
export type Outcome = typeof Outcome.Type;
type Key = { readonly providerInstanceId: string; readonly sessionId: string };
const encode = Schema.encodeEffect(Schema.fromJsonString(Outcome));
const decode = Schema.decodeUnknownEffect(
  Schema.Struct({ outcome: Schema.fromJsonString(Outcome) }),
);

export class AlbedoNativeOutcomeError extends Schema.TaggedError<AlbedoNativeOutcomeError>()(
  "AlbedoNativeOutcomeError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Albedo's confirmed native outcomes could not be persisted or recovered. Keep the work unresolved until storage is restored.";
  }
}

export class AlbedoNativeOutcomes extends Context.Service<
  AlbedoNativeOutcomes,
  {
    readonly read: (
      key: Key,
      runIds?: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<Outcome>, AlbedoNativeOutcomeError>;
    readonly record: (
      key: Key,
      outcome: Outcome,
    ) => Effect.Effect<Outcome, AlbedoNativeOutcomeError>;
  }
>()("@t3tools/provider-albedo/server/AlbedoNativeOutcomes") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS albedo_native_outcomes (
    provider_instance_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    outcome_json TEXT NOT NULL,
    PRIMARY KEY (provider_instance_id, session_id, run_id)
  )`.pipe(Effect.mapError((cause) => new AlbedoNativeOutcomeError({ cause })));
  const read = Effect.fn("AlbedoNativeOutcomes.read")(
    function* (key: Key, runIds?: ReadonlyArray<string>) {
      if (runIds === undefined) {
        const rows = yield* sql`SELECT outcome_json AS outcome FROM albedo_native_outcomes
          WHERE provider_instance_id = ${key.providerInstanceId} AND session_id = ${key.sessionId}
          ORDER BY rowid DESC LIMIT 128`;
        return yield* Effect.forEach(rows, (row) =>
          decode(row).pipe(Effect.map((stored) => stored.outcome)),
        );
      }
      if (runIds.length > 8192)
        return yield* new AlbedoNativeOutcomeError({
          cause: "Native outcome paging limit exceeded",
        });
      const found: Outcome[] = [];
      for (let index = 0; index < runIds.length; index += 500) {
        const rows = yield* sql`SELECT outcome_json AS outcome FROM albedo_native_outcomes
          WHERE provider_instance_id = ${key.providerInstanceId} AND session_id = ${key.sessionId}
          AND run_id IN ${sql.in(runIds.slice(index, index + 500))}`;
        for (const row of rows) found.push((yield* decode(row)).outcome);
      }
      return found;
    },
    Effect.mapError((cause) => new AlbedoNativeOutcomeError({ cause })),
  );
  const record = Effect.fn("AlbedoNativeOutcomes.record")(
    function* (key: Key, outcome: Outcome) {
      const json = yield* encode(outcome);
      yield* sql`INSERT INTO albedo_native_outcomes (provider_instance_id, session_id, run_id, outcome_json)
        VALUES (${key.providerInstanceId}, ${key.sessionId}, ${outcome.runId}, ${json})
        ON CONFLICT (provider_instance_id, session_id, run_id) DO NOTHING`;
      const stored = (yield* read(key, [outcome.runId]))[0];
      if (stored === undefined || stored.state !== outcome.state)
        return yield* new AlbedoNativeOutcomeError({
          cause: "A confirmed native turn outcome changed",
        });
      return stored;
    },
    (effect) => sql.withTransaction(effect),
    Effect.mapError((cause) => new AlbedoNativeOutcomeError({ cause })),
  );
  return AlbedoNativeOutcomes.of({ read, record });
});

export const layer = Layer.effect(AlbedoNativeOutcomes, make);
