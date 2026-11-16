import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import { OutpostError, type OutpostCatalog, type OutpostFleet } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Outpost from "./Outpost.ts";

const isOutpostError = Schema.is(OutpostError);
const connection = {
  id: "outpost-1",
  label: "Workstation",
  url: "http://outpost.test",
  enabled: true,
  token: "private-bearer-token",
};
const session = {
  id: "abc123-test",
  project_id: "remote-project",
  lifecycle_state: "stopped",
  launch_mode: "project_direct",
  freshness: "fresh",
  title: "External session",
  availability: { read: true, history: true, stop: true, resume: true, reap: true },
};
const catalog: OutpostCatalog = {
  version: 1,
  fleet_epoch: "epoch:A",
  cursor: "opaque:90071992547409931234",
  generated_at: "2026-11-16T00:00:00Z",
  name: "Outpost",
  version_name: "0.9.8",
  features: ["fleet_catalog.v1", "fleet_events.v1", "session_history.v1", "future-feature"],
  projects: [{ id: "remote-project", path: "/remote/workspace", configuration_name: "main" }],
  sessions: [session],
};
const page = (value = catalog) => ({
  catalog: value,
  page: 0,
  page_count: 1,
  total_projects: value.projects?.length ?? 0,
  total_sessions: value.sessions?.length ?? 0,
  expires_at: "2026-11-16T00:10:00Z",
  snapshot_cursor: "snapshot:opaque",
  snapshot_token: "signed snapshot token",
  truncated: false,
});

function fixture(
  handler: (request: HttpClientRequest.HttpClientRequest) => Response,
  initial = [connection],
) {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  let stored: Uint8Array | undefined = initial.length
    ? new TextEncoder().encode(JSON.stringify(initial))
    : undefined;
  const layer = Outpost.layer.pipe(
    Layer.provide([
      NodeCrypto.layer,
      Layer.mock(ServerSecretStore.ServerSecretStore)({
        get: () => Effect.sync(() => Option.fromUndefinedOr(stored)),
        set: (_key, bytes) =>
          Effect.sync(() => {
            stored = bytes;
          }),
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            requests.push(request);
            expect(request.headers.authorization).toBe("Bearer private-bearer-token");
            return HttpClientResponse.fromWeb(request, handler(request));
          }),
        ),
      ),
    ]),
  );
  return { layer, requests, persisted: () => new TextDecoder().decode(stored) };
}

const fleetMatching = (
  service: Outpost.Outpost["Service"],
  predicate: (fleet: OutpostFleet) => boolean,
) =>
  service.changes.pipe(
    Stream.flatMap(Stream.fromIterable),
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

describe("Outpost fleet", () => {
  it.effect(
    "keeps credentials in the environment store and edits/disconnects/removes without terminating sessions",
    () => {
      const f = fixture(() => Response.json(page()), []);
      return Effect.gen(function* () {
        const service = yield* Outpost.Outpost;
        yield* service.save({
          label: "Workstation",
          url: "http://outpost.test/",
          enabled: false,
          token: connection.token,
        });
        const first = yield* fleetMatching(service, () => true);
        expect(first.connection.url).toBe("http://outpost.test");
        expect(JSON.stringify(first)).not.toContain(connection.token);
        expect(f.persisted()).toContain(connection.token);
        yield* service.save({ ...first.connection, label: "Renamed", enabled: false });
        expect(f.persisted()).toContain('"label":"Renamed"');
        expect(f.persisted()).toContain(connection.token);
        yield* service.test(first.connection.id);
        expect(f.requests.every((r) => r.method === "GET")).toBe(true);
        yield* service.remove(first.connection.id);
        expect(yield* service.changes.pipe(Stream.runHead)).toEqual(Option.some([]));
        expect(f.persisted()).toBe("[]");
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect(
    "replays opaque cursors, retains stale rows on failures, and replaces the fleet after an epoch reset",
    () => {
      let events = 0;
      let catalogs = 0;
      const f = fixture((request) => {
        const url = new URL(request.url);
        if (url.pathname === "/api/v1/catalog") {
          catalogs++;
          return Response.json(
            page(
              catalogs === 1
                ? catalog
                : { ...catalog, fleet_epoch: "epoch:B", cursor: "fresh:cursor", sessions: [] },
            ),
          );
        }
        expect(url.pathname).toBe("/api/v1/events");
        expect(url.searchParams.get("expected_epoch")).toBe("epoch:A");
        expect(url.searchParams.get("after")).toBe(events === 0 ? catalog.cursor : "cursor:next");
        events++;
        if (events === 1)
          return Response.json({
            fleet_epoch: "epoch:A",
            cursor: "cursor:next",
            heartbeat_interval_secs: 15,
            events: [
              { type: "summary_changed", session: { ...session, title: "Updated remotely" } },
            ],
          });
        if (events === 2)
          return Response.json({ code: "not-a-safe-code-with-private-data" }, { status: 503 });
        return Response.json({ code: "epoch_mismatch" }, { status: 400 });
      });
      return Effect.gen(function* () {
        const service = yield* Outpost.Outpost;
        yield* fleetMatching(service, (row) => row.status === "connected");
        expect((yield* service.refresh(connection.id)).catalog?.sessions?.[0]?.title).toBe(
          "Updated remotely",
        );
        const row = yield* service.refresh(connection.id);
        expect(row.status).toBe("stale");
        expect(row.catalog?.cursor).toBe("cursor:next");
        expect(row.error).toContain("HTTP 503");
        expect(row.error).not.toContain("private-data");
        const reset = yield* service.refresh(connection.id);
        expect(reset.catalog?.sessions).toEqual([]);
        expect(catalogs).toBe(2);
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect("fences catalog pages and never publishes a partial or mismatched snapshot", () => {
    let mismatch = false;
    const f = fixture((request) => {
      const url = new URL(request.url);
      if (url.searchParams.get("page") === "1") {
        expect(url.searchParams.get("snapshot_token")).toBe("signed snapshot token");
        return Response.json({
          ...page({ ...catalog, projects: [], cursor: mismatch ? "wrong-cursor" : catalog.cursor }),
          page: 1,
          page_count: 2,
          total_projects: 1,
          total_sessions: 1,
        });
      }
      return Response.json({
        ...page({ ...catalog, sessions: [] }),
        page_count: 2,
        total_projects: 1,
        total_sessions: 1,
      });
    });
    return Effect.gen(function* () {
      const service = yield* Outpost.Outpost;
      const first = yield* fleetMatching(service, (row) => row.status === "connected");
      expect(first.catalog?.projects).toHaveLength(1);
      expect(first.catalog?.sessions).toHaveLength(1);
      mismatch = true;
      const result = yield* service.test(connection.id);
      expect(result.status).toBe("stale");
      expect(result.catalog).toEqual(first.catalog);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect(
    "binds stopped history and attachments to checkpoints and forwards only supported lifecycle routes",
    () => {
      const history = {
        source_identity: "source:A",
        page_number: 0,
        page_count: 2,
        page: {
          checkpoint_id: "checkpoint:opaque",
          expires_at: "2026-11-16T00:10:00Z",
          items: [
            {
              raw_index: 0,
              lineage: "lineage:A",
              attribution: { kind: "historical_unknown" },
              body: {
                type: "message",
                content: "Saved response",
                attachment: { artifact_id: "artifact:A" },
              },
            },
          ],
          total_items: 2,
          truncated: true,
          next_page: "signed next page",
        },
      };
      let expired = false;
      const f = fixture((request) => {
        const url = new URL(request.url);
        if (url.pathname === "/api/v1/catalog") return Response.json(page());
        if (url.pathname.endsWith("/history")) {
          if (expired) return Response.json({ code: "snapshot_expired" }, { status: 410 });
          if (url.searchParams.has("next_page")) {
            expect(url.searchParams.get("checkpoint")).toBe(history.page.checkpoint_id);
            expect(url.searchParams.get("next_page")).toBe(history.page.next_page);
          }
          return Response.json(history);
        }
        if (url.pathname.includes("/attachments/")) {
          expect(url.searchParams.get("checkpoint")).toBe(history.page.checkpoint_id);
          expect(url.searchParams.get("length")).toBe("65536");
          return Response.json({
            artifact_id: "artifact:A",
            offset: 0,
            total_length: 4,
            media_type: "text/plain",
            data_base64: "dGVzdA==",
          });
        }
        if (request.method === "DELETE") return new Response(null, { status: 204 });
        return Response.json(session);
      });
      return Effect.gen(function* () {
        const service = yield* Outpost.Outpost;
        yield* fleetMatching(service, (row) => row.status === "connected");
        const input = { connectionId: connection.id, sessionId: session.id };
        expect(yield* service.history(input)).toEqual(history);
        yield* service.history({
          ...input,
          checkpoint: history.page.checkpoint_id,
          nextPage: history.page.next_page,
        });
        expect(
          (yield* service.attachment({
            ...input,
            artifactId: "artifact:A",
            checkpoint: history.page.checkpoint_id,
            offset: 0,
          })).total_length,
        ).toBe(4);
        for (const action of ["stop", "resume", "reap"] as const)
          yield* service.action({ ...input, action });
        expect(
          f.requests
            .filter((r) => r.method !== "GET")
            .map((r) => [r.method, new URL(r.url).pathname]),
        ).toEqual([
          ["POST", `/api/v1/sessions/${session.id}/stop`],
          ["POST", `/api/v1/sessions/${session.id}/resume`],
          ["DELETE", `/api/v1/sessions/${session.id}`],
        ]);
        expired = true;
        expect(
          yield* service
            .history({ ...input, checkpoint: history.page.checkpoint_id })
            .pipe(Effect.flip),
        ).toMatchObject({ code: "http", status: 410, remoteCode: "snapshot_expired" });
        expect(
          yield* service.sessionRequest({
            ...input,
            method: "GET",
            path: "/plugins/preview/http/surface",
            headers: { "datastar-request": "true", authorization: "surface-selected-token" },
          }),
        ).toBeDefined();
        expect(f.requests.at(-1)?.headers["datastar-request"]).toBe("true");
        for (const path of [
          "https://evil.test",
          "/plugins/p/http/../../terminate",
          "/plugins/p/http/%2e%2e/terminate",
          "/terminate",
          "//evil.test",
        ]) {
          expect(
            isOutpostError(
              yield* service.sessionRequest({ ...input, method: "POST", path }).pipe(Effect.flip),
            ),
          ).toBe(true);
        }
        expect(
          yield* service
            .sessionRequest({ ...input, sessionId: "..", method: "GET", path: "/sync" })
            .pipe(Effect.flip),
        ).toMatchObject({ code: "unsupported" });
      }).pipe(Effect.provide(f.layer));
    },
  );

  it("rejects credential-bearing and ambiguous connection URLs", () => {
    for (const url of [
      "file:///etc/passwd",
      "https://user:pass@example.com",
      "https://outpost.test?token=secret",
      "http://outpost.test/#fragment",
    ])
      expect(Outpost.normalizeOutpostUrl(url)).toBeNull();
    expect(Outpost.normalizeOutpostUrl("https://outpost.test/base/")).toBe(
      "https://outpost.test/base",
    );
  });
});
