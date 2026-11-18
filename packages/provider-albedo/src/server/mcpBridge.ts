import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { source } from "./mcpBridgeSource.ts";
import * as Protocol from "./protocol.ts";

const Binding = Schema.Struct({
  nativeSessionId: Protocol.SessionCreation.fields.sessionId,
  environmentId: Schema.NonEmptyString,
  threadId: Schema.NonEmptyString,
  providerSessionId: Schema.NonEmptyString,
  endpoint: Schema.NonEmptyString,
  authorizationHeader: Schema.NonEmptyString,
});
const encode = Schema.encodeEffect(Schema.fromJsonString(Binding));
const decode = Schema.decodeEffect(Schema.fromJsonString(Binding));

export class AlbedoMcpBindingError extends Schema.TaggedError<AlbedoMcpBindingError>()(
  "AlbedoMcpBindingError",
  {
    reason: Schema.Literals(["identity_conflict", "unavailable"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return this.reason === "identity_conflict"
      ? "This native Albedo session already belongs to another T3 thread. Its tool identity was not changed."
      : "T3 could not publish Albedo's session-local tool connection. No input was submitted.";
  }
}

export const bind = Effect.fn("AlbedoMcpBridge.bind")(
  function* (homeDirectory: string, nativeSessionId: string, config: McpProviderSessionConfig) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(homeDirectory, "t3-code", "v1");
    const sessions = path.join(directory, "sessions");
    const bindingPath = path.join(sessions, `${nativeSessionId}.json`);
    const value = {
      nativeSessionId,
      environmentId: config.environmentId,
      threadId: config.threadId,
      providerSessionId: config.providerSessionId,
      endpoint: config.endpoint,
      authorizationHeader: config.authorizationHeader,
    };
    // Validate the native identity before it is used as a filename.
    const encoded = yield* encode(value);
    yield* fs.makeDirectory(sessions, { recursive: true, mode: 0o700 });
    const previous = yield* fs.readFileString(bindingPath).pipe(
      Effect.flatMap(decode),
      Effect.catchIf(
        (error) => error._tag === "PlatformError" && error.reason._tag === "NotFound",
        () => Effect.succeed(null),
      ),
    );
    if (
      previous !== null &&
      (previous.environmentId !== value.environmentId || previous.threadId !== value.threadId)
    )
      return yield* new AlbedoMcpBindingError({ reason: "identity_conflict" });
    const publish = Effect.fn("AlbedoMcpBridge.publish")(function* (
      destination: string,
      contents: string,
    ) {
      const temporary = yield* fs.makeTempFileScoped({
        directory: path.dirname(destination),
        prefix: ".t3-binding-",
      });
      yield* fs.writeFileString(temporary, contents, { mode: 0o600 });
      yield* fs.chmod(temporary, 0o600);
      yield* fs.rename(temporary, destination);
    }, Effect.scoped);
    yield* publish(path.join(directory, "t3_albedo.py"), source);
    yield* publish(bindingPath, encoded);
  },
  Effect.catchIf(
    (error) => error._tag !== "AlbedoMcpBindingError",
    (cause) => Effect.fail(new AlbedoMcpBindingError({ reason: "unavailable", cause })),
  ),
);
