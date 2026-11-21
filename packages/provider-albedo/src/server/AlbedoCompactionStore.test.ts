import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";
import * as Compactions from "./AlbedoCompactionStore.ts";

const sqlite = (filename: string) =>
  NodeSqliteClient.layer({ filename, readerWorker: false, writerWorker: false });
const stored = (filename: string) =>
  Compactions.layer.pipe(
    Layer.provide(SecureRandom.layerWebCrypto),
    Layer.provideMerge(sqlite(filename)),
  );
const key = {
  providerInstanceId: "albedo",
  runId: "compact-run",
  messageId: "compact-message",
  sessionId: "native-session",
};
const result = {
  selection_applied: false,
  effective_strategy: "rolling",
  state: "compacted" as const,
  observation: {
    strategy: "rolling",
    before_tokens: 900,
    after_tokens: 100,
    evicted_entries: 4,
    summary: "Keep the project decisions.",
  },
  failure: null,
};

it.effect("retains one action identity and one outcome across concurrent setup and restart", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-albedo-compaction-" });
    const filename = path.join(directory, "state.sqlite");
    const actionId = yield* Effect.gen(function* () {
      const store = yield* Compactions.AlbedoCompactionStore;
      const claims = yield* Effect.all([store.claim(key), store.claim(key)], { concurrency: 2 });
      expect(claims.filter((claim) => claim.dispatch)).toHaveLength(1);
      expect(claims[0]!.actionId).toMatch(/^[0-9a-f-]{14}7[0-9a-f-]{21}$/);
      expect(claims[1]!.actionId).toBe(claims[0]!.actionId);
      return claims[0]!.actionId!;
    }).pipe(Effect.provide(stored(filename)));
    const completion = { ...key, actionId };
    yield* Effect.gen(function* () {
      const store = yield* Compactions.AlbedoCompactionStore;
      expect(yield* store.claim(key)).toEqual({ dispatch: false, actionId, outcome: null });
      expect((yield* Effect.flip(store.claim({ ...key, sessionId: "replacement" })))._tag).toBe(
        "AlbedoCompactionStoreError",
      );
      expect(
        (yield* Effect.flip(store.complete({ ...completion, messageId: "replacement" }, result)))
          ._tag,
      ).toBe("AlbedoCompactionStoreError");
      expect(
        (yield* Effect.flip(store.complete({ ...completion, actionId: "other" }, result)))._tag,
      ).toBe("AlbedoCompactionStoreError");
      yield* store.complete(completion, result);
      yield* store.complete(completion, result);
      expect(
        (yield* Effect.flip(store.complete(completion, { ...result, state: "unchanged" })))._tag,
      ).toBe("AlbedoCompactionStoreError");
    }).pipe(Effect.provide(stored(filename)));
    yield* Effect.gen(function* () {
      const store = yield* Compactions.AlbedoCompactionStore;
      expect(yield* store.claim(key)).toEqual({ dispatch: false, actionId, outcome: result });
      expect(yield* store.read({ ...key, providerInstanceId: "other" })).toBeNull();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE albedo_compactions SET result_json = 'corrupt'`;
      expect((yield* Effect.flip(store.claim(key)))._tag).toBe("AlbedoCompactionStoreError");
    }).pipe(Effect.provide(stored(filename)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("preserves protocol 3 completed and unresolved claims during migration", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-albedo-compaction-" });
    const filename = path.join(directory, "legacy.sqlite");
    const completed = { ...key, runId: "completed-run" };
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE albedo_compactions (
        provider_instance_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        result_json TEXT,
        PRIMARY KEY (provider_instance_id, run_id)
      )`;
      yield* sql`INSERT INTO albedo_compactions
        (provider_instance_id, run_id, message_id, session_id, result_json)
        VALUES
          (${key.providerInstanceId}, ${key.runId}, ${key.messageId}, ${key.sessionId}, NULL),
          (${completed.providerInstanceId}, ${completed.runId}, ${completed.messageId},
            ${completed.sessionId}, ${JSON.stringify(result)})`;
    }).pipe(Effect.provide(sqlite(filename)));
    yield* Effect.gen(function* () {
      const store = yield* Compactions.AlbedoCompactionStore;
      expect(yield* store.claim(key)).toEqual({ dispatch: false, actionId: null, outcome: null });
      expect(yield* store.claim(completed)).toEqual({
        dispatch: false,
        actionId: null,
        outcome: result,
      });
      expect((yield* store.claim({ ...key, runId: "new-run" })).actionId).not.toBeNull();
    }).pipe(Effect.provide(stored(filename)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
