import {
  OutpostAttachment,
  OutpostCatalogPage,
  OutpostConnection,
  OutpostError,
  OutpostFleetEvents,
  OutpostHistory,
  type OutpostAttachmentInput,
  type OutpostCatalog,
  type OutpostConnectionSaveInput,
  type OutpostFleet,
  type OutpostHistoryInput,
  type OutpostSessionActionInput,
  type OutpostSessionInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Base64 from "effect/encoding/Base64";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { applyFleetEvents, staleFleetSessions } from "./fleet.ts";

const SavedConnection = Schema.Struct({ ...OutpostConnection.fields, token: Schema.String });
const SavedConnections = Schema.Array(SavedConnection);
type SavedConnection = typeof SavedConnection.Type;
const decodeSavedConnections = Schema.decodeEffect(Schema.fromJsonString(SavedConnections));
const encodeSavedConnections = Schema.encodeEffect(Schema.fromJsonString(SavedConnections));
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const isOutpostError = Schema.is(OutpostError);
const storageKey = "outpost-connections-v1";
const resetCodes = new Set([
  "epoch_mismatch",
  "cursor_too_old",
  "reset_required",
  "snapshot_expired",
  "invalid_cursor",
]);
const remoteCodes = new Set([
  ...resetCodes,
  "history_requires_stopped",
  "history_not_finalized",
  "history_corrupt",
  "history_unavailable",
  "history_source_changed",
  "invalid_checkpoint",
  "attachment_range_invalid",
  "fleet_capacity_exceeded",
  "snapshot_capacity_exceeded",
]);

export interface OutpostSessionRequest extends OutpostSessionInput {
  readonly method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS" | "QUERY";
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly contentType?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export class Outpost extends Context.Service<
  Outpost,
  {
    readonly changes: Stream.Stream<ReadonlyArray<OutpostFleet>, OutpostError>;
    readonly save: (input: OutpostConnectionSaveInput) => Effect.Effect<void, OutpostError>;
    readonly remove: (id: string) => Effect.Effect<void, OutpostError>;
    readonly refresh: (id: string) => Effect.Effect<OutpostFleet, OutpostError>;
    readonly test: (id: string) => Effect.Effect<OutpostFleet, OutpostError>;
    readonly history: (input: OutpostHistoryInput) => Effect.Effect<OutpostHistory, OutpostError>;
    readonly attachment: (
      input: OutpostAttachmentInput,
    ) => Effect.Effect<OutpostAttachment, OutpostError>;
    readonly action: (input: OutpostSessionActionInput) => Effect.Effect<void, OutpostError>;
    readonly sessionRequest: (
      input: OutpostSessionRequest,
    ) => Effect.Effect<HttpClientResponse.HttpClientResponse, OutpostError>;
  }
>()("t3/polytoken/Outpost") {}

export const normalizeOutpostUrl = (raw: string): string | null => {
  const url = URL.parse(raw);
  if (
    !url ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
};

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const random = yield* SecureRandom.SecureRandom;
  const client = yield* HttpClient.HttpClient;
  const saved = yield* Ref.make<ReadonlyArray<SavedConnection>>([]);
  const state = yield* SubscriptionRef.make<ReadonlyArray<OutpostFleet>>([]);
  const lock = yield* Semaphore.make(1);
  const initialization = yield* Semaphore.make(1);
  const loaded = yield* Ref.make(false);
  const decode = <A, I>(schema: Schema.Codec<A, I>, value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError(() => new OutpostError({ code: "protocol" })),
    );

  const load = Effect.fn("Outpost.load")(function* () {
    if (yield* Ref.get(loaded)) return;
    const bytes = yield* secrets
      .get(storageKey)
      .pipe(Effect.mapError(() => new OutpostError({ code: "storage" })));
    const connections = Option.isNone(bytes)
      ? []
      : yield* decodeSavedConnections(new TextDecoder().decode(bytes.value)).pipe(
          Effect.mapError(() => new OutpostError({ code: "storage" })),
        );
    yield* Ref.set(saved, connections);
    yield* SubscriptionRef.set(
      state,
      connections.map(({ token: _token, ...connection }) => ({
        connection,
        status: connection.enabled ? "connecting" : "disconnected",
        checkedAt: null,
        error: null,
        catalog: null,
      })),
    );
    yield* Ref.set(loaded, true);
  }, initialization.withPermits(1));
  const persist = Effect.fn("Outpost.persist")(function* (
    connections: ReadonlyArray<SavedConnection>,
  ) {
    const json = yield* encodeSavedConnections(connections).pipe(
      Effect.mapError(() => new OutpostError({ code: "storage" })),
    );
    yield* secrets
      .set(storageKey, new TextEncoder().encode(json))
      .pipe(Effect.mapError(() => new OutpostError({ code: "storage" })));
    yield* Ref.set(saved, connections);
  });
  const get = Effect.fn("Outpost.get")(function* (id: string) {
    yield* load();
    const connection = (yield* Ref.get(saved)).find((c) => c.id === id);
    if (!connection) return yield* new OutpostError({ code: "missing" });
    return connection;
  });
  const request = Effect.fn("Outpost.request")(function* (
    connection: SavedConnection,
    path: string,
    method: OutpostSessionRequest["method"] = "GET",
    query?: Readonly<Record<string, string>>,
    body?: string,
    contentType?: string,
    headers?: Readonly<Record<string, string>>,
  ) {
    const url = new URL(`${connection.url}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    let req = HttpClientRequest.make(method)(url.toString()).pipe(
      HttpClientRequest.setHeaders(headers ?? {}),
      HttpClientRequest.setHeader("Authorization", `Bearer ${connection.token}`),
    );
    if (body !== undefined)
      req = req.pipe(HttpClientRequest.bodyText(body, contentType ?? "application/json"));
    return yield* client.execute(req).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.timeout("10 seconds"),
      Effect.mapError(() => new OutpostError({ code: "connection" })),
    );
  });
  const json = Effect.fn("Outpost.json")(function* (
    connection: SavedConnection,
    path: string,
    method: OutpostSessionRequest["method"] = "GET",
    query?: Readonly<Record<string, string>>,
  ) {
    const response = yield* request(connection, path, method, query);
    if (response.status === 204) return null;
    const chunks: Uint8Array[] = [];
    let length = 0;
    yield* response.stream.pipe(
      Stream.runForEach((chunk) => {
        length += chunk.byteLength;
        if (length > 3 * 1024 * 1024) return Effect.fail(new OutpostError({ code: "protocol" }));
        chunks.push(chunk);
        return Effect.void;
      }),
      Effect.timeout("10 seconds"),
      Effect.mapError((e) => (isOutpostError(e) ? e : new OutpostError({ code: "connection" }))),
    );
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const raw =
      length === 0
        ? null
        : yield* decodeJson(new TextDecoder().decode(bytes)).pipe(Effect.orElseSucceed(() => null));
    if (response.status < 200 || response.status >= 300) {
      const code =
        typeof raw === "object" &&
        raw !== null &&
        "code" in raw &&
        typeof raw.code === "string" &&
        remoteCodes.has(raw.code)
          ? raw.code
          : undefined;
      return yield* new OutpostError({
        code: "http",
        status: response.status,
        ...(code ? { remoteCode: code } : {}),
      });
    }
    return raw;
  });
  const catalog = Effect.fn("Outpost.catalog")(function* (connection: SavedConnection) {
    const first = yield* decode(OutpostCatalogPage, yield* json(connection, "/api/v1/catalog"));
    if (first.page !== 0 || first.page_count > 1000 || first.truncated)
      return yield* new OutpostError({ code: "protocol" });
    const projects = [...(first.catalog.projects ?? [])];
    const sessions = [...(first.catalog.sessions ?? [])];
    for (let page = 1; page < first.page_count; page++) {
      if (!first.snapshot_token) return yield* new OutpostError({ code: "protocol" });
      const next = yield* decode(
        OutpostCatalogPage,
        yield* json(connection, "/api/v1/catalog", "GET", {
          page: String(page),
          snapshot_token: first.snapshot_token,
        }),
      );
      if (
        next.page !== page ||
        next.page_count !== first.page_count ||
        next.catalog.fleet_epoch !== first.catalog.fleet_epoch ||
        next.catalog.cursor !== first.catalog.cursor ||
        next.snapshot_cursor !== first.snapshot_cursor ||
        next.snapshot_token !== first.snapshot_token ||
        next.truncated
      )
        return yield* new OutpostError({ code: "protocol" });
      projects.push(...(next.catalog.projects ?? []));
      sessions.push(...(next.catalog.sessions ?? []));
    }
    if (
      projects.length !== first.total_projects ||
      sessions.length !== first.total_sessions ||
      new Set(projects.map((p) => p.id)).size !== projects.length ||
      new Set(sessions.map((s) => s.id)).size !== sessions.length
    )
      return yield* new OutpostError({ code: "protocol" });
    return { ...first.catalog, projects, sessions };
  });
  const publish = Effect.fn("Outpost.publish")(function* (fleet: OutpostFleet) {
    yield* SubscriptionRef.update(state, (previous) => {
      const next = previous.map((row) => (row.connection.id === fleet.connection.id ? fleet : row));
      return Equal.equals(previous, next) ? previous : next;
    });
  });
  const refresh = Effect.fn("Outpost.refresh")(function* (
    connection: SavedConnection,
    reset = false,
  ) {
    const previous = (yield* SubscriptionRef.get(state)).find(
      (f) => f.connection.id === connection.id,
    );
    const now = yield* DateTime.now;
    const read = Effect.gen(function* () {
      const current = reset ? null : previous?.catalog;
      let next: OutpostCatalog;
      if (current?.features?.includes("fleet_events.v1")) {
        const result = yield* json(connection, "/api/v1/events", "GET", {
          after: current.cursor,
          expected_epoch: current.fleet_epoch,
        }).pipe(Effect.result);
        if (result._tag === "Failure") {
          if (!result.failure.remoteCode || !resetCodes.has(result.failure.remoteCode))
            return yield* result.failure;
          next = yield* catalog(connection);
        } else {
          const batch = yield* decode(OutpostFleetEvents, result.success);
          next = applyFleetEvents(current, batch) ?? (yield* catalog(connection));
        }
      } else next = yield* catalog(connection);
      return staleFleetSessions(next, DateTime.toEpochMillis(now));
    });
    const result = yield* read.pipe(Effect.result);
    const { token: _token, ...publicConnection } = connection;
    const fleet: OutpostFleet =
      result._tag === "Success"
        ? {
            connection: publicConnection,
            status: "connected",
            checkedAt: DateTime.formatIso(now),
            error: null,
            catalog: result.success,
          }
        : {
            connection: publicConnection,
            status: "stale",
            checkedAt: previous?.checkedAt ?? null,
            error: result.failure.message,
            catalog: previous?.catalog
              ? staleFleetSessions(previous.catalog, DateTime.toEpochMillis(now))
              : null,
          };
    yield* publish(fleet);
    return fleet;
  });
  const save = Effect.fn("Outpost.save")(function* (input: OutpostConnectionSaveInput) {
    yield* load();
    const connections = yield* Ref.get(saved);
    const existing = input.id ? connections.find((c) => c.id === input.id) : undefined;
    if (input.id && !existing) return yield* new OutpostError({ code: "missing" });
    const url = normalizeOutpostUrl(input.url);
    if (!url || /[\r\n]/.test(input.token ?? ""))
      return yield* new OutpostError({ code: "protocol" });
    const token = input.token ?? existing?.token;
    if (!token) return yield* new OutpostError({ code: "credentials" });
    const id =
      existing?.id ??
      (yield* random.uuidV4().pipe(Effect.mapError(() => new OutpostError({ code: "storage" }))));
    const { token: _token, ...connection } = {
      id,
      label: input.label,
      url,
      enabled: input.enabled,
      token,
    };
    yield* persist([...connections.filter((c) => c.id !== id), { ...connection, token }]);
    yield* SubscriptionRef.update(state, (rows) => [
      ...rows.filter((r) => r.connection.id !== id),
      {
        connection,
        status: connection.enabled ? ("connecting" as const) : ("disconnected" as const),
        checkedAt: null,
        error: null,
        catalog: null,
      },
    ]);
  }, lock.withPermits(1));
  const remove = Effect.fn("Outpost.remove")(function* (id: string) {
    yield* get(id);
    yield* persist((yield* Ref.get(saved)).filter((c) => c.id !== id));
    yield* SubscriptionRef.update(state, (rows) => rows.filter((r) => r.connection.id !== id));
  }, lock.withPermits(1));
  const test = Effect.fn("Outpost.test")(function* (id: string) {
    const connection = yield* get(id);
    const result = yield* refresh(connection, true);
    if (!connection.enabled) yield* publish({ ...result, status: "disconnected" });
    return result;
  }, lock.withPermits(1));
  const refreshConnection = Effect.fn("Outpost.refreshConnection")(function* (id: string) {
    const connection = yield* get(id);
    if (!connection.enabled) return yield* new OutpostError({ code: "unsupported" });
    return yield* refresh(connection);
  }, lock.withPermits(1));
  const session = Effect.fn("Outpost.session")(function* (input: OutpostSessionInput) {
    if ([".", ".."].includes(input.sessionId) || /[/\\\u0000-\u001f]/.test(input.sessionId))
      return yield* new OutpostError({ code: "unsupported" });
    const connection = yield* get(input.connectionId);
    if (!connection.enabled) return yield* new OutpostError({ code: "unsupported" });
    const fleet = (yield* SubscriptionRef.get(state)).find(
      (f) => f.connection.id === input.connectionId,
    );
    const row = fleet?.catalog?.sessions?.find((s) => s.id === input.sessionId);
    if (!row) return yield* new OutpostError({ code: "missing" });
    return { connection, row, path: `/api/v1/sessions/${encodeURIComponent(input.sessionId)}` };
  });
  const history = Effect.fn("Outpost.history")(function* (input: OutpostHistoryInput) {
    const { connection, row, path } = yield* session(input);
    if (!row.availability?.history || (input.nextPage && !input.checkpoint))
      return yield* new OutpostError({ code: "unsupported" });
    const result = yield* decode(
      OutpostHistory,
      yield* json(connection, `${path}/history`, "GET", {
        ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
        ...(input.nextPage ? { next_page: input.nextPage } : {}),
      }),
    );
    if (input.checkpoint && result.page.checkpoint_id !== input.checkpoint)
      return yield* new OutpostError({ code: "protocol" });
    return result;
  });
  const attachment = Effect.fn("Outpost.attachment")(function* (input: OutpostAttachmentInput) {
    if ([".", ".."].includes(input.artifactId) || /[/\\\u0000-\u001f]/.test(input.artifactId))
      return yield* new OutpostError({ code: "unsupported" });
    const { connection, row, path } = yield* session(input);
    if (!row.availability?.history) return yield* new OutpostError({ code: "unsupported" });
    const chunk = yield* decode(
      OutpostAttachment,
      yield* json(
        connection,
        `${path}/attachments/${encodeURIComponent(input.artifactId)}`,
        "GET",
        { checkpoint: input.checkpoint, offset: String(input.offset), length: "65536" },
      ),
    );
    const bytes = Base64.decode(chunk.data_base64);
    if (
      chunk.artifact_id !== input.artifactId ||
      chunk.offset !== input.offset ||
      Result.isFailure(bytes) ||
      bytes.success.byteLength > 65536 ||
      chunk.offset + bytes.success.byteLength > chunk.total_length ||
      (bytes.success.byteLength === 0 && chunk.offset < chunk.total_length)
    )
      return yield* new OutpostError({ code: "protocol" });
    return chunk;
  });
  const action = Effect.fn("Outpost.action")(function* (input: OutpostSessionActionInput) {
    const { connection, row, path } = yield* session(input);
    if (!row.availability?.[input.action]) return yield* new OutpostError({ code: "unsupported" });
    yield* json(
      connection,
      input.action === "reap" ? path : `${path}/${input.action}`,
      input.action === "reap" ? "DELETE" : "POST",
    );
    yield* refresh(connection, true);
  }, lock.withPermits(1));
  const sessionRequest = Effect.fn("Outpost.sessionRequest")(function* (
    input: OutpostSessionRequest,
  ) {
    const { connection, row, path } = yield* session(input);
    // A bound request cannot change session, origin, or credentials through a plugin-selected URL.
    if (
      !row.availability?.read ||
      /[?#\\%]/.test(input.path) ||
      input.path.split("/").some((part) => part === "." || part === "..") ||
      !(
        /^\/plugins\/[a-zA-Z0-9_-]+\/(http\/[^\s]*|openapi\.json)$/.test(input.path) ||
        (input.method === "GET" &&
          ["/sync", "/sync/summary", "/daemon-state", "/events"].includes(input.path))
      )
    )
      return yield* new OutpostError({ code: "unsupported" });
    return yield* request(
      connection,
      `${path}/proxy${input.path}`,
      input.method,
      input.query,
      input.body,
      input.contentType,
      input.headers,
    );
  });
  const poll = Effect.gen(function* () {
    yield* load();
    for (const connection of yield* Ref.get(saved))
      if (connection.enabled) yield* refresh(connection);
  }).pipe(lock.withPermits(1), Effect.ignore);
  yield* poll.pipe(Effect.repeat(Schedule.spaced("5 seconds")), Effect.forkScoped);
  const changes = Stream.unwrap(
    load().pipe(lock.withPermits(1), Effect.as(SubscriptionRef.changes(state))),
  );
  return Outpost.of({
    changes,
    save,
    remove,
    refresh: refreshConnection,
    test,
    history,
    attachment,
    action,
    sessionRequest,
  });
});

export const layer = Layer.effect(Outpost, make);
