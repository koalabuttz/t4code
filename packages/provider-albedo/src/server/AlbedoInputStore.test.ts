import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";

import * as AlbedoInputStore from "./AlbedoInputStore.ts";
import * as Protocol from "./protocol.ts";
const isSubmission = Schema.is(Protocol.Submission);
const storeLayer = AlbedoInputStore.layer.pipe(Layer.provide(SecureRandom.layerWebCrypto));

const intent = {
  providerInstanceId: "albedo-a",
  runId: "run-1",
  messageId: "message-1",
  sessionId: "01a0fcea-2b00-7000-8000-000000000001",
  request: {
    kind: "message" as const,
    text: "  Preserve whitespace.\n",
    files: [{ name: "test.txt", data: "dGVzdA==" }],
  },
};
const database = (filename: string) =>
  NodeSqliteClient.layer({ filename, readerWorker: false, writerWorker: false });
const stored = (filename: string) => storeLayer.pipe(Layer.provide(database(filename)));

describe("Albedo durable input intents", () => {
  it.effect(
    "recovers the same ID and immutable bytes after closing and reopening the database",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-albedo-input-" });
        const filename = path.join(directory, "state.sqlite");
        const first = yield* Effect.gen(function* () {
          const store = yield* AlbedoInputStore.AlbedoInputStore;
          return yield* store.prepare(intent);
        }).pipe(Effect.provide(stored(filename)));
        expect(isSubmission(first)).toBe(true);
        const reopened = yield* Effect.gen(function* () {
          const store = yield* AlbedoInputStore.AlbedoInputStore;
          expect(yield* store.get(intent)).toEqual(first);
          return yield* store.prepare(intent);
        }).pipe(Effect.provide(stored(filename)));
        expect(reopened).toEqual(first);
        expect(reopened.request).toEqual(intent.request);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("concurrent retries reserve one native identity", () =>
    Effect.gen(function* () {
      const store = yield* AlbedoInputStore.AlbedoInputStore;
      const submissions = yield* Effect.all(
        Array.from({ length: 16 }, () => store.prepare(intent)),
        { concurrency: "unbounded" },
      );
      expect(new Set(submissions.map((submission) => submission.inputId)).size).toBe(1);
      expect(yield* store.get(intent)).toEqual(submissions[0]);
    }).pipe(Effect.provide(stored(":memory:"))),
  );

  it.effect("bounds one run without preventing replay or another run", () =>
    Effect.gen(function* () {
      const store = yield* AlbedoInputStore.AlbedoInputStore;
      const accepted = yield* Effect.forEach(
        Array.from({ length: 256 }, (_, index) => ({ ...intent, messageId: `message-${index}` })),
        store.prepare,
      );
      expect((yield* Effect.flip(store.prepare({ ...intent, messageId: "overflow" })))._tag).toBe(
        "AlbedoInputLimit",
      );
      expect(yield* store.listRun(intent)).toEqual(
        accepted.map((entry, index) => ({ ...entry, messageId: `message-${index}` })),
      );
      expect(yield* store.prepare({ ...intent, messageId: "message-0" })).toEqual(accepted[0]);
      expect(yield* store.prepare({ ...intent, runId: "another-run" })).toMatchObject({
        request: intent.request,
      });
    }).pipe(Effect.provide(stored(":memory:"))),
  );

  it.effect.each([
    { name: "session", update: { sessionId: "another-session" } },
    { name: "text", update: { request: { ...intent.request, text: "different" } } },
    {
      name: "attachment",
      update: { request: { ...intent.request, files: [{ name: "test.txt", data: "bmV3" }] } },
    },
  ])("refuses a changed $name under the same delivery identity", ({ update }) =>
    Effect.gen(function* () {
      const store = yield* AlbedoInputStore.AlbedoInputStore;
      const first = yield* store.prepare(intent);
      const error = yield* Effect.flip(store.prepare({ ...intent, ...update }));
      expect(error._tag).toBe("AlbedoInputConflict");
      expect(yield* store.get(intent)).toEqual(first);
    }).pipe(Effect.provide(stored(":memory:"))),
  );

  it.effect("separates provider instances, new runs, and steering messages", () =>
    Effect.gen(function* () {
      const store = yield* AlbedoInputStore.AlbedoInputStore;
      const results = yield* Effect.forEach(
        [
          intent,
          { ...intent, providerInstanceId: "albedo-b" },
          { ...intent, runId: "run-2" },
          { ...intent, messageId: "steering-message" },
        ],
        (value) => store.prepare(value),
      );
      expect(new Set(results.map((value) => value.inputId)).size).toBe(4);
      expect(yield* store.get({ ...intent, messageId: "missing" })).toBeNull();
      expect(yield* store.listRun(intent)).toEqual([
        { ...results[0], messageId: intent.messageId },
        { ...results[3], messageId: "steering-message" },
      ]);
    }).pipe(Effect.provide(stored(":memory:"))),
  );

  it.effect("refuses corrupt persisted intent instead of replacing its native identity", () =>
    Effect.gen(function* () {
      const store = yield* AlbedoInputStore.AlbedoInputStore;
      const sql = yield* SqlClient.SqlClient;
      yield* store.prepare(intent);
      yield* sql`UPDATE albedo_input_intents SET request_json = 'corrupt'`;
      expect(yield* Effect.flip(store.get(intent))).toMatchObject({
        _tag: "AlbedoInputStoreError",
        operation: "read",
      });
      expect(yield* Effect.flip(store.listRun(intent))).toMatchObject({
        _tag: "AlbedoInputStoreError",
        operation: "read",
      });
      expect(yield* Effect.flip(store.prepare(intent))).toMatchObject({
        _tag: "AlbedoInputStoreError",
        operation: "prepare",
      });
      expect(yield* sql`SELECT COUNT(*) AS count FROM albedo_input_intents`).toEqual([
        { count: 1 },
      ]);
    }).pipe(Effect.provide(storeLayer.pipe(Layer.provideMerge(database(":memory:"))))),
  );
});
