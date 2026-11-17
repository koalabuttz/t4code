import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as AlbedoClient from "./AlbedoClient.ts";
import * as ActiveOutput from "./activeOutput.ts";
import { generation, reset, session, sessionId, textEvent } from "./session.test-fixtures.ts";

const identity = {
  sessionId: "01a0fcea-2b00-7000-8000-000000000001",
  inputId: "01a0fcea-2b00-7000-8000-000000000002",
};
const submission = {
  ...identity,
  request: { kind: "message" as const, text: "  Keep these bytes.\n" },
};
const input = {
  id: identity.inputId,
  session_id: identity.sessionId,
  kind: "message",
  admission: "accepted",
  http_status: 202,
  problem: null,
  accepted_at: "2026-10-02T14:00:00Z",
  acceptance_order: 1,
  delivery: "pending",
  blocking_reason: null,
  transcript_position: null,
  turn: null,
  client_id: null,
};
const server = {
  instance_id: "daemon-1",
  pid: 123,
  protocol: 3,
  state: "ready",
  capabilities: {
    durable_inputs: 1,
    session_replay: 2,
    collection_invalidation: 1,
    tool_progress: 1,
  },
  build: null,
  digest: null,
  extensions: [],
  quota: null,
  notices: [],
};
const discovery = { port: 4321, token: "private-daemon-token", pid: 123, instance_id: "daemon-1" };
const problem = (status: number, code: string) => ({
  type: "about:blank",
  title: code,
  status,
  code,
  detail: code,
});
const reply = (request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status })));
const lost = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.fail(
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({ request, cause: new Error("connection lost") }),
    }),
  );

const daemon = (
  handle: Parameters<typeof HttpClient.make>[0],
  info: unknown = server,
  record: unknown = discovery,
) =>
  AlbedoClient.layer("/albedo").pipe(
    Layer.provide([
      Path.layer,
      FileSystem.layerNoop({ readFileString: () => Effect.succeed(JSON.stringify(record)) }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request, url, signal, fiber) => {
          expect(request.headers.authorization).toBe(`Bearer ${discovery.token}`);
          expect(new URL(request.url).origin).toBe("http://127.0.0.1:4321");
          return new URL(request.url).pathname === "/server"
            ? reply(request, info)
            : handle(request, url, signal, fiber);
        }),
      ),
    ]),
  );

describe("Albedo stream and snapshot transport", () => {
  it.effect.each(["compacted", "unchanged", "failed", "lost_reply", "malformed"] as const)(
    "decodes native compaction without retrying when %s",
    (state) => {
      let writes = 0;
      const response = {
        selection_applied: false,
        effective_strategy: "rolling",
        state: state === "unchanged" || state === "failed" ? state : "compacted",
        observation: {
          strategy: "rolling",
          before_tokens: 900,
          after_tokens: 100,
          evicted_entries: 4,
          summary: "Kept context.",
        },
        failure:
          state === "failed" ? { code: "strategy_failed", detail: "Strategy failed." } : null,
      };
      return Effect.gen(function* () {
        const client = yield* AlbedoClient.AlbedoClient;
        const result = yield* client.compactSession("native/session").pipe(Effect.result);
        if (state === "lost_reply" || state === "malformed") expect(result._tag).toBe("Failure");
        else {
          expect(result._tag).toBe("Success");
          if (result._tag === "Success") expect(result.success).toEqual(response);
        }
        expect(writes).toBe(1);
      }).pipe(
        Effect.provide(
          daemon((request) => {
            writes++;
            expect(request.method).toBe("POST");
            expect(new URL(request.url).pathname).toBe("/sessions/native%2Fsession/compaction");
            return state === "lost_reply"
              ? lost(request)
              : reply(
                  request,
                  state === "malformed" ? { ...response, state: "unknown" } : response,
                );
          }),
        ),
      );
    },
  );
  it.effect.each([
    "confirmed",
    "lost_ack",
    "ack_only",
    "unreported",
    "replaced_kernel",
    "wrong_job",
    "already_finished",
  ] as const)("confirms a scoped native job stop when %s", (mode) => {
    let writes = 0;
    const job = {
      id: "native/cell/job",
      pid: 123,
      command: "worker",
      kind: "command",
      parent_id: null,
      started_at: 1,
    };
    const other = { ...job, id: "unrelated-job", pid: 456 };
    return Effect.gen(function* () {
      const client = yield* AlbedoClient.AlbedoClient;
      const result = yield* client.stopJob(sessionId, job.id).pipe(Effect.result);
      if (mode === "confirmed" || mode === "lost_ack" || mode === "already_finished")
        expect(result).toMatchObject({
          _tag: "Success",
          success: { kernel: { running_jobs: [other], live_job_count: 1 } },
        });
      else
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { reason: "operation_unconfirmed" },
        });
      expect(writes).toBe(mode === "unreported" || mode === "already_finished" ? 0 : 1);
    }).pipe(
      Effect.provide(
        daemon((request) => {
          if (request.method === "POST") {
            writes++;
            expect(new URL(request.url).pathname).toBe(
              `/extensions/run/sessions/${sessionId}/jobs/native%2Fcell%2Fjob/stop`,
            );
            return mode === "lost_ack"
              ? lost(request)
              : reply(
                  request,
                  { stopped: mode === "wrong_job" ? other.id : job.id },
                  mode === "ack_only" ? 202 : 200,
                );
          }
          const stopped = writes > 0 || mode === "already_finished";
          return reply(request, {
            ...session(),
            kernel: {
              ...session().kernel,
              state: "attached",
              instance_id:
                writes > 0 && mode === "replaced_kernel" ? "another-kernel" : "original-kernel",
              running_jobs: mode === "unreported" ? null : stopped ? [other] : [job, other],
              live_job_count: mode === "unreported" ? null : stopped ? 1 : 2,
            },
          });
        }),
      ),
    );
  });
  it.effect.each([
    "confirmed",
    "lost_ack",
    "running",
    "kernel_attached",
    "pending_input",
    "root",
    "ack_only",
  ] as const)("checks native helper cleanup when close is %s", (mode) => {
    let writes = 0;
    const original = { ...session(), parent_id: mode === "root" ? null : "native-parent" };
    return Effect.gen(function* () {
      const client = yield* AlbedoClient.AlbedoClient;
      const result = yield* client.closeAgent(sessionId).pipe(Effect.result);
      if (mode === "confirmed" || mode === "lost_ack")
        expect(result).toMatchObject({
          _tag: "Success",
          success: { closed: true, kernel: { state: "none" } },
        });
      else
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { reason: mode === "root" ? "invalid_submission" : "operation_unconfirmed" },
        });
      expect(writes).toBe(mode === "root" ? 0 : 1);
    }).pipe(
      Effect.provide(
        daemon((request) => {
          if (request.method === "POST") {
            writes++;
            expect(new URL(request.url).pathname).toBe(
              `/extensions/agents/sessions/${sessionId}/close`,
            );
            return mode === "lost_ack"
              ? lost(request)
              : reply(request, true, mode === "ack_only" ? 202 : 200);
          }
          if (writes === 0) return reply(request, original);
          return reply(request, {
            ...original,
            closed: true,
            status: {
              ...original.status,
              phase: mode === "running" ? "running" : "idle",
              run_id: mode === "running" ? "native-run" : null,
            },
            kernel: {
              ...original.kernel,
              state: mode === "kernel_attached" ? "attached" : "none",
              instance_id: mode === "kernel_attached" ? "live-kernel" : null,
            },
            pending_inputs:
              mode === "pending_input"
                ? [
                    {
                      id: identity.inputId,
                      kind: "message",
                      preview: { text: "pending", transcript_count: 1, truncated: false },
                      accepted_at: "2026-10-02T14:00:00Z",
                      acceptance_order: 1,
                      delivery: "pending",
                      blocking_reason: null,
                    },
                  ]
                : [],
          });
        }),
      ),
    );
  });
  it.effect.each(["accepted", "lost_ack", "conflict"] as const)(
    "preserves the observed configuration validator when a selection write is %s",
    (mode) => {
      const choice = { provider_profile: "team/account", model: "model/a", effort: "high" };
      let stored = {
        id: identity.sessionId,
        workspace: "/workspace",
        provider_profile: "old",
        model: "old",
        effort: "inherit",
      };
      let writes = 0;
      return Effect.gen(function* () {
        const client = yield* AlbedoClient.AlbedoClient;
        const result = yield* client
          .configureSession(identity.sessionId, choice)
          .pipe(Effect.result);
        if (mode === "conflict") {
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "AlbedoHttpError", status: 412 },
          });
          expect(stored.provider_profile).toBe("old");
        } else expect(stored).toMatchObject(choice);
        expect(writes).toBe(1);
      }).pipe(
        Effect.provide(
          daemon((request) => {
            expect(new URL(request.url).searchParams.get("view")).toBe("configuration");
            if (request.method === "GET")
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json(stored, { headers: { etag: '"observed-config"' } }),
                ),
              );
            expect(request.method).toBe("PATCH");
            expect(request.headers["if-match"]).toBe('"observed-config"');
            expect(request.headers["content-type"]).toBe("application/merge-patch+json");
            writes++;
            if (mode === "conflict")
              return reply(request, problem(412, "precondition_failed"), 412);
            stored = { ...stored, ...choice };
            return mode === "lost_ack"
              ? lost(request)
              : reply(request, { session: stored, move: null });
          }),
        ),
      );
    },
  );
  it.effect(
    "reads profile and model identities without exposing credentials or creating sessions",
    () =>
      Effect.gen(function* () {
        const client = yield* AlbedoClient.AlbedoClient;
        const settings = yield* client.readProviderSettings;
        expect(settings).toEqual({
          default_profile: "team/account",
          profiles: {
            "team/account": { extension: "openai", model: "model/a", effort: null, has_key: true },
          },
        });
        const page = yield* client.readModels({
          profile: "team/account",
          model: "model/a",
          next: "page+/=",
        });
        expect(page.items[0]?.id).toBe("model/a");
        expect(page.items[0]?.efforts).toEqual([{ id: "native-effort", label: "Native effort" }]);
      }).pipe(
        Effect.provide(
          daemon((request) => {
            const url = new URL(request.url);
            if (url.pathname === "/settings") {
              expect(url.searchParams.get("group")).toBe("providers");
              return reply(request, {
                default_profile: "team/account",
                profiles: {
                  "team/account": {
                    extension: "openai",
                    model: "model/a",
                    effort: null,
                    has_key: true,
                    api_key: "must-not-reach-T3-clients",
                  },
                },
              });
            }
            expect(url.pathname).toBe("/models");
            expect(url.searchParams.get("provider_profile")).toBe("team/account");
            expect(url.searchParams.get("model")).toBe("model/a");
            expect(url.searchParams.get("next")).toBe("page+/=");
            return reply(request, {
              next: null,
              items: [
                {
                  id: "model/a",
                  label: "Model A",
                  efforts: [{ id: "native-effort", label: "Native effort" }],
                  effective_context_tokens: null,
                  max_context_tokens: null,
                  max_output_tokens: null,
                  input_modalities: ["text"],
                },
              ],
            });
          }),
        ),
      ),
  );

  it.effect(
    "interrupts only the captured run and waiting prefix without treating acknowledgement as completion",
    () =>
      Effect.gen(function* () {
        const client = yield* AlbedoClient.AlbedoClient;
        const acknowledged = yield* client.interruptSession(sessionId, {
          run_id: "captured-run",
          through_input_order: 3,
        });
        expect(acknowledged.state).toBe("requested");
        expect(
          yield* Effect.flip(
            client.interruptSession(sessionId, { run_id: "another-run", through_input_order: 3 }),
          ),
        ).toMatchObject({ reason: "identity_mismatch" });
      }).pipe(
        Effect.provide(
          daemon((request) => {
            expect(request.method).toBe("POST");
            expect(new URL(request.url).pathname).toBe(`/sessions/${sessionId}/interrupt`);
            expect(request.body._tag).toBe("Uint8Array");
            if (request.body._tag === "Uint8Array") {
              expect(JSON.parse(new TextDecoder().decode(request.body.body))).toMatchObject({
                through_input_order: 3,
              });
            }
            return reply(request, {
              run_id: "captured-run",
              state: "requested",
              cancelled_input_ids: [],
              warnings: [],
            });
          }),
        ),
      ),
  );

  it.effect("decodes fragmented SSE and sends both native replay cursor components", () =>
    Effect.gen(function* () {
      const client = yield* AlbedoClient.AlbedoClient;
      const batches = yield* client
        .watchSession(sessionId, { generation, sequence: 0 })
        .pipe(Stream.runCollect);
      expect(batches).toEqual([{ generation, cursor: 1, events: [textEvent(1)] }]);
    }).pipe(
      Effect.provide(
        daemon((request) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("after_generation")).toBe(generation);
          expect(url.searchParams.get("after_seq")).toBe("0");
          expect(request.headers["last-event-id"]).toBeUndefined();
          const bytes = new TextEncoder().encode(
            `: heartbeat\n\ndata: ${JSON.stringify({ generation, cursor: 1, events: [textEvent(1)] })}\n\n`,
          );
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                new ReadableStream({
                  start(controller) {
                    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
                    controller.close();
                  },
                }),
                { headers: { "content-type": "text/event-stream; charset=utf-8" } },
              ),
            ),
          );
        }),
      ),
    ),
  );

  it.effect(
    "reads native families and watches collection invalidations without replay cursors",
    () =>
      Effect.gen(function* () {
        const client = yield* AlbedoClient.AlbedoClient;
        expect(
          yield* client.readSessions({ familyId: sessionId, next: "opaque+/=?" }),
        ).toMatchObject({
          items: [{ id: sessionId }],
          next: null,
          family: { root_id: sessionId, revision: "revision-1" },
        });
        expect(yield* client.watchSessions().pipe(Stream.runCollect)).toEqual([
          {
            events: [
              { type: "ready", data: {} },
              { type: "reset", data: { reason: "initial" } },
            ],
          },
          {
            events: [
              {
                type: "invalidate",
                data: { urls: ["/sessions"], session_ids: [sessionId], scope_dirty: true },
              },
            ],
          },
          { events: [{ type: "overflow", data: {} }] },
        ]);
      }).pipe(
        Effect.provide(
          daemon((request) => {
            const url = new URL(request.url);
            expect(url.pathname).toBe("/sessions");
            expect(url.searchParams.get("scope")).toBe("all");
            if (request.headers.accept !== "text/event-stream") {
              expect(url.searchParams.get("family_id")).toBe(sessionId);
              expect(url.searchParams.get("next")).toBe("opaque+/=?");
              return reply(request, {
                items: [session()],
                next: null,
                family: { root_id: sessionId, revision: "revision-1" },
              });
            }
            expect([...url.searchParams.keys()]).toEqual(["scope"]);
            expect(request.headers["last-event-id"]).toBeUndefined();
            const batches = [
              {
                events: [
                  { type: "ready", data: {} },
                  { type: "reset", data: { reason: "initial" } },
                ],
              },
              {
                events: [
                  {
                    type: "invalidate",
                    data: { urls: ["/sessions"], session_ids: [sessionId], scope_dirty: true },
                  },
                ],
              },
              { events: [{ type: "overflow", data: {} }] },
            ];
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(
                  batches.map((batch) => `data: ${JSON.stringify(batch)}\n\n`).join(""),
                  { headers: { "content-type": "text/event-stream" } },
                ),
              ),
            );
          }),
        ),
      ),
  );

  it.effect.each([
    [
      "invalid known event",
      `data: ${JSON.stringify({ generation, cursor: 1, events: [{ type: "text", sequence: 1, data: {} }] })}\n\n`,
      "invalid_response",
    ],
    ["unterminated oversized frame", `data: ${"x".repeat(1048577)}`, "response_too_large"],
    [
      "UTF-8 frame over byte bound",
      `data: ${JSON.stringify({ ...reset(), extra: "界".repeat(400000) })}\n\n`,
      "response_too_large",
    ],
  ] as const)("rejects %s", ([, body, reason]) =>
    Effect.gen(function* () {
      const client = yield* AlbedoClient.AlbedoClient;
      const error = yield* Effect.flip(client.watchSession(sessionId).pipe(Stream.runCollect));
      expect(error).toMatchObject({ _tag: "AlbedoProtocolError", reason });
    }).pipe(
      Effect.provide(
        daemon((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(body, { headers: { "content-type": "text/event-stream" } }),
            ),
          ),
        ),
      ),
    ),
  );

  it.effect("checks session identity and retains opaque history paging tokens", () =>
    Effect.gen(function* () {
      const client = yield* AlbedoClient.AlbedoClient;
      expect(yield* client.readSession(sessionId)).toEqual(session());
      expect(yield* client.readHistory(sessionId, { next: "opaque+/=?", before: 123 })).toEqual(
        session().history,
      );
      expect(yield* Effect.flip(client.readSession("wrong"))).toMatchObject({
        reason: "identity_mismatch",
      });
    }).pipe(
      Effect.provide(
        daemon((request) => {
          const url = new URL(request.url);
          if (url.pathname.endsWith("/history")) {
            expect(url.searchParams.get("next")).toBe("opaque+/=?");
            expect(url.searchParams.get("before")).toBe("123");
            return reply(request, session().history);
          }
          return reply(request, session());
        }),
      ),
    ),
  );

  it.effect("hydrates a complete UTF-8 prefix before exposing staged output", () =>
    Effect.gen(function* () {
      const outputs = yield* ActiveOutput.stage({
        ...session(),
        active_output: [
          {
            message_id: "message-1",
            run_id: "run-1",
            kind: "text",
            elapsed_ms: null,
            bytes: 6,
            text: null,
            reference: {
              url: `/sessions/${sessionId}/active-output/content-1?snapshot=fixed%2Bcutoff`,
              field: "text",
              bytes: 6,
            },
          },
        ],
      });
      expect(yield* outputs[0]!.content.pipe(Stream.runCollect)).toEqual(["é🌍"]);
    }).pipe(
      Effect.scoped,
      Effect.provide([
        NodeServices.layer,
        daemon((request) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("snapshot")).toBe("fixed+cutoff");
          const second = url.searchParams.get("next") === "second-page";
          return reply(request, {
            entry_id: "content-1",
            next: second ? null : "second-page",
            parts: [
              {
                field: "text",
                offset_bytes: second ? 2 : 0,
                encoding: "utf8",
                text: second ? "🌍" : "é",
                complete: second,
              },
            ],
          });
        }),
      ]),
    ),
  );

  it.effect.each([
    [
      "wrong byte offset",
      {
        entry_id: "content-1",
        next: null,
        parts: [{ field: "text", offset_bytes: 1, encoding: "utf8", text: "abc", complete: true }],
      },
    ],
    [
      "incomplete final page",
      {
        entry_id: "content-1",
        next: null,
        parts: [{ field: "text", offset_bytes: 0, encoding: "utf8", text: "abc", complete: false }],
      },
    ],
    [
      "short cutoff",
      {
        entry_id: "content-1",
        next: null,
        parts: [{ field: "text", offset_bytes: 0, encoding: "utf8", text: "ab", complete: true }],
      },
    ],
    [
      "excess cutoff",
      {
        entry_id: "content-1",
        next: null,
        parts: [{ field: "text", offset_bytes: 0, encoding: "utf8", text: "abcd", complete: true }],
      },
    ],
    [
      "wrong identity",
      {
        entry_id: "other-content",
        next: null,
        parts: [{ field: "text", offset_bytes: 0, encoding: "utf8", text: "abc", complete: true }],
      },
    ],
  ] as const)("rejects %s without installing the reset", ([, page]) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        ActiveOutput.stage({
          ...session(),
          active_output: [
            {
              message_id: "message-1",
              run_id: "run-1",
              kind: "text",
              elapsed_ms: null,
              bytes: 3,
              text: null,
              reference: {
                url: `/sessions/${sessionId}/active-output/content-1?snapshot=fixed`,
                field: "text",
                bytes: 3,
              },
            },
          ],
        }),
      );
      expect(error).toMatchObject({ _tag: "AlbedoProtocolError" });
    }).pipe(
      Effect.scoped,
      Effect.provide([NodeServices.layer, daemon((request) => reply(request, page))]),
    ),
  );

  it.effect.each(["history", "active-output"] as const)(
    "rejects %s references outside the owning session before attaching the daemon credential",
    (kind) =>
      Effect.gen(function* () {
        const client = yield* AlbedoClient.AlbedoClient;
        const read = kind === "history" ? client.readHistoryContent : client.readActiveContent;
        for (const resource of [
          "https://other.example/sessions/1",
          `/sessions/other/${kind}/1`,
          `/sessions/${sessionId}/${kind}/../secret?snapshot=signed`,
        ]) {
          expect(yield* Effect.flip(read(sessionId, resource))).toMatchObject({
            reason: "identity_mismatch",
          });
        }
      }).pipe(
        Effect.provide(
          daemon(() => Effect.die("Reference must be rejected before making an HTTP request")),
        ),
      ),
  );
  it.effect(
    "reads history references with their own paging tokens and checks returned identity",
    () =>
      Effect.gen(function* () {
        const client = yield* AlbedoClient.AlbedoClient;
        const resource = `/sessions/${sessionId}/history/2`;
        expect(yield* client.readHistoryContent(sessionId, resource, "page+/=")).toMatchObject({
          entry_id: "2",
        });
        expect(yield* Effect.flip(client.readHistoryContent(sessionId, resource))).toMatchObject({
          reason: "identity_mismatch",
        });
      }).pipe(
        Effect.provide(
          daemon((request) => {
            const url = new URL(request.url);
            expect(url.pathname).toBe(`/sessions/${sessionId}/history/2`);
            return reply(request, {
              entry_id: url.searchParams.get("next") === "page+/=" ? "2" : "another-entry",
              parts: [],
              next: null,
            });
          }),
        ),
      ),
  );
});

describe("Albedo daemon attachment", () => {
  it.effect(
    "checks identity and capabilities without creating sessions or stopping the daemon",
    () =>
      Effect.gen(function* () {
        const client = yield* AlbedoClient.AlbedoClient;
        expect(client.server.instance_id).toBe("daemon-1");
      }).pipe(Effect.provide(daemon(() => Effect.die("Attachment must be read-only")))),
  );

  it.effect.each([
    ["old protocol", { ...server, protocol: 2 }, "incompatible"],
    [
      "old replay",
      { ...server, capabilities: { ...server.capabilities, session_replay: 1 } },
      "incompatible",
    ],
    ["missing durable inputs", { ...server, capabilities: { session_replay: 2 } }, "incompatible"],
    ["draining daemon", { ...server, state: "draining" }, "draining"],
    ["replaced daemon", { ...server, instance_id: "daemon-2" }, "target_changed"],
    ["reused endpoint", { ...server, pid: 456 }, "target_changed"],
  ] as const)("refuses %s", ([, info, reason]) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        AlbedoClient.AlbedoClient.pipe(
          Effect.provide(daemon(() => Effect.die("Unexpected mutation"), info)),
        ),
      );
      expect(error).toMatchObject({ _tag: "AlbedoConnectionError", reason });
      expect(error.message).not.toContain(discovery.token);
    }),
  );

  it.effect("rejects malformed discovery before making any HTTP request", () =>
    Effect.gen(function* () {
      let requests = 0;
      const error = yield* Effect.flip(
        AlbedoClient.AlbedoClient.pipe(
          Effect.provide(
            AlbedoClient.layer("/albedo").pipe(
              Layer.provide([
                Path.layer,
                FileSystem.layerNoop({
                  readFileString: () => Effect.succeed('{"port":0,"token":"secret"}'),
                }),
                Layer.succeed(
                  HttpClient.HttpClient,
                  HttpClient.make(() => {
                    requests++;
                    return Effect.die("Invalid discovery must not connect");
                  }),
                ),
              ]),
            ),
          ),
        ),
      );
      expect(error).toMatchObject({ _tag: "AlbedoConnectionError", reason: "invalid_discovery" });
      expect(requests).toBe(0);
    }),
  );
});

describe("Albedo session creation recovery", () => {
  const creation = {
    sessionId: identity.sessionId,
    request: {
      kind: "new" as const,
      workspace: "/worktrees/worker-1",
      name: null,
      provider_profile: "profile-1",
      model: "model-1",
      effort: "high",
    },
  };
  const session = { id: identity.sessionId, creation: { submitted: creation.request } };

  it.effect.each(["lost_response", "precondition_failed"] as const)(
    "recovers %s using immutable creation provenance",
    (failure) => {
      let writes = 0;
      return Effect.gen(function* () {
        const client = yield* AlbedoClient.AlbedoClient;
        expect(yield* client.createSession(creation)).toEqual(session);
        expect(writes).toBe(1);
      }).pipe(
        Effect.provide(
          daemon((request) => {
            if (request.method === "GET") return reply(request, session);
            writes++;
            expect(request.headers["if-none-match"]).toBe("*");
            return failure === "lost_response"
              ? lost(request)
              : reply(request, problem(412, "precondition_failed"), 412);
          }),
        ),
      );
    },
  );

  it.effect.each([
    { name: "workspace", submitted: { ...creation.request, workspace: "/another-worktree" } },
    { name: "model", submitted: { ...creation.request, model: "another-model" } },
    { name: "profile", submitted: { ...creation.request, provider_profile: "another-profile" } },
    { name: "effort", submitted: { ...creation.request, effort: "low" } },
  ])("rejects mismatched $name even when mutable settings now match", ({ submitted }) =>
    Effect.gen(function* () {
      const client = yield* AlbedoClient.AlbedoClient;
      const error = yield* Effect.flip(client.createSession(creation));
      expect(error).toMatchObject({ _tag: "AlbedoProtocolError", reason: "identity_mismatch" });
    }).pipe(
      Effect.provide(
        daemon((request) =>
          request.method === "PUT"
            ? reply(request, problem(412, "precondition_failed"), 412)
            : reply(request, { ...session, ...creation.request, creation: { submitted } }),
        ),
      ),
    ),
  );

  it.effect("refuses sessions without creation provenance", () =>
    Effect.gen(function* () {
      const client = yield* AlbedoClient.AlbedoClient;
      const error = yield* Effect.flip(client.createSession(creation));
      expect(error).toMatchObject({ _tag: "AlbedoProtocolError", reason: "identity_mismatch" });
    }).pipe(
      Effect.provide(
        daemon((request) =>
          request.method === "PUT"
            ? reply(request, problem(412, "precondition_failed"), 412)
            : reply(request, { ...session, creation: null }),
        ),
      ),
    ),
  );

  it.effect("keeps the same session identity and request after an unknown creation", () => {
    const bodies: Array<HttpClientRequest.HttpClientRequest["body"]> = [];
    return Effect.gen(function* () {
      const client = yield* AlbedoClient.AlbedoClient;
      expect(yield* client.createSession(creation)).toEqual(session);
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toEqual(bodies[1]);
    }).pipe(
      Effect.provide(
        daemon((request) => {
          expect(new URL(request.url).pathname).toBe(`/sessions/${identity.sessionId}`);
          if (request.method === "GET")
            return reply(request, problem(404, "session_not_found"), 404);
          bodies.push(request.body);
          return bodies.length === 1 ? lost(request) : reply(request, session, 201);
        }),
      ),
    );
  });
});

describe("Albedo durable input recovery", () => {
  it.effect(
    "recovers an accepted input after its acknowledgement is lost, without resubmitting",
    () => {
      let admissions = 0;
      let reads = 0;
      return Effect.gen(function* () {
        const client = yield* AlbedoClient.AlbedoClient;
        const result = yield* client.submitInput(submission);
        expect(result).toEqual(input);
        expect(result.turn).toBeNull();
        expect(admissions).toBe(1);
        expect(reads).toBe(1);
      }).pipe(
        Effect.provide(
          daemon((request) => {
            if (request.method === "PUT") {
              admissions++;
              return lost(request);
            }
            reads++;
            return reply(request, input);
          }),
        ),
      );
    },
  );

  it.effect("retries unknown admission once with the identical identity and bytes", () => {
    const writes: Array<{ url: string; body: HttpClientRequest.HttpClientRequest["body"] }> = [];
    return Effect.gen(function* () {
      const client = yield* AlbedoClient.AlbedoClient;
      expect(yield* client.submitInput(submission)).toEqual(input);
      expect(writes).toHaveLength(2);
      expect(writes[1]).toEqual(writes[0]);
      expect(writes[0]?.url).toContain(`/inputs/${identity.inputId}`);
    }).pipe(
      Effect.provide(
        daemon((request) => {
          if (request.method === "GET") return reply(request, problem(404, "input_not_found"), 404);
          writes.push({ url: request.url, body: request.body });
          return writes.length === 1 ? lost(request) : reply(request, input, 202);
        }),
      ),
    );
  });

  it.effect("keeps expired identities unresolved without allocating or resending work", () => {
    let writes = 0;
    return Effect.gen(function* () {
      const client = yield* AlbedoClient.AlbedoClient;
      const error = yield* Effect.flip(client.submitInput(submission));
      expect(error).toMatchObject({
        _tag: "AlbedoHttpError",
        status: 410,
        code: "identity_expired",
      });
      expect(writes).toBe(1);
    }).pipe(
      Effect.provide(
        daemon((request) => {
          if (request.method === "GET")
            return reply(request, problem(410, "identity_expired"), 410);
          writes++;
          return lost(request);
        }),
      ),
    );
  });

  it.effect("bounds recovery if the repeated PUT also loses its response", () => {
    let writes = 0;
    let reads = 0;
    return Effect.gen(function* () {
      const client = yield* AlbedoClient.AlbedoClient;
      const error = yield* Effect.flip(client.submitInput(submission));
      expect(error).toMatchObject({ _tag: "AlbedoTransportError", operation: "input.submit" });
      expect({ writes, reads }).toEqual({ writes: 2, reads: 1 });
    }).pipe(
      Effect.provide(
        daemon((request) => {
          if (request.method === "GET") {
            reads++;
            return reply(request, problem(404, "input_not_found"), 404);
          }
          writes++;
          return lost(request);
        }),
      ),
    );
  });

  it.effect("retains queue rejection instead of retrying it when capacity changes", () => {
    let requests = 0;
    const rejected = {
      ...input,
      admission: "rejected",
      http_status: 429,
      problem: problem(429, "queue_full"),
      accepted_at: null,
      acceptance_order: null,
      delivery: null,
    };
    return Effect.gen(function* () {
      const client = yield* AlbedoClient.AlbedoClient;
      expect(yield* client.submitInput(submission)).toEqual(rejected);
      expect(requests).toBe(1);
    }).pipe(
      Effect.provide(
        daemon((request) => {
          requests++;
          return reply(
            request,
            { ...problem(429, "queue_full"), decision: { kind: "input", input: rejected } },
            429,
          );
        }),
      ),
    );
  });

  it.effect.each(["running", "completed", "interrupted", "failed", "abandoned"] as const)(
    "preserves %s independently of admission and delivery",
    (state) => {
      const receipt = {
        ...input,
        delivery: "committed",
        transcript_position: 1,
        turn: {
          id: "turn-1",
          state,
          started_at: input.accepted_at,
          ended_at: state === "running" ? null : input.accepted_at,
          outcome: null,
        },
      };
      return Effect.gen(function* () {
        const client = yield* AlbedoClient.AlbedoClient;
        expect((yield* client.readInput(identity))?.turn?.state).toBe(state);
      }).pipe(Effect.provide(daemon((request) => reply(request, receipt))));
    },
  );

  it.effect.each([
    ["another input", { ...input, id: "another-input" }],
    ["another session", { ...input, session_id: "another-session" }],
    ["contradictory rejection", { ...input, admission: "rejected" }],
    ["missing outcome", { ...input, turn: undefined }],
  ] as const)("refuses %s instead of settling the requested input", ([, receipt]) =>
    Effect.gen(function* () {
      const client = yield* AlbedoClient.AlbedoClient;
      const error = yield* Effect.flip(client.readInput(identity));
      expect(error._tag).toBe("AlbedoProtocolError");
    }).pipe(Effect.provide(daemon((request) => reply(request, receipt)))),
  );

  it.effect("bounds metadata bodies before decoding JSON", () =>
    Effect.gen(function* () {
      const client = yield* AlbedoClient.AlbedoClient;
      const error = yield* Effect.flip(client.readInput(identity));
      expect(error).toMatchObject({ _tag: "AlbedoProtocolError", reason: "response_too_large" });
    }).pipe(
      Effect.provide(
        daemon((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response("x".repeat(1048577)))),
        ),
      ),
    ),
  );
});

describe("Albedo cancellation", () => {
  it.effect.each(["interrupt_requested", "shared_running", "not_pending"] as const)(
    "does not treat %s as stopped execution",
    (result) =>
      Effect.gen(function* () {
        const client = yield* AlbedoClient.AlbedoClient;
        const cancellation = yield* client.cancelInput(identity);
        expect(cancellation.result).toBe(result);
        expect(cancellation.input.turn?.state).toBe("running");
      }).pipe(
        Effect.provide(
          daemon((request) => {
            expect(request.url).toContain(`/inputs/${identity.inputId}/cancel`);
            return reply(request, {
              result,
              input: {
                ...input,
                delivery: "committed",
                transcript_position: 1,
                turn: {
                  id: "turn-1",
                  state: "running",
                  started_at: input.accepted_at,
                  ended_at: null,
                  outcome: null,
                },
              },
            });
          }),
        ),
      ),
  );
});
