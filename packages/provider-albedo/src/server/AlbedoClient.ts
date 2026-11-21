import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Sse from "effect/encoding/Sse";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as Protocol from "./protocol.ts";
import * as SessionProtocol from "./sessionProtocol.ts";

const Operation = Schema.Literals([
  "server",
  "session.create",
  "session.read",
  "session.configure",
  "session.compact",
  "session.compaction.read",
  "session.watch",
  "collection.read",
  "collection.watch",
  "session.interrupt",
  "agent.close",
  "job.stop",
  "history.read",
  "content.read",
  "settings.read",
  "models.read",
  "input.read",
  "input.submit",
  "input.cancel",
]);
type Operation = typeof Operation.Type;
const decodeDiscovery = Schema.decodeEffect(Schema.fromJsonString(Protocol.Discovery));
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeSubmission = Schema.decodeEffect(Protocol.Submission);
const encodeInputRequest = Schema.encodeEffect(Schema.fromJsonString(Protocol.InputRequest));
const decodeSessionCreation = Schema.decodeEffect(Protocol.SessionCreation);
const decodeNewSession = Schema.decodeUnknownEffect(Protocol.NewSession);
const encodeNewSession = Schema.encodeEffect(Schema.fromJsonString(Protocol.NewSession));
const decodeBatch = Schema.decodeEffect(Schema.fromJsonString(SessionProtocol.Batch));
const decodeCollectionBatch = Schema.decodeEffect(
  Schema.fromJsonString(SessionProtocol.CollectionBatch),
);
const encodeInterrupt = Schema.encodeEffect(Schema.fromJsonString(Protocol.InterruptRequest));
const encodeSelection = Schema.encodeEffect(Schema.fromJsonString(Protocol.SessionSelection));

export class AlbedoTransportError extends Schema.TaggedError<AlbedoTransportError>()(
  "AlbedoTransportError",
  { operation: Operation, cause: Schema.Defect() },
) {
  override get message() {
    return "The Albedo daemon could not be reached. Accepted work may still be running; reconnect to recover its outcome.";
  }
}

export class AlbedoProtocolError extends Schema.TaggedError<AlbedoProtocolError>()(
  "AlbedoProtocolError",
  {
    operation: Operation,
    reason: Schema.Literals([
      "invalid_response",
      "response_too_large",
      "identity_mismatch",
      "invalid_submission",
      "legacy_gif",
      "operation_unconfirmed",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    if (this.reason === "legacy_gif")
      return "Albedo no longer accepts GIF attachments. If this existing request has no daemon receipt, resend it with a PNG, JPEG, or WebP image.";
    if (this.reason === "operation_unconfirmed")
      return "Albedo has not confirmed that the requested work stopped. Keep this assignment unresolved and reconcile the same work before reassigning it.";
    return "Albedo returned an incompatible response. Check daemon compatibility before retrying the existing input.";
  }
}

export class AlbedoHttpError extends Schema.TaggedError<AlbedoHttpError>()("AlbedoHttpError", {
  operation: Operation,
  status: Schema.Number,
  code: Protocol.Problem.fields.code,
}) {
  override get message() {
    if (this.status === 401 || this.status === 403) {
      return "Albedo rejected the daemon credential. Check the configured Albedo home and reconnect.";
    }
    if (this.status === 410) {
      return "Albedo no longer retains this identity. Its outcome is unresolved; do not submit it as new work.";
    }
    return `Albedo rejected ${this.operation} (HTTP ${this.status}, ${this.code}).`;
  }
}

export class AlbedoConnectionError extends Schema.TaggedError<AlbedoConnectionError>()(
  "AlbedoConnectionError",
  {
    reason: Schema.Literals([
      "discovery_unavailable",
      "invalid_discovery",
      "incompatible",
      "draining",
      "target_changed",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    switch (this.reason) {
      case "discovery_unavailable":
        return "Albedo daemon discovery is unavailable. Start Albedo on this environment and check its home directory.";
      case "invalid_discovery":
        return "Albedo's daemon.json is invalid. Check the configured Albedo home directory.";
      case "incompatible":
        return "Albedo requires protocol 4, durable inputs, session replay v2, collection invalidation, and tool progress. Update the daemon before connecting.";
      case "draining":
        return "Albedo is draining. Reconnect after the daemon is ready.";
      case "target_changed":
        return "Albedo's identity changed since discovery. Reconnect using the current daemon.json.";
    }
  }
}

type RequestError = AlbedoTransportError | AlbedoProtocolError | AlbedoHttpError;
type InputIdentity = Pick<Protocol.Submission, "sessionId" | "inputId">;

export class AlbedoClient extends Context.Service<
  AlbedoClient,
  {
    readonly server: typeof Protocol.Server.Type;
    readonly readProviderSettings: Effect.Effect<
      typeof Protocol.ProviderSettings.Type,
      RequestError
    >;
    readonly readModels: (input: {
      readonly profile: string;
      readonly next?: string;
      readonly model?: string;
    }) => Effect.Effect<typeof Protocol.ModelPage.Type, RequestError>;
    readonly createSession: (
      creation: Protocol.SessionCreation,
    ) => Effect.Effect<typeof Protocol.SessionIdentity.Type, RequestError>;
    readonly readSession: (
      sessionId: string,
    ) => Effect.Effect<SessionProtocol.Session, RequestError>;
    readonly compactSession: (
      sessionId: string,
      actionId: string,
    ) => Effect.Effect<Protocol.CompactionReceipt, RequestError>;
    readonly readCompaction: (
      sessionId: string,
      actionId: string,
    ) => Effect.Effect<Protocol.CompactionReceipt | null, RequestError>;
    readonly readSessions: (input?: {
      readonly familyId?: string;
      readonly next?: string;
    }) => Effect.Effect<typeof SessionProtocol.SessionPage.Type, RequestError>;
    readonly watchSessions: () => Stream.Stream<SessionProtocol.CollectionBatch, RequestError>;
    readonly closeAgent: (
      sessionId: string,
    ) => Effect.Effect<SessionProtocol.Session, RequestError>;
    readonly stopJob: (
      sessionId: string,
      jobId: string,
    ) => Effect.Effect<SessionProtocol.Session, RequestError>;
    readonly configureSession: (
      sessionId: string,
      selection: typeof Protocol.SessionSelection.Type,
    ) => Effect.Effect<void, RequestError>;
    readonly readHistory: (
      sessionId: string,
      page?: { readonly before?: number; readonly after?: number; readonly next?: string },
    ) => Effect.Effect<typeof SessionProtocol.HistoryPage.Type, RequestError>;
    readonly readActiveContent: (
      sessionId: string,
      resource: string,
      next?: string,
    ) => Effect.Effect<typeof SessionProtocol.ContentPage.Type, RequestError>;
    readonly readHistoryContent: (
      sessionId: string,
      resource: string,
      next?: string,
    ) => Effect.Effect<typeof SessionProtocol.ContentPage.Type, RequestError>;
    readonly watchSession: (
      sessionId: string,
      cursor?: SessionProtocol.Cursor,
    ) => Stream.Stream<SessionProtocol.Batch, RequestError>;
    readonly interruptSession: (
      sessionId: string,
      captured: typeof Protocol.InterruptRequest.Type,
    ) => Effect.Effect<typeof Protocol.Interruption.Type, RequestError>;
    readonly readInput: (
      identity: InputIdentity,
    ) => Effect.Effect<Protocol.Input | null, RequestError>;
    readonly submitInput: (
      submission: Protocol.Submission,
    ) => Effect.Effect<Protocol.Input, RequestError>;
    readonly cancelInput: (
      identity: InputIdentity,
    ) => Effect.Effect<typeof Protocol.Cancellation.Type, RequestError>;
  }
>()("@t3tools/provider-albedo/server/AlbedoClient") {}

const decode = Effect.fn("AlbedoClient.decode")(function* <A>(
  schema: Schema.Decoder<A>,
  body: unknown,
  operation: Operation,
) {
  return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
    Effect.mapError(
      (cause) => new AlbedoProtocolError({ operation, reason: "invalid_response", cause }),
    ),
  );
});

const checkIdentity = Effect.fn("AlbedoClient.checkIdentity")(function* (
  input: Protocol.Input,
  identity: InputIdentity,
  operation: Operation,
) {
  if (input.id !== identity.inputId || input.session_id !== identity.sessionId) {
    return yield* new AlbedoProtocolError({ operation, reason: "identity_mismatch" });
  }
  return input;
});

const inputPath = (identity: InputIdentity) =>
  `/sessions/${encodeURIComponent(identity.sessionId)}/inputs/${encodeURIComponent(identity.inputId)}`;

const make = Effect.fn("AlbedoClient.make")(function* (homeDirectory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const discoveryText = yield* fs
    .readFileString(path.join(homeDirectory, "daemon.json"))
    .pipe(
      Effect.mapError(
        (cause) => new AlbedoConnectionError({ reason: "discovery_unavailable", cause }),
      ),
    );
  const discovery = yield* decodeDiscovery(discoveryText).pipe(
    Effect.mapError((cause) => new AlbedoConnectionError({ reason: "invalid_discovery", cause })),
  );
  const baseUrl = `http://127.0.0.1:${discovery.port}`;

  const request = Effect.fn("AlbedoClient.request")(
    function* (
      operation: Operation,
      method: "GET" | "PUT" | "POST" | "PATCH",
      resource: string,
      body?: string,
      headers?: Readonly<Record<string, string>>,
    ) {
      let req = HttpClientRequest.make(method)(baseUrl + resource).pipe(
        HttpClientRequest.bearerToken(discovery.token),
        HttpClientRequest.setHeader("accept", "application/json"),
        HttpClientRequest.setHeaders(headers ?? {}),
      );
      if (body !== undefined)
        req = HttpClientRequest.bodyText(
          req,
          body,
          method === "PATCH" ? "application/merge-patch+json" : "application/json",
        );
      const response = yield* http.execute(req);
      const limit = response.status >= 400 ? 65536 : 1048576;
      const chunks: Uint8Array[] = [];
      let size = 0;
      yield* response.stream.pipe(
        Stream.runForEach((chunk) => {
          size += chunk.byteLength;
          if (size > limit) {
            return Effect.fail(
              new AlbedoProtocolError({ operation, reason: "response_too_large" }),
            );
          }
          chunks.push(chunk);
          return Effect.void;
        }),
      );
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const text = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        catch: (cause) => new AlbedoProtocolError({ operation, reason: "invalid_response", cause }),
      });
      const json = yield* decodeJson(text).pipe(
        Effect.mapError(
          (cause) => new AlbedoProtocolError({ operation, reason: "invalid_response", cause }),
        ),
      );
      return { status: response.status, body: json, etag: response.headers.etag };
    },
    (effect, operation) =>
      effect.pipe(
        Effect.timeout(
          operation === "agent.close"
            ? "110 seconds"
            : operation === "job.stop"
              ? "20 seconds"
              : "10 seconds",
        ),
        Effect.catchTags({
          HttpClientError: (cause) => Effect.fail(new AlbedoTransportError({ operation, cause })),
          TimeoutError: (cause) => Effect.fail(new AlbedoTransportError({ operation, cause })),
        }),
      ),
  );

  const rejectResponse = Effect.fn("AlbedoClient.rejectResponse")(function* (
    response: { status: number; body: unknown },
    operation: Operation,
  ) {
    const problem = yield* decode(Protocol.Problem, response.body, operation);
    if (problem.status !== response.status) {
      return yield* new AlbedoProtocolError({ operation, reason: "invalid_response" });
    }
    return yield* new AlbedoHttpError({ operation, status: response.status, code: problem.code });
  });

  const response = yield* request("server", "GET", "/server");
  if (response.status !== 200) return yield* rejectResponse(response, "server");
  const server = yield* decode(Protocol.Server, response.body, "server");
  if (
    server.protocol !== 4 ||
    (server.capabilities.durable_inputs ?? 0) < 1 ||
    (server.capabilities.session_replay ?? 0) < 2 ||
    (server.capabilities.collection_invalidation ?? 0) < 1 ||
    (server.capabilities.tool_progress ?? 0) < 1
  ) {
    return yield* new AlbedoConnectionError({ reason: "incompatible" });
  }
  if (server.state !== "ready") return yield* new AlbedoConnectionError({ reason: "draining" });
  if (
    (discovery.instance_id !== undefined && server.instance_id !== discovery.instance_id) ||
    (server.pid !== undefined && server.pid !== discovery.pid)
  ) {
    return yield* new AlbedoConnectionError({ reason: "target_changed" });
  }

  const readInput = Effect.fn("AlbedoClient.readInput")(function* (identity: InputIdentity) {
    const response = yield* request("input.read", "GET", inputPath(identity));
    if (response.status === 404) {
      const problem = yield* decode(Protocol.Problem, response.body, "input.read");
      if (problem.status !== 404) {
        return yield* new AlbedoProtocolError({
          operation: "input.read",
          reason: "invalid_response",
        });
      }
      if (problem.code === "input_unknown") return null;
    }
    if (response.status !== 200) return yield* rejectResponse(response, "input.read");
    const input = yield* decode(Protocol.Input, response.body, "input.read");
    return yield* checkIdentity(input, identity, "input.read");
  });

  const createSession = Effect.fn("AlbedoClient.createSession")(function* (
    creation: Protocol.SessionCreation,
  ) {
    const intent = yield* decodeSessionCreation(creation, { onExcessProperty: "error" }).pipe(
      Effect.mapError(
        (cause) =>
          new AlbedoProtocolError({
            operation: "session.create",
            reason: "invalid_submission",
            cause,
          }),
      ),
    );
    const body = yield* encodeNewSession(intent.request).pipe(
      Effect.mapError(
        (cause) =>
          new AlbedoProtocolError({
            operation: "session.create",
            reason: "invalid_submission",
            cause,
          }),
      ),
    );
    const resource = `/sessions/${encodeURIComponent(intent.sessionId)}`;
    const verify = Effect.fn("AlbedoClient.verifyCreation")(function* (received: unknown) {
      const session = yield* decode(Protocol.SessionIdentity, received, "session.create");
      if (session.id !== intent.sessionId || session.creation === null) {
        return yield* new AlbedoProtocolError({
          operation: "session.create",
          reason: "identity_mismatch",
        });
      }
      const submitted = yield* decodeNewSession(session.creation.submitted, {
        onExcessProperty: "error",
      }).pipe(
        Effect.mapError(
          (cause) =>
            new AlbedoProtocolError({
              operation: "session.create",
              reason: "identity_mismatch",
              cause,
            }),
        ),
      );
      const encoded = yield* encodeNewSession(submitted).pipe(
        Effect.mapError(
          (cause) =>
            new AlbedoProtocolError({
              operation: "session.create",
              reason: "invalid_response",
              cause,
            }),
        ),
      );
      if (encoded !== body) {
        return yield* new AlbedoProtocolError({
          operation: "session.create",
          reason: "identity_mismatch",
        });
      }
      return session;
    });
    const read = Effect.gen(function* () {
      const response = yield* request("session.read", "GET", resource);
      if (response.status === 404) {
        const problem = yield* decode(Protocol.Problem, response.body, "session.read");
        if (problem.status === 404) return null;
      }
      if (response.status !== 200) return yield* rejectResponse(response, "session.read");
      return yield* verify(response.body);
    });
    const send = Effect.gen(function* () {
      const response = yield* request("session.create", "PUT", resource, body, {
        "if-none-match": "*",
      });
      if (response.status === 201) return yield* verify(response.body);
      if (response.status === 412) {
        const session = yield* read;
        if (session !== null) return session;
      }
      return yield* rejectResponse(response, "session.create");
    });
    return yield* send.pipe(
      Effect.catchTags({
        AlbedoTransportError: () =>
          read.pipe(
            Effect.filterOrElse(
              (session): session is typeof Protocol.SessionIdentity.Type => session !== null,
              () => send,
            ),
          ),
      }),
    );
  });

  const submitInput = Effect.fn("AlbedoClient.submitInput")(function* (
    submission: Protocol.Submission,
  ) {
    // The caller must persist this identity and intent before dispatch; recovery never allocates one.
    const intent = yield* decodeSubmission(submission, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(
        (cause) =>
          new AlbedoProtocolError({
            operation: "input.submit",
            reason: "invalid_submission",
            cause,
          }),
      ),
    );
    if (
      intent.request.kind === "message" &&
      intent.request.images?.some(({ mime_type }) => mime_type === "image/gif")
    ) {
      return yield* new AlbedoProtocolError({
        operation: "input.submit",
        reason: "legacy_gif",
      });
    }
    const body = yield* encodeInputRequest(intent.request).pipe(
      Effect.mapError(
        (cause) =>
          new AlbedoProtocolError({
            operation: "input.submit",
            reason: "invalid_submission",
            cause,
          }),
      ),
    );
    const send = Effect.gen(function* () {
      const response = yield* request("input.submit", "PUT", inputPath(intent), body);
      if (response.status === 202) {
        const input = yield* decode(Protocol.Input, response.body, "input.submit");
        if (input.admission !== "accepted") {
          return yield* new AlbedoProtocolError({
            operation: "input.submit",
            reason: "invalid_response",
          });
        }
        return yield* checkIdentity(input, intent, "input.submit");
      }
      // Rejected admission is a durable decision carried inside the HTTP problem.
      const envelope = yield* decode(
        Schema.Struct({ decision: Schema.optional(Protocol.InputDecision) }),
        response.body,
        "input.submit",
      );
      if (envelope.decision !== undefined) {
        const input = envelope.decision.input;
        if (
          input.admission !== "rejected" ||
          input.http_status !== response.status ||
          input.problem.status !== response.status
        ) {
          return yield* new AlbedoProtocolError({
            operation: "input.submit",
            reason: "invalid_response",
          });
        }
        return yield* checkIdentity(input, intent, "input.submit");
      }
      return yield* rejectResponse(response, "input.submit");
    });
    const input = yield* send.pipe(
      Effect.catchTags({
        AlbedoTransportError: () =>
          readInput(intent).pipe(
            Effect.filterOrElse(
              (known): known is Protocol.Input => known !== null,
              () => send,
            ),
          ),
      }),
    );
    if (input.kind !== intent.request.kind) {
      return yield* new AlbedoProtocolError({
        operation: "input.submit",
        reason: "identity_mismatch",
      });
    }
    return input;
  });

  const cancelInput = Effect.fn("AlbedoClient.cancelInput")(function* (identity: InputIdentity) {
    const response = yield* request("input.cancel", "POST", `${inputPath(identity)}/cancel`, "{}");
    if (response.status !== 200) return yield* rejectResponse(response, "input.cancel");
    const result = yield* decode(Protocol.Cancellation, response.body, "input.cancel");
    yield* checkIdentity(result.input, identity, "input.cancel");
    return result;
  });

  const interruptSession = Effect.fn("AlbedoClient.interruptSession")(function* (
    sessionId: string,
    captured: typeof Protocol.InterruptRequest.Type,
  ) {
    const body = yield* encodeInterrupt(captured).pipe(
      Effect.mapError(
        (cause) =>
          new AlbedoProtocolError({
            operation: "session.interrupt",
            reason: "invalid_submission",
            cause,
          }),
      ),
    );
    const response = yield* request(
      "session.interrupt",
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/interrupt`,
      body,
    );
    if (response.status !== 200) return yield* rejectResponse(response, "session.interrupt");
    const result = yield* decode(Protocol.Interruption, response.body, "session.interrupt");
    if (result.run_id !== captured.run_id) {
      return yield* new AlbedoProtocolError({
        operation: "session.interrupt",
        reason: "identity_mismatch",
      });
    }
    return result;
  });

  const readSession = Effect.fn("AlbedoClient.readSession")(function* (sessionId: string) {
    const response = yield* request(
      "session.read",
      "GET",
      `/sessions/${encodeURIComponent(sessionId)}`,
    );
    if (response.status !== 200) return yield* rejectResponse(response, "session.read");
    const session = yield* decode(SessionProtocol.Session, response.body, "session.read");
    if (session.id !== sessionId) {
      return yield* new AlbedoProtocolError({
        operation: "session.read",
        reason: "identity_mismatch",
      });
    }
    return session;
  });

  const readProviderSettings = Effect.gen(function* () {
    const response = yield* request("settings.read", "GET", "/settings/providers");
    if (response.status !== 200) return yield* rejectResponse(response, "settings.read");
    return yield* decode(Protocol.ProviderSettings, response.body, "settings.read");
  });

  const readModels = Effect.fn("AlbedoClient.readModels")(function* (input: {
    readonly profile: string;
    readonly next?: string;
    readonly model?: string;
  }) {
    const query = new URLSearchParams({ provider_profile: input.profile });
    if (input.next !== undefined) query.set("next", input.next);
    if (input.model !== undefined) query.set("model", input.model);
    const response = yield* request("models.read", "GET", `/models?${query}`);
    if (response.status !== 200) return yield* rejectResponse(response, "models.read");
    return yield* decode(Protocol.ModelPage, response.body, "models.read");
  });

  const closeAgent = Effect.fn("AlbedoClient.closeAgent")(function* (sessionId: string) {
    const before = yield* readSession(sessionId);
    if (before.parent_id === null && before.started_by === null)
      return yield* new AlbedoProtocolError({
        operation: "agent.close",
        reason: "invalid_submission",
      });
    const confirmed = (native: SessionProtocol.Session) =>
      native.closed &&
      native.status.phase === "idle" &&
      native.status.run_id === null &&
      native.kernel.state === "none" &&
      native.kernel.instance_id === null &&
      native.kernel.live_job_count === 0 &&
      native.kernel.running_jobs?.length === 0 &&
      native.pending_inputs.length === 0;
    const response = yield* request(
      "agent.close",
      "POST",
      `/extensions/agents/sessions/${encodeURIComponent(sessionId)}/close`,
      "{}",
    ).pipe(
      Effect.catchTags({
        AlbedoTransportError: Effect.fn("AlbedoClient.reconcileAgentClose")(function* (cause) {
          const after = yield* readSession(sessionId);
          if (!confirmed(after)) return yield* cause;
          return null;
        }),
      }),
    );
    if (response !== null) {
      if (response.status >= 400) return yield* rejectResponse(response, "agent.close");
      if (response.status !== 200 || response.body !== true)
        return yield* new AlbedoProtocolError({
          operation: "agent.close",
          reason: "operation_unconfirmed",
        });
    }
    const after = yield* readSession(sessionId);
    if (!confirmed(after))
      return yield* new AlbedoProtocolError({
        operation: "agent.close",
        reason: "operation_unconfirmed",
      });
    return after;
  });

  const stopJob = Effect.fn("AlbedoClient.stopJob")(function* (sessionId: string, jobId: string) {
    const before = yield* readSession(sessionId);
    const confirmed = (native: SessionProtocol.Session) =>
      native.kernel.state !== "lost" &&
      (native.kernel.instance_id === before.kernel.instance_id || native.kernel.state === "none") &&
      native.kernel.live_job_count !== null &&
      native.kernel.running_jobs !== null &&
      native.kernel.live_job_count === native.kernel.running_jobs.length &&
      !native.kernel.running_jobs.some((job) => job.id === jobId);
    const unconfirmed = () =>
      new AlbedoProtocolError({ operation: "job.stop", reason: "operation_unconfirmed" });
    if (!before.kernel.running_jobs?.some((job) => job.id === jobId)) {
      if (confirmed(before)) return before;
      return yield* unconfirmed();
    }
    const response = yield* request(
      "job.stop",
      "POST",
      `/extensions/run/sessions/${encodeURIComponent(sessionId)}/jobs/${encodeURIComponent(jobId)}/stop`,
      "{}",
    ).pipe(
      Effect.catchTags({
        AlbedoTransportError: Effect.fn("AlbedoClient.reconcileJobStop")(function* (cause) {
          const after = yield* readSession(sessionId);
          if (!confirmed(after)) return yield* cause;
          return null;
        }),
      }),
    );
    if (response !== null) {
      if (response.status >= 400) return yield* rejectResponse(response, "job.stop");
      if (response.status !== 200) return yield* unconfirmed();
      const result = yield* decode(
        Schema.Struct({ stopped: Schema.String }),
        response.body,
        "job.stop",
      );
      if (result.stopped !== jobId) return yield* unconfirmed();
    }
    const after = yield* readSession(sessionId);
    if (!confirmed(after)) return yield* unconfirmed();
    return after;
  });

  const readHistory = Effect.fn("AlbedoClient.readHistory")(function* (
    sessionId: string,
    page?: { readonly before?: number; readonly after?: number; readonly next?: string },
  ) {
    const query = new URLSearchParams();
    if (page?.before !== undefined) query.set("before", String(page.before));
    if (page?.after !== undefined) query.set("after", String(page.after));
    if (page?.next !== undefined) query.set("next", page.next);
    const response = yield* request(
      "history.read",
      "GET",
      `/sessions/${encodeURIComponent(sessionId)}/history?${query}`,
    );
    if (response.status !== 200) return yield* rejectResponse(response, "history.read");
    return yield* decode(SessionProtocol.HistoryPage, response.body, "history.read");
  });

  const readContent = Effect.fn("AlbedoClient.readContent")(function* (
    kind: "active-output" | "history",
    sessionId: string,
    resource: string,
    next?: string,
  ) {
    const prefix = `/sessions/${encodeURIComponent(sessionId)}/${kind}/`;
    const url = yield* Effect.try({
      try: () => new URL(resource, baseUrl),
      catch: (cause) =>
        new AlbedoProtocolError({ operation: "content.read", reason: "invalid_response", cause }),
    });
    const suffix = url.pathname.slice(prefix.length);
    if (
      !resource.startsWith(prefix) ||
      url.origin !== baseUrl ||
      !url.pathname.startsWith(prefix) ||
      !suffix ||
      suffix.includes("/") ||
      url.hash ||
      (kind === "active-output" ? !url.searchParams.get("snapshot") : url.search !== "")
    ) {
      return yield* new AlbedoProtocolError({
        operation: "content.read",
        reason: "identity_mismatch",
      });
    }
    if (next !== undefined) url.searchParams.set("next", next);
    const response = yield* request("content.read", "GET", url.pathname + url.search);
    if (response.status !== 200) return yield* rejectResponse(response, "content.read");
    const page = yield* decode(SessionProtocol.ContentPage, response.body, "content.read");
    if (page.entry_id !== suffix) {
      return yield* new AlbedoProtocolError({
        operation: "content.read",
        reason: "identity_mismatch",
      });
    }
    return page;
  });
  const readActiveContent = (sessionId: string, resource: string, next?: string) =>
    readContent("active-output", sessionId, resource, next);
  const readHistoryContent = (sessionId: string, resource: string, next?: string) =>
    readContent("history", sessionId, resource, next);

  const configureSession = Effect.fn("AlbedoClient.configureSession")(function* (
    sessionId: string,
    selection: typeof Protocol.SessionSelection.Type,
  ) {
    const resource = `/sessions/${encodeURIComponent(sessionId)}/configuration`;
    const matches = (value: typeof Protocol.SessionConfiguration.Type) =>
      value.id === sessionId &&
      value.provider_profile === selection.provider_profile &&
      value.model === selection.model &&
      value.effort === selection.effort;
    const before = yield* request("session.configure", "GET", resource);
    if (before.status !== 200) return yield* rejectResponse(before, "session.configure");
    const current = yield* decode(Protocol.SessionConfiguration, before.body, "session.configure");
    if (current.id !== sessionId || before.etag === undefined)
      return yield* new AlbedoProtocolError({
        operation: "session.configure",
        reason: "identity_mismatch",
      });
    if (matches(current)) return;
    const body = yield* encodeSelection(selection).pipe(
      Effect.mapError(
        (cause) =>
          new AlbedoProtocolError({
            operation: "session.configure",
            reason: "invalid_submission",
            cause,
          }),
      ),
    );
    const response = yield* request("session.configure", "PATCH", resource, body, {
      "if-match": before.etag,
    }).pipe(
      Effect.catchTags({
        AlbedoTransportError: Effect.fn("AlbedoClient.reconcileSelection")(function* (cause) {
          const after = yield* request("session.configure", "GET", resource);
          if (after.status !== 200) return yield* cause;
          const confirmed = yield* decode(
            Protocol.SessionConfiguration,
            after.body,
            "session.configure",
          );
          if (!matches(confirmed)) return yield* cause;
          return null;
        }),
      }),
    );
    if (response === null) return;
    if (response.status !== 200) return yield* rejectResponse(response, "session.configure");
    const result = yield* decode(
      Protocol.SessionConfigurationChange,
      response.body,
      "session.configure",
    );
    if (!matches(result.resource.value))
      return yield* new AlbedoProtocolError({
        operation: "session.configure",
        reason: "identity_mismatch",
      });
  });

  const readSessions = Effect.fn("AlbedoClient.readSessions")(function* (input?: {
    readonly familyId?: string;
    readonly next?: string;
  }) {
    const query = new URLSearchParams({ scope: "all" });
    if (input?.familyId !== undefined) query.set("family_id", input.familyId);
    if (input?.next !== undefined) query.set("next", input.next);
    const response = yield* request("collection.read", "GET", `/sessions?${query}`);
    if (response.status !== 200) return yield* rejectResponse(response, "collection.read");
    return yield* decode(SessionProtocol.SessionPage, response.body, "collection.read");
  });

  const watch = <A>(
    resource: string,
    operation: "session.watch" | "collection.watch",
    decodeFrame: (data: string) => Effect.Effect<A, Schema.SchemaError>,
  ) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const req = HttpClientRequest.get(`${baseUrl}${resource}`).pipe(
          HttpClientRequest.bearerToken(discovery.token),
          HttpClientRequest.setHeader("accept", "text/event-stream"),
        );
        const response = yield* HttpClient.withScope(http)
          .execute(req)
          .pipe(Effect.timeout("10 seconds"));
        if (response.status !== 200) {
          return yield* new AlbedoHttpError({
            operation,
            status: response.status,
            code: "stream_rejected",
          });
        }
        if (response.headers["content-type"]?.split(";", 1)[0]?.trim() !== "text/event-stream") {
          return yield* new AlbedoProtocolError({
            operation,
            reason: "invalid_response",
          });
        }
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const decodeChunk = (chunk?: Uint8Array) =>
          Effect.try({
            try: () => decoder.decode(chunk, { stream: chunk !== undefined }),
            catch: (cause) =>
              new AlbedoProtocolError({
                operation,
                reason: "invalid_response",
                cause,
              }),
          });
        return response.stream.pipe(
          Stream.timeoutOrElse({
            duration: "45 seconds",
            orElse: () =>
              Stream.fail(new AlbedoTransportError({ operation, cause: "stream_silent" })),
          }),
          Stream.mapEffect(decodeChunk),
          Stream.concat(Stream.fromEffect(decodeChunk())),
          Stream.pipeThroughChannel(Sse.decode({ maxEventSize: 1048576 })),
          Stream.mapEffect((frame) => {
            if (new TextEncoder().encode(frame.data).byteLength > 1048576) {
              return Effect.fail(
                new AlbedoProtocolError({
                  operation,
                  reason: "response_too_large",
                }),
              );
            }
            return decodeFrame(frame.data).pipe(
              Effect.mapError(
                (cause) =>
                  new AlbedoProtocolError({
                    operation,
                    reason: "invalid_response",
                    cause,
                  }),
              ),
            );
          }),
        );
      }),
    ).pipe(
      Stream.catchTags({
        HttpClientError: (cause) => Stream.fail(new AlbedoTransportError({ operation, cause })),
        TimeoutError: (cause) => Stream.fail(new AlbedoTransportError({ operation, cause })),
        SseError: (cause) =>
          Stream.fail(
            new AlbedoProtocolError({
              operation,
              reason: "response_too_large",
              cause,
            }),
          ),
        Retry: (cause) => Stream.fail(new AlbedoTransportError({ operation, cause })),
      }),
    );
  const watchSession = (sessionId: string, cursor?: SessionProtocol.Cursor) => {
    const query = new URLSearchParams();
    if (cursor !== undefined) {
      query.set("after_generation", cursor.generation);
      query.set("after_seq", String(cursor.sequence));
    }
    const resource = `/sessions/${encodeURIComponent(sessionId)}/events`;
    return watch(
      cursor === undefined ? resource : `${resource}?${query}`,
      "session.watch",
      decodeBatch,
    );
  };

  const compactionPath = (sessionId: string, actionId: string) =>
    `/sessions/${encodeURIComponent(sessionId)}/compactions/${encodeURIComponent(actionId)}`;
  const decodeCompaction = Effect.fn("AlbedoClient.decodeCompaction")(function* (
    body: unknown,
    operation: "session.compact" | "session.compaction.read",
    sessionId: string,
    actionId: string,
  ) {
    const receipt = yield* decode(Protocol.CompactionReceipt, body, operation);
    if (receipt.id !== actionId || receipt.session_id !== sessionId) {
      return yield* new AlbedoProtocolError({ operation, reason: "identity_mismatch" });
    }
    return receipt;
  });

  return AlbedoClient.of({
    compactSession: Effect.fn("AlbedoClient.compactSession")(function* (sessionId, actionId) {
      const response = yield* request(
        "session.compact",
        "PUT",
        compactionPath(sessionId, actionId),
        "{}",
      );
      if (response.status !== 200 && response.status !== 202)
        return yield* rejectResponse(response, "session.compact");
      return yield* decodeCompaction(response.body, "session.compact", sessionId, actionId);
    }),
    readCompaction: Effect.fn("AlbedoClient.readCompaction")(function* (sessionId, actionId) {
      const response = yield* request(
        "session.compaction.read",
        "GET",
        compactionPath(sessionId, actionId),
      );
      if (response.status === 404) {
        const problem = yield* decode(Protocol.Problem, response.body, "session.compaction.read");
        if (problem.status === 404 && problem.code === "compaction_unknown") return null;
      }
      if (response.status !== 200)
        return yield* rejectResponse(response, "session.compaction.read");
      return yield* decodeCompaction(response.body, "session.compaction.read", sessionId, actionId);
    }),
    server,
    readProviderSettings,
    readModels,
    createSession,
    readSession,
    closeAgent,
    stopJob,
    readSessions,
    watchSessions: () => watch("/sessions?scope=all", "collection.watch", decodeCollectionBatch),
    configureSession,
    readHistory,
    readActiveContent,
    readHistoryContent,
    watchSession,
    readInput,
    submitInput,
    cancelInput,
    interruptSession,
  });
});

export const layer = (homeDirectory: string) => Layer.effect(AlbedoClient, make(homeDirectory));
