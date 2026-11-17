import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { instanceId, threadId } from "./adapter.test-fixtures.ts";
import { sessionId } from "./session.test-fixtures.ts";
import * as Bridge from "./mcpBridge.ts";

describe("Albedo session-local MCP binding", () => {
  it.effect(
    "rotates only the owning thread's credential without populating native helper identities",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-albedo-bindings-" });
        const config = {
          environmentId: EnvironmentId.make("test-env"),
          threadId,
          providerInstanceId: instanceId,
          providerSessionId: "t3-session",
          endpoint: "http://127.0.0.1:4321/mcp",
          authorizationHeader: "Bearer old-fixture",
          browserToolsAvailable: false,
        };
        yield* Bridge.bind(home, sessionId, config);
        yield* Bridge.bind(home, sessionId, {
          ...config,
          providerSessionId: "t3-resumed",
          authorizationHeader: "Bearer rotated-fixture",
        });
        const directory = path.join(home, "t3-code", "v1", "sessions");
        expect(yield* fs.readDirectory(directory)).toEqual([`${sessionId}.json`]);
        const saved = yield* fs.readFileString(path.join(directory, `${sessionId}.json`));
        expect(JSON.parse(saved)).toMatchObject({
          nativeSessionId: sessionId,
          threadId,
          providerSessionId: "t3-resumed",
          authorizationHeader: "Bearer rotated-fixture",
        });
        expect(
          yield* Effect.flip(
            Bridge.bind(home, sessionId, { ...config, threadId: ThreadId.make("another-thread") }),
          ),
        ).toMatchObject({ reason: "identity_conflict" });
        expect(yield* fs.readFileString(path.join(directory, `${sessionId}.json`))).toBe(saved);
        expect(yield* Effect.flip(Bridge.bind(home, "../another", config))).toMatchObject({
          reason: "unavailable",
        });
        expect(yield* fs.readDirectory(directory)).toEqual([`${sessionId}.json`]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
