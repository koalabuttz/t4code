import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SecureRandom from "effect/crypto/SecureRandom";

import * as AlbedoSessionStore from "./AlbedoSessionStore.ts";

const intent = {
  providerInstanceId: "albedo-a",
  providerThreadId: "provider-thread-1",
  daemonHome: "/albedo-a",
  request: {
    kind: "new" as const,
    workspace: "/crew/worktree-1",
    name: null,
    provider_profile: "profile-1",
    model: "model-1",
    effort: "high",
  },
};
const stored = (filename: string) =>
  AlbedoSessionStore.layer.pipe(
    Layer.provide([
      SecureRandom.layerWebCrypto,
      NodeSqliteClient.layer({ filename, readerWorker: false, writerWorker: false }),
    ]),
  );

describe("Albedo native session bindings", () => {
  it.effect(
    "persists the workspace and exact selection before dispatch, and reopens the same session",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-albedo-session-" });
        const filename = path.join(directory, "state.sqlite");
        const first = yield* Effect.gen(function* () {
          const store = yield* AlbedoSessionStore.AlbedoSessionStore;
          return yield* store.prepare(intent);
        }).pipe(Effect.provide(stored(filename)));
        const reopened = yield* Effect.gen(function* () {
          const store = yield* AlbedoSessionStore.AlbedoSessionStore;
          expect(yield* store.get(intent)).toEqual(first);
          return yield* store.prepare(intent);
        }).pipe(Effect.provide(stored(filename)));
        expect(reopened).toEqual(first);
        expect(reopened.creation.request).toEqual(intent.request);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "concurrent launches retain one native session while other threads remain independent",
    () =>
      Effect.gen(function* () {
        const store = yield* AlbedoSessionStore.AlbedoSessionStore;
        const bindings = yield* Effect.all(
          Array.from({ length: 8 }, () => store.prepare(intent)),
          { concurrency: "unbounded" },
        );
        expect(new Set(bindings.map((binding) => binding.creation.sessionId)).size).toBe(1);
        const worker = yield* store.prepare({ ...intent, providerThreadId: "worker-2" });
        expect(worker.creation.sessionId).not.toBe(bindings[0]?.creation.sessionId);
      }).pipe(Effect.provide(stored(":memory:"))),
  );

  it.effect.each([
    { name: "daemon home", change: { daemonHome: "/another-home" } },
    {
      name: "workspace",
      change: { request: { ...intent.request, workspace: "/another-worktree" } },
    },
    { name: "model", change: { request: { ...intent.request, model: "another-model" } } },
  ])("refuses changed $name during creation recovery", ({ change }) =>
    Effect.gen(function* () {
      const store = yield* AlbedoSessionStore.AlbedoSessionStore;
      const first = yield* store.prepare(intent);
      expect((yield* Effect.flip(store.prepare({ ...intent, ...change })))._tag).toBe(
        "AlbedoSessionConflict",
      );
      expect(yield* store.get(intent)).toEqual(first);
    }).pipe(Effect.provide(stored(":memory:"))),
  );
});
