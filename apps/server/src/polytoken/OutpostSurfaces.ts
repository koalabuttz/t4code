import {
  OutpostError,
  type OutpostSessionInput,
  type OutpostSurfaceInput,
  type OutpostSurfaceRequestInput,
  type OutpostSurfaceResponseFrame,
  type OutpostSurfaceState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Base64 from "effect/encoding/Base64";
import * as Sse from "effect/encoding/Sse";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as Outpost from "./Outpost.ts";

const SurfaceSnapshot = Schema.Struct({
  daemon_epoch: Schema.NonEmptyString,
  cursor: Schema.NonEmptyString,
  surfaces: Schema.optional(
    Schema.Array(
      Schema.Struct({
        plugin_name: Schema.String,
        surface_id: Schema.String,
        generation: Schema.String,
        revision: Schema.String,
        source: Schema.Struct({ type: Schema.Literal("plugin_http"), path: Schema.String }),
      }),
    ).check(Schema.isMaxLength(256)),
  ),
});
const decodeSnapshot = Schema.decodeEffect(Schema.fromJsonString(SurfaceSnapshot));
const decodeRecord = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

export class OutpostSurfaces extends Context.Service<
  OutpostSurfaces,
  {
    readonly changes: (
      input: OutpostSessionInput,
    ) => Stream.Stream<OutpostSurfaceState, OutpostError>;
    readonly document: (
      input: OutpostSurfaceInput,
    ) => Effect.Effect<
      { readonly surface: OutpostSurfaceState["surfaces"][number]; readonly html: string },
      OutpostError
    >;
    readonly request: (
      input: OutpostSurfaceRequestInput,
    ) => Stream.Stream<OutpostSurfaceResponseFrame, OutpostError>;
  }
>()("t3/polytoken/OutpostSurfaces") {}

export function pluginHttpPath(
  path: string,
): { readonly path: string; readonly query: Readonly<Record<string, string>> } | undefined {
  const separator = path.indexOf("?");
  const pathname = separator < 0 ? path : path.slice(0, separator);
  const query = separator < 0 ? "" : path.slice(separator + 1);
  if (
    !pathname?.startsWith("/") ||
    pathname.startsWith("//") ||
    /[\\%#\s\u0000-\u001f]/.test(pathname) ||
    path.includes("#") ||
    pathname.split("/").some((part) => part === "." || part === "..")
  )
    return;
  const params = new URLSearchParams(query);
  if (new Set(params.keys()).size !== [...params].length) return;
  return { path: pathname, query: Object.fromEntries(params) };
}

const readText = Effect.fn("OutpostSurfaces.readText")(function* (
  response: HttpClientResponse.HttpClientResponse,
  maximum: number,
) {
  const parts: Uint8Array[] = [];
  let length = 0;
  yield* response.stream.pipe(
    Stream.runForEach((part) => {
      length += part.byteLength;
      if (length > maximum) return Effect.fail(new OutpostError({ code: "protocol" }));
      parts.push(part);
      return Effect.void;
    }),
    Effect.timeout("15 seconds"),
    Effect.mapError(() => new OutpostError({ code: "protocol" })),
  );
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return new TextDecoder().decode(bytes);
});

const make = Effect.gen(function* () {
  const outpost = yield* Outpost.Outpost;
  const send = Effect.fn("OutpostSurfaces.send")(function* (input: Outpost.OutpostSessionRequest) {
    return yield* outpost
      .sessionRequest(input)
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
  });
  const snapshot = Effect.fn("OutpostSurfaces.snapshot")(function* (input: OutpostSessionInput) {
    const response = yield* send({ ...input, method: "GET", path: "/sync" });
    if (response.status !== 200)
      return yield* new OutpostError({ code: "http", status: response.status });
    const value = yield* decodeSnapshot(yield* readText(response, 2 * 1024 * 1024)).pipe(
      Effect.mapError(() => new OutpostError({ code: "protocol" })),
    );
    const surfaces = [];
    for (const surface of value.surfaces ?? []) {
      const path = pluginHttpPath(surface.source.path);
      if (
        !/^[a-z][a-z0-9-]{0,63}$/.test(surface.plugin_name) ||
        !/^[a-z][a-z0-9_-]{0,63}$/.test(surface.surface_id) ||
        !surface.generation ||
        !surface.revision ||
        !path ||
        Object.keys(path.query).length !== 0
      )
        return yield* new OutpostError({ code: "protocol" });
      surfaces.push({
        pluginName: surface.plugin_name,
        surfaceId: surface.surface_id,
        generation: surface.generation,
        revision: surface.revision,
        sourcePath: path.path,
      });
    }
    return {
      cursor: value.cursor,
      state: { epoch: value.daemon_epoch, status: "live", surfaces } satisfies OutpostSurfaceState,
    };
  });
  const resolve = Effect.fn("OutpostSurfaces.resolve")(function* (input: OutpostSurfaceInput) {
    const { state } = yield* snapshot(input);
    const surface = state.surfaces.find(
      (surface) => surface.pluginName === input.pluginName && surface.surfaceId === input.surfaceId,
    );
    if (!surface || surface.generation !== input.generation)
      return yield* new OutpostError({ code: "unsupported" });
    return surface;
  });
  const document = Effect.fn("OutpostSurfaces.document")(function* (input: OutpostSurfaceInput) {
    const surface = yield* resolve(input);
    const response = yield* send({
      ...input,
      method: "GET",
      path: `/plugins/${surface.pluginName}/http${surface.sourcePath}`,
    });
    if (
      response.status !== 200 ||
      !response.headers["content-type"]?.toLowerCase().startsWith("text/html")
    )
      return yield* new OutpostError({ code: "http", status: response.status });
    const html = yield* readText(response, 1024 * 1024);
    const current = yield* resolve(input);
    if (current.revision !== surface.revision)
      return yield* new OutpostError({ code: "unsupported" });
    return { surface, html };
  });
  const request = (input: OutpostSurfaceRequestInput) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const surface = yield* resolve(input);
        const route = pluginHttpPath(input.path);
        if (!route) return yield* new OutpostError({ code: "unsupported" });
        const requestHeaders: Record<string, string> = {};
        for (const [name, value] of Object.entries(input.headers)) {
          const lower = name.toLowerCase();
          if (
            [
              "content-type",
              "accept",
              "datastar-request",
              "datastar-selector",
              "datastar-mode",
            ].includes(lower)
          )
            requestHeaders[lower] = value;
        }
        const contentType = requestHeaders["content-type"];
        const response = yield* send({
          connectionId: input.connectionId,
          sessionId: input.sessionId,
          method: input.method,
          path: `/plugins/${surface.pluginName}/http${route.path}`,
          query: route.query,
          headers: requestHeaders,
          ...(input.body === undefined ? {} : { body: input.body }),
          ...(contentType === undefined ? {} : { contentType }),
        });
        if (response.status >= 300 && response.status < 400)
          return yield* new OutpostError({ code: "unsupported" });
        const headers: Record<string, string> = {};
        for (const key of [
          "content-type",
          "datastar-selector",
          "datastar-mode",
          "datastar-use-view-transition",
        ]) {
          const value = response.headers[key];
          if (value !== undefined) headers[key] = value;
        }
        return Stream.succeed<OutpostSurfaceResponseFrame>({
          type: "headers",
          status: response.status,
          headers,
        }).pipe(
          Stream.concat(
            response.stream.pipe(
              Stream.flatMap((bytes) =>
                Stream.fromIterable(
                  Array.from(
                    { length: Math.ceil(bytes.byteLength / 65536) },
                    (_, i): OutpostSurfaceResponseFrame => ({
                      type: "chunk",
                      data: Base64.encode(bytes.subarray(i * 65536, (i + 1) * 65536)),
                    }),
                  ),
                ),
              ),
              Stream.mapError(() => new OutpostError({ code: "connection" })),
            ),
          ),
          Stream.concat(Stream.succeed<OutpostSurfaceResponseFrame>({ type: "end" })),
        );
      }),
    );
  const changes = (input: OutpostSessionInput) =>
    Stream.suspend(() => {
      let previous: OutpostSurfaceState | undefined;
      const follow = Stream.unwrap(
        Effect.gen(function* () {
          const initial = yield* snapshot(input);
          const response = yield* send({
            ...input,
            method: "GET",
            path: "/events",
            query: { after: initial.cursor },
          });
          if (response.status !== 200)
            return yield* new OutpostError({ code: "http", status: response.status });
          const events = response.stream.pipe(
            Stream.decodeText(),
            Stream.pipeThroughChannel(Sse.decode({ maxEventSize: 2 * 1024 * 1024 })),
            Stream.mapError(() => new OutpostError({ code: "connection" })),
            Stream.mapEffect((event) =>
              Effect.gen(function* () {
                const raw = yield* decodeRecord(event.data).pipe(
                  Effect.mapError(() => new OutpostError({ code: "protocol" })),
                );
                const record =
                  typeof raw === "object" && raw !== null && "record" in raw
                    ? raw.record
                    : undefined;
                const kind =
                  typeof record === "object" && record !== null && "type" in record
                    ? record.type
                    : undefined;
                if (["reset_required", "epoch_started"].includes(String(kind)))
                  return yield* new OutpostError({ code: "connection" });
                if (kind !== "plugin_event" && kind !== "catalog_published") return undefined;
                return (yield* snapshot(input)).state;
              }),
            ),
            Stream.filter((state) => state !== undefined),
          );
          return Stream.succeed<OutpostSurfaceState>(initial.state).pipe(
            Stream.concat(events),
            Stream.concat(Stream.fail(new OutpostError({ code: "connection" }))),
          );
        }),
      );
      return follow.pipe(
        Stream.catch((error) =>
          Stream.succeed<OutpostSurfaceState>({
            epoch: previous?.epoch ?? null,
            surfaces: [],
            status: "reconnecting",
          }).pipe(Stream.concat(Stream.fail(error))),
        ),
        Stream.retry(
          Schedule.spaced("1 second").pipe(
            Schedule.setInputType<OutpostError>(),
            Schedule.while(
              ({ input: error }) =>
                error.code === "connection" ||
                (error.code === "http" &&
                  [400, 409, 410, 502, 503, 504].includes(error.status ?? 0)),
            ),
          ),
        ),
        Stream.filter((next) => {
          if (previous !== undefined && Equal.equals(previous, next)) return false;
          previous = next;
          return true;
        }),
      );
    });
  return OutpostSurfaces.of({ changes, document, request });
});

export const layer = Layer.effect(OutpostSurfaces, make);
