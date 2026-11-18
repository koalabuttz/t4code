import * as Schema from "effect/Schema";

// Albedo protocol 3, openapi.yaml at fb84ee05f9284c8820e1ae5eb3fceed464aafc23.
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const Counter = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const Positive = Counter.check(Schema.isGreaterThan(0));
const UuidV7 = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
);
const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
);
const Reason = Schema.Struct({
  code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  detail: Schema.String.check(Schema.isMaxLength(4096)),
});
const HttpFailureStatus = Schema.Int.check(Schema.isBetween({ minimum: 400, maximum: 599 }));

export const Discovery = Schema.Struct({
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  token: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  pid: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2147483647 })),
  instance_id: Schema.optional(Id),
});

export const Server = Schema.Struct({
  instance_id: Id,
  pid: Schema.optional(Discovery.fields.pid),
  protocol: Schema.Int,
  state: Schema.Literals(["ready", "draining"]),
  capabilities: Schema.Record(Schema.String, Positive),
  build: Schema.NullOr(Schema.String.check(Schema.isMaxLength(512))),
  digest: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))),
  api_digest: Schema.optional(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))),
  extensions: Schema.Array(Schema.Struct({ name: Id, version: Positive })).check(
    Schema.isMaxLength(200),
  ),
  quota: Schema.NullOr(Schema.Array(Schema.Unknown).check(Schema.isMaxLength(200))),
  notices: Schema.Array(
    Schema.Struct({
      id: Id,
      kind: Schema.Literals(["info", "warning", "migration"]),
      message: Schema.String.check(Schema.isMaxLength(4096)),
    }),
  ).check(Schema.isMaxLength(100)),
});

export const Problem = Schema.Struct({
  type: Schema.Literal("about:blank"),
  title: Schema.String.check(Schema.isMaxLength(256)),
  status: HttpFailureStatus,
  ...Reason.fields,
});

const Turn = Schema.Struct({
  id: Id,
  state: Schema.Literals(["running", "completed", "interrupted", "failed", "abandoned"]),
  started_at: Timestamp,
  ended_at: Schema.NullOr(Timestamp),
  outcome: Schema.NullOr(Reason),
});
const InputFields = {
  id: Id,
  session_id: Id,
  kind: Schema.Literals(["message", "continue", "skill", "command", "acp_prompt"]),
  blocking_reason: Schema.NullOr(Reason),
  transcript_position: Schema.NullOr(Counter),
  client_id: Schema.NullOr(Schema.String.check(Schema.isMaxLength(512))),
};

export const Input = Schema.Union([
  Schema.Struct({
    ...InputFields,
    admission: Schema.Literal("accepted"),
    http_status: Schema.Literal(202),
    problem: Schema.Null,
    accepted_at: Timestamp,
    acceptance_order: Positive,
    delivery: Schema.Literals(["pending", "committed", "cancelled"]),
    turn: Schema.NullOr(Turn),
  }),
  Schema.Struct({
    ...InputFields,
    admission: Schema.Literal("rejected"),
    http_status: HttpFailureStatus,
    problem: Problem,
    accepted_at: Schema.Null,
    acceptance_order: Schema.Null,
    delivery: Schema.Null,
    turn: Schema.Null,
  }),
]);
export type Input = typeof Input.Type;

export const InputDecision = Schema.Struct({ kind: Schema.Literal("input"), input: Input });
export const Cancellation = Schema.Struct({
  input: Input,
  result: Schema.Literals(["cancelled", "interrupt_requested", "shared_running", "not_pending"]),
});

export const InterruptRequest = Schema.Struct({
  run_id: Schema.NullOr(Id),
  through_input_order: Counter,
});
export const Interruption = Schema.Struct({
  run_id: Schema.NullOr(Id),
  state: Schema.Literals(["requested", "already_ended"]),
  cancelled_input_ids: Schema.Array(Id).check(Schema.isMaxLength(32)),
  warnings: Schema.Array(Reason).check(Schema.isMaxLength(100)),
});

const ClientId = Schema.optional(Schema.String.check(Schema.isMaxLength(512)));
export const InputRequest = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("message"),
    text: Schema.String.check(Schema.isMaxLength(1048576)),
    images: Schema.optional(
      Schema.Array(
        Schema.Struct({
          mime_type: Schema.Literals(["image/png", "image/jpeg", "image/gif", "image/webp"]),
          data: Schema.String,
        }),
      ).check(Schema.isMaxLength(10)),
    ),
    files: Schema.optional(
      Schema.Array(
        Schema.Struct({
          name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
          data: Schema.String,
        }),
      ).check(Schema.isMaxLength(10)),
    ),
    pastes: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(20))),
    client_id: ClientId,
  }),
  Schema.Struct({ kind: Schema.Literal("continue"), client_id: ClientId }),
  Schema.Struct({
    kind: Schema.Literal("skill"),
    candidate_id: Id,
    catalog_revision: Id,
    arguments: Schema.String.check(Schema.isMaxLength(1048576)),
    client_id: ClientId,
  }),
  Schema.Struct({
    kind: Schema.Literal("command"),
    command_id: Id,
    arguments: Schema.Json,
    client_id: ClientId,
  }),
]);

export const Submission = Schema.Struct({
  sessionId: Id,
  inputId: UuidV7,
  request: InputRequest,
});
export type Submission = typeof Submission.Type;

export const CompactionResult = Schema.Struct({
  selection_applied: Schema.Boolean,
  effective_strategy: Schema.NullOr(Id),
  state: Schema.Literals(["compacted", "unchanged", "failed"]),
  observation: Schema.NullOr(
    Schema.Struct({
      strategy: Schema.NullOr(Id),
      before_tokens: Schema.NullOr(Counter),
      after_tokens: Schema.NullOr(Counter),
      evicted_entries: Counter,
      summary: Schema.String.check(Schema.isMaxLength(32768)),
    }),
  ),
  failure: Schema.NullOr(Reason),
});

export const NewSession = Schema.Struct({
  kind: Schema.Literal("new"),
  workspace: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  name: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4096))),
  provider_profile: Schema.NullOr(Id),
  model: Schema.NullOr(Id),
  effort: Schema.NullOr(Schema.String.check(Schema.isMaxLength(100))),
  context_window: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100000000 })),
  ),
});
export const SessionCreation = Schema.Struct({ sessionId: UuidV7, request: NewSession });
export type SessionCreation = typeof SessionCreation.Type;

// Creation recovery needs provenance, not mutable workspace/model fields or the transcript.
export const SessionIdentity = Schema.Struct({
  id: Id,
  creation: Schema.NullOr(Schema.Struct({ submitted: Schema.Unknown })),
});

export const SessionSelection = Schema.Struct({
  provider_profile: Id,
  model: Id,
  effort: Schema.String.check(Schema.isMaxLength(100)),
});
export const SessionConfiguration = Schema.Struct({
  id: Id,
  workspace: Schema.String,
  provider_profile: Schema.NullOr(Id),
  model: Schema.NullOr(Id),
  effort: Schema.NullOr(Schema.String),
});

export const ProviderSettings = Schema.Struct({
  default_profile: Schema.NullOr(Id),
  profiles: Schema.Record(
    Id,
    Schema.Struct({
      extension: Id,
      model: Id,
      effort: Schema.NullOr(Schema.String.check(Schema.isMaxLength(100))),
      has_key: Schema.Boolean,
    }),
  ),
});

export const Model = Schema.Struct({
  id: Id,
  label: Schema.String.check(Schema.isMaxLength(256)),
  efforts: Schema.Array(
    Schema.Struct({
      id: Schema.String.check(Schema.isMaxLength(100)),
      label: Schema.String.check(Schema.isMaxLength(256)),
    }),
  ).check(Schema.isMaxLength(100)),
  default_effort: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(100)))),
  effective_context_tokens: Schema.NullOr(Counter),
  max_context_tokens: Schema.NullOr(Counter),
  max_output_tokens: Schema.NullOr(Counter),
  input_modalities: Schema.Array(Schema.String.check(Schema.isMaxLength(100))).check(
    Schema.isMaxLength(32),
  ),
});

export const ModelPage = Schema.Struct({
  items: Schema.Array(Model).check(Schema.isMaxLength(200)),
  next: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
});
