import { describe, expect, it } from "@effect/vitest";
import * as Base64 from "effect/encoding/Base64";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { HttpClientRequest, HttpClientResponse } from "effect/http";

import * as Outpost from "./Outpost.ts";
import * as OutpostSurfaces from "./OutpostSurfaces.ts";

const target = {
  connectionId: "outpost-1",
  sessionId: "external-session",
  pluginName: "html-surface",
  surfaceId: "results",
  generation: "generation-1",
};
const surface = {
  plugin_name: target.pluginName,
  surface_id: target.surfaceId,
  generation: target.generation,
  revision: "18446744073709551615",
  source: { type: "plugin_http", path: "/surface" },
};

function fixture(handler: (input: Outpost.OutpostSessionRequest) => Response) {
  return OutpostSurfaces.layer.pipe(
    Layer.provide(
      Layer.mock(Outpost.Outpost)({
        sessionRequest: (input) =>
          Effect.sync(() =>
            HttpClientResponse.fromWeb(
              HttpClientRequest.get("http://outpost.test"),
              handler(input),
            ),
          ),
      }),
    ),
  );
}

describe("OutpostSurfaces", () => {
  it.effect("binds HTML and streamed actions to the advertised plugin generation", () => {
    const calls: Outpost.OutpostSessionRequest[] = [];
    return Effect.gen(function* () {
      const service = yield* OutpostSurfaces.OutpostSurfaces;
      const document = yield* service.document(target);
      expect(document.html).toBe("<h1>Results</h1>");
      const frames = yield* service
        .request({
          ...target,
          method: "POST",
          path: "/action?datastar=%7B%22count%22%3A1%7D",
          headers: {
            "content-type": "application/json",
            "datastar-request": "true",
            authorization: "surface-selected-token",
            cookie: "private=value",
          },
          body: "{}",
        })
        .pipe(Stream.runCollect);
      expect(frames[0]).toEqual({
        type: "headers",
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
      const data = frames.flatMap((frame) =>
        frame.type === "chunk" ? [Base64.decodeString(frame.data)] : [],
      );
      expect(data.map(Result.getOrThrow)).toEqual([
        'event: datastar-patch-signals\ndata: signals {"count":2}\n\n',
      ]);
      expect(frames.at(-1)).toEqual({ type: "end" });
      expect(calls.at(-1)?.headers).toEqual({
        "content-type": "application/json",
        "datastar-request": "true",
      });
      expect(
        calls
          .filter((call) => call.path !== "/sync")
          .map((call) => [call.path, call.method, call.query]),
      ).toEqual([
        ["/plugins/html-surface/http/surface", "GET", undefined],
        ["/plugins/html-surface/http/action", "POST", { datastar: '{"count":1}' }],
      ]);
    }).pipe(
      Effect.provide(
        fixture((input) => {
          calls.push(input);
          if (input.path === "/sync")
            return Response.json({
              daemon_epoch: "epoch-1",
              cursor: "signed-cursor",
              surfaces: [surface],
            });
          return input.method === "POST"
            ? new Response('event: datastar-patch-signals\ndata: signals {"count":2}\n\n', {
                headers: { "content-type": "text/event-stream" },
              })
            : new Response("<h1>Results</h1>", { headers: { "content-type": "text/html" } });
        }),
      ),
    );
  });

  it.effect.each(["old-generation", "removed"])(
    "refuses %s surfaces before issuing a plugin action",
    (condition) =>
      Effect.gen(function* () {
        const service = yield* OutpostSurfaces.OutpostSurfaces;
        const error = yield* service
          .request({
            ...target,
            generation: condition === "removed" ? target.generation : condition,
            method: "POST",
            path: "/action",
            headers: {},
          })
          .pipe(Stream.runDrain, Effect.flip);
        expect(error.code).toBe("unsupported");
      }).pipe(
        Effect.provide(
          fixture((input) => {
            expect(input.path).toBe("/sync");
            return Response.json({
              daemon_epoch: "epoch-1",
              cursor: "signed-cursor",
              surfaces: condition === "removed" ? [] : [surface],
            });
          }),
        ),
      ),
  );

  it.effect("rejects redirects and an HTML read replaced by a new plugin generation", () => {
    let htmlRead = false;
    return Effect.gen(function* () {
      const service = yield* OutpostSurfaces.OutpostSurfaces;
      const redirected = yield* service
        .request({ ...target, method: "GET", path: "/redirect", headers: {} })
        .pipe(Stream.runDrain, Effect.flip);
      expect(redirected.code).toBe("unsupported");
      const changed = yield* service.document(target).pipe(Effect.flip);
      expect(changed.code).toBe("unsupported");
    }).pipe(
      Effect.provide(
        fixture((input) => {
          if (input.path === "/sync")
            return Response.json({
              daemon_epoch: "epoch-1",
              cursor: "signed-cursor",
              surfaces: [{ ...surface, generation: htmlRead ? "generation-2" : target.generation }],
            });
          if (input.path.endsWith("/redirect"))
            return new Response(null, {
              status: 302,
              headers: { location: "https://other.test/" },
            });
          htmlRead = true;
          return new Response("<h1>Old</h1>", { headers: { "content-type": "text/html" } });
        }),
      ),
    );
  });

  it("rejects paths that escape the plugin namespace without rewriting their meaning", () => {
    for (const path of [
      "https://other.test/action",
      "//other.test/action",
      "/../other",
      "/%2e%2e/other",
      "/a\\b",
      "/action#other",
      "/action?a=1&a=2",
      "/%252fother",
    ])
      expect(OutpostSurfaces.pluginHttpPath(path)).toBeUndefined();
    expect(OutpostSurfaces.pluginHttpPath("/action?q=what?next")).toEqual({
      path: "/action",
      query: { q: "what?next" },
    });
  });

  it.effect("replays surface invalidations from the signed snapshot cursor", () => {
    let snapshots = 0;
    const layer = fixture((input) => {
      if (input.path === "/sync") {
        snapshots++;
        return Response.json({
          daemon_epoch: "epoch-1",
          cursor: "signed-cursor",
          surfaces: [{ ...surface, revision: snapshots <= 2 ? "1" : "2" }],
        });
      }
      expect(input.path).toBe("/events");
      expect(input.query).toEqual({ after: "signed-cursor" });
      return new Response(
        'data: {"revision":"opaque-revision","record":{"type":"plugin_event","plugin_event":{"type":"surface_event"}}}\n\n'.repeat(
          2,
        ),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    return Effect.gen(function* () {
      const service = yield* OutpostSurfaces.OutpostSurfaces;
      const states = yield* service.changes(target).pipe(Stream.take(2), Stream.runCollect);
      expect(states.map((state) => state.surfaces[0]?.revision)).toEqual(["1", "2"]);
      expect(states.every((state) => state.status === "live")).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
