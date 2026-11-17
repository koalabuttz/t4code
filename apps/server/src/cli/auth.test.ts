import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentHttpApi } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { Command } from "effect/cli";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../auth/http.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import { authCommand } from "./auth.ts";

class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

it.live.each(["running", "stopped", "failing"] as const)(
  "CLI revocation handles a %s server without leaving silently authorized connections",
  (mode) =>
    Effect.gen(function* () {
      const services = yield* Layer.build(
        EnvironmentAuth.layerRuntime.pipe(
          Layer.provideMerge(ServerSecretStore.layer),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-cli-revoke-" })),
        ),
      );
      const auth = Context.get(services, EnvironmentAuth.EnvironmentAuth);
      const sessions = Context.get(services, SessionStore.SessionStore);
      const config = Context.get(services, ServerConfig.ServerConfig);
      const issued = yield* auth.issueSession({ label: "client to revoke" });
      const invalidated = yield* Deferred.make<void>();
      yield* sessions
        .awaitInvalidation(issued.sessionId)
        .pipe(
          Effect.andThen(Deferred.succeed(invalidated, undefined)),
          Effect.forkScoped({ startImmediately: true }),
        );
      const routes = HttpApiBuilder.layer(AuthTestApi).pipe(
        Layer.provide(AuthHttp.layer),
        Layer.provide(AuthHttp.layerAuthenticatedAuth),
        Layer.provide(Layer.succeedContext(services)),
      );
      const server = yield* Layer.build(
        HttpRouter.serve(
          mode === "failing"
            ? HttpRouter.add(
                "POST",
                "/api/auth/clients/revoke",
                HttpServerResponse.empty({ status: 503 }),
              )
            : routes,
          { disableListenLog: true, disableLogger: true },
        ).pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
      ).pipe(Effect.provideContext(services));
      const address = Context.get(server, HttpServer.HttpServer).address;
      if (address._tag === "UnixPathAddress") return yield* Effect.die("Expected TCP server");
      const state = yield* makePersistedServerRuntimeState({ config, port: address.port });
      yield* persistServerRuntimeState({
        path: config.serverRuntimeStatePath,
        // Above Linux's PID ceiling; the listener may belong to another process after shutdown.
        state: mode === "stopped" ? { ...state, pid: 4_194_305 } : state,
      });
      const result = yield* Command.runWith(authCommand, { version: "0.0.0" })([
        "session",
        "revoke",
        "--base-dir",
        config.baseDir,
        issued.sessionId,
      ]).pipe(Effect.provideContext(services), Effect.result);
      if (mode === "failing") {
        expect(Result.isFailure(result)).toBe(true);
        expect((yield* auth.listSessions()).map((session) => session.sessionId)).toEqual([
          issued.sessionId,
        ]);
        expect(yield* Deferred.isDone(invalidated)).toBe(false);
        return;
      }
      expect(Result.isSuccess(result)).toBe(true);
      if (mode === "running") yield* Deferred.await(invalidated);
      else expect(yield* Deferred.isDone(invalidated)).toBe(false);
      expect(yield* auth.listSessions()).toEqual([]);
      expect(yield* sessions.verify(issued.token).pipe(Effect.flip)).toMatchObject({
        _tag: "SessionTokenRevokedError",
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          NetService.layer,
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
        ),
      ),
    ),
);
