import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Compactions from "./AlbedoCompactionStore.ts";

const stored = (filename: string) =>
  Compactions.layer.pipe(
    Layer.provideMerge(
      NodeSqliteClient.layer({ filename, readerWorker: false, writerWorker: false }),
    ),
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

it.effect(
  "preserves compaction ownership and uncertain results across restart without another dispatch",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-albedo-compaction-" });
      const filename = path.join(directory, "state.sqlite");
      yield* Effect.gen(function* () {
        const store = yield* Compactions.AlbedoCompactionStore;
        const claims = yield* Effect.all([store.claim(key), store.claim(key)], { concurrency: 2 });
        expect(claims.filter((claim) => claim.dispatch)).toHaveLength(1);
      }).pipe(Effect.provide(stored(filename)));
      yield* Effect.gen(function* () {
        const store = yield* Compactions.AlbedoCompactionStore;
        expect(yield* store.claim(key)).toEqual({ dispatch: false, result: null });
        expect((yield* Effect.flip(store.claim({ ...key, sessionId: "replacement" })))._tag).toBe(
          "AlbedoCompactionStoreError",
        );
        expect(
          (yield* Effect.flip(store.complete({ ...key, messageId: "replacement" }, result)))._tag,
        ).toBe("AlbedoCompactionStoreError");
        yield* store.complete(key, result);
        yield* store.complete(key, result);
        expect(
          (yield* Effect.flip(store.complete(key, { ...result, state: "unchanged" })))._tag,
        ).toBe("AlbedoCompactionStoreError");
      }).pipe(Effect.provide(stored(filename)));
      yield* Effect.gen(function* () {
        const store = yield* Compactions.AlbedoCompactionStore;
        expect(yield* store.claim(key)).toEqual({ dispatch: false, result });
        expect(yield* store.read({ ...key, providerInstanceId: "other" })).toBeNull();
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE albedo_compactions SET result_json = 'corrupt'`;
        expect((yield* Effect.flip(store.claim(key)))._tag).toBe("AlbedoCompactionStoreError");
      }).pipe(Effect.provide(stored(filename)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
