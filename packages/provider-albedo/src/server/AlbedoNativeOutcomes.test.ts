import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Outcomes from "./AlbedoNativeOutcomes.ts";

const stored = (filename: string) =>
  Outcomes.layer.pipe(
    Layer.provideMerge(
      NodeSqliteClient.layer({ filename, readerWorker: false, writerWorker: false }),
    ),
  );
const key = { providerInstanceId: "albedo-a", sessionId: "native-helper" };

describe("Albedo confirmed native outcomes", () => {
  it.effect(
    "recovers immutable native facts across restart without crossing session or instance identities",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-albedo-outcomes-" });
        const filename = path.join(directory, "state.sqlite");
        const facts = (["completed", "interrupted", "failed", "abandoned"] as const).map(
          (state, ordinal) => ({
            runId: `native-run-${ordinal}`,
            state,
            ordinal,
            observedAt: DateTime.makeUnsafe("2026-11-16T12:00:00Z"),
          }),
        );
        yield* Effect.gen(function* () {
          const store = yield* Outcomes.AlbedoNativeOutcomes;
          for (const fact of facts) yield* store.record(key, fact);
          expect(
            yield* store.record(key, {
              ...facts[0]!,
              ordinal: 999,
              observedAt: DateTime.makeUnsafe("2026-11-16T13:00:00Z"),
            }),
          ).toEqual(facts[0]);
          expect(
            (yield* Effect.flip(store.record(key, { ...facts[0]!, state: "interrupted" })))._tag,
          ).toBe("AlbedoNativeOutcomeError");
        }).pipe(Effect.provide(stored(filename)));
        yield* Effect.gen(function* () {
          const store = yield* Outcomes.AlbedoNativeOutcomes;
          const recovered = yield* store.read(
            key,
            facts.map((fact) => fact.runId),
          );
          expect(recovered.toSorted((a, b) => a.ordinal - b.ordinal)).toEqual(facts);
          expect(yield* store.read(key)).toHaveLength(4);
          expect(yield* store.read({ ...key, sessionId: "other-helper" })).toEqual([]);
          expect(yield* store.read({ ...key, providerInstanceId: "albedo-b" })).toEqual([]);
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE albedo_native_outcomes SET outcome_json = 'corrupt' WHERE run_id = ${facts[0]!.runId}`;
          expect((yield* Effect.flip(store.read(key, [facts[0]!.runId])))._tag).toBe(
            "AlbedoNativeOutcomeError",
          );
        }).pipe(Effect.provide(stored(filename)));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
