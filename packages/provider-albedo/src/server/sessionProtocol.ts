import * as Schema from "effect/Schema";
import * as Protocol from "./protocol.ts";

const Id = Protocol.Submission.fields.sessionId;
const Counter = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const Reason = Schema.Struct({
  code: Protocol.Problem.fields.code,
  detail: Protocol.Problem.fields.detail,
});
const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
);
const PageToken = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const Text = Schema.String.check(Schema.isMaxLength(262144));
// Native previews count Unicode scalars; JavaScript string.length counts UTF-16 units.
const scalarText = (maximum: number) =>
  Schema.String.check(
    Schema.makeFilter((value) => {
      let count = 0;
      for (let index = 0; index < value.length; index++) {
        if (++count > maximum) return false;
        if (value.codePointAt(index)! > 0xffff) index++;
      }
      return value.isWellFormed();
    }),
  );
const Generation = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{21}[AQgw]$/));
const ResourceUrl = Schema.String.check(
  Schema.isPattern(/^\/([^/#][^#]*)?$/),
  Schema.isMaxLength(16384),
);

export const Cursor = Schema.Struct({ generation: Generation, sequence: Counter });
export type Cursor = typeof Cursor.Type;
const Status = Schema.Struct({
  phase: Schema.Literals([
    "idle",
    "preparing",
    "generating",
    "running",
    "interrupting",
    "compacting",
  ]),
  run_id: Schema.NullOr(Id),
  interrupt_requested: Schema.Boolean,
  blocking_reason: Schema.NullOr(Reason),
});
const Progress = Schema.Struct({
  call_id: Id,
  tool_call_id: Schema.NullOr(Id),
  name: Schema.String.check(Schema.isMaxLength(100)),
  phase: Schema.Literals(["generating", "running"]),
  intent: Schema.Literals(["read", "search", "list", "run", "unknown"]),
  title: Schema.optional(Schema.NullOr(scalarText(160))),
  preview: Schema.optional(Schema.Struct({ offset_scalars: Counter, text: scalarText(512) })),
});
const Mail = Schema.Struct({
  mail_id: Id,
  sender_session_id: Schema.NullOr(Id),
  receiver_session_id: Id,
  kind: Schema.Literals(["task", "request", "message", "result", "unreviewed", "webhook", "event"]),
  external: Schema.Boolean,
  answer: Schema.Boolean,
  notifies: Schema.Boolean,
  bytes: Counter,
  sender_label: Schema.NullOr(Schema.String.check(Schema.isMaxLength(100))),
});
const Reference = Schema.Struct({
  url: ResourceUrl,
  field: Schema.String.check(Schema.isMaxLength(256)),
  bytes: Counter,
});
export const ActiveOutput = Schema.Struct({
  message_id: Id,
  run_id: Id,
  kind: Schema.Literals(["text", "thinking"]),
  bytes: Counter,
  elapsed_ms: Schema.NullOr(Counter),
  text: Schema.NullOr(Schema.String),
  reference: Schema.NullOr(Reference),
}).check(Schema.makeFilter((output) => (output.text === null) !== (output.reference === null)));

const Kernel = Schema.Struct({
  state: Schema.Literals(["none", "booting", "attached", "reattaching", "busy", "lost"]),
  stage: Schema.NullOr(Schema.Literals(["staging", "starting"])),
  build: Schema.NullOr(Schema.String),
  stale: Schema.Boolean,
  staleness_reasons: Schema.Array(Reason).check(Schema.isMaxLength(100)),
  live_job_count: Schema.NullOr(Counter),
  instance_id: Schema.NullOr(Id),
  running_jobs: Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        id: Id,
        pid: Schema.NullOr(Counter),
        command: Schema.String.check(Schema.isMaxLength(4096)),
        kind: Schema.Literals(["command", "cell"]),
        parent_id: Schema.NullOr(Id),
        started_at: Counter,
      }),
    ).check(Schema.isMaxLength(100)),
  ),
});
const Usage = Schema.Struct({
  model: Schema.NullOr(Id),
  observed_at: Schema.NullOr(Timestamp),
  prompt_tokens: Schema.NullOr(Counter),
  cached_prompt_tokens: Schema.NullOr(Counter),
  cache_write_tokens: Schema.NullOr(Counter),
  completion_tokens: Schema.NullOr(Counter),
  total_tokens: Schema.NullOr(Counter),
  context_window_tokens: Schema.NullOr(Counter),
  elapsed_ms: Schema.NullOr(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  tokens_per_second: Schema.NullOr(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  cache_ttl_seconds: Schema.NullOr(Counter),
  cache_fade: Schema.Array(
    Schema.Struct({ at: Timestamp, cached_tokens: Schema.NullOr(Counter) }),
  ).check(Schema.isMaxLength(200)),
});

const Content = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("text"), text: Text }),
  Schema.Struct({ kind: Schema.Literal("json"), field: Schema.String, value: Schema.Json }),
  Schema.Struct({ kind: Schema.Literal("reference"), reference: Reference }),
  Schema.Struct({
    kind: Schema.Literal("image"),
    image: Schema.Struct({
      mime_type: Schema.String,
      width: Counter,
      height: Counter,
      original_bytes: Counter,
      reference: Reference,
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("trace"),
    trace: Schema.Record(Schema.String, Schema.Json),
  }),
]);
export const HistoryEntry = Schema.Struct({
  id: Id,
  position: Counter,
  kind: Schema.Literals([
    "user",
    "assistant",
    "thinking",
    "tool_call",
    "tool_result",
    "note",
    "continuation",
    "compaction",
    "image_fit",
    "shell_command",
  ]),
  turn_type: Schema.Literals(["user", "agent", "webhook", "event", "scheduled", "continue"]),
  turn_id: Schema.NullOr(Id),
  input_id: Schema.NullOr(Id),
  created_at: Schema.NullOr(Timestamp),
  mail: Schema.NullOr(
    Schema.Struct({
      mail_id: Id,
      sender_session_id: Schema.NullOr(Id),
      sender_label: Schema.String,
      kind: Mail.fields.kind,
      external: Schema.Boolean,
      answer: Schema.Boolean,
    }),
  ),
  content: Schema.Array(Content).check(Schema.isMaxLength(200)),
  checkpoint_id: Schema.NullOr(Id),
  content_complete: Schema.Boolean,
  tool: Schema.NullOr(
    Schema.Struct({
      name: Schema.String,
      tool_call_id: Id,
      progress_call_id: Schema.NullOr(Id),
      status: Schema.Literals(["completed", "failed"]),
      title: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
  phase: Schema.optional(Schema.NullOr(Schema.Literals(["commentary", "final"]))),
  thinking_duration_ms: Schema.optional(Schema.NullOr(Counter)),
});
export const HistoryPage = Schema.Struct({
  items: Schema.Array(HistoryEntry).check(Schema.isMaxLength(200)),
  older: Schema.NullOr(PageToken),
  newer: Schema.NullOr(PageToken),
  high_water: Counter,
});
const Preview = Schema.Struct({
  text: scalarText(256),
  transcript_count: Counter,
  truncated: Schema.Boolean,
});
export const SessionSummary = Schema.Struct({
  id: Id,
  created_at: Schema.optional(Schema.NullOr(Timestamp)),
  name: Schema.String,
  workspace: Schema.String,
  parent_id: Schema.NullOr(Id),
  root_id: Id,
  role: Schema.String.check(Schema.isMaxLength(512)),
  started_by: Schema.NullOr(Id),
  address: Schema.NullOr(Schema.String),
  depth: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 })),
  closed: Schema.Boolean,
  provider_profile: Schema.NullOr(Id),
  model: Schema.NullOr(Id),
  effort: Schema.NullOr(Schema.String),
  status: Status,
  cursor: Schema.NullOr(Cursor),
  current_progress: Schema.Array(Progress).check(Schema.isMaxLength(32)),
});
export const SessionPage = Schema.Struct({
  items: Schema.Array(SessionSummary).check(Schema.isMaxLength(200)),
  next: Schema.NullOr(PageToken),
  family: Schema.optional(Schema.Struct({ root_id: Id, revision: Id })),
});
const collectionEvent = <const T extends string, F extends Schema.Struct.Fields>(
  type: T,
  fields: F,
) => Schema.Struct({ type: Schema.Literal(type), data: Schema.Struct(fields) });
export const CollectionBatch = Schema.Union([
  Schema.Struct({
    events: Schema.Tuple([
      collectionEvent("ready", {}),
      collectionEvent("reset", { reason: Schema.Literal("initial") }),
    ]),
  }),
  Schema.Struct({
    events: Schema.Array(
      Schema.Union([
        collectionEvent("invalidate", {
          urls: Schema.Array(ResourceUrl).check(Schema.isMaxLength(200)),
          session_ids: Schema.Array(Id).check(Schema.isMaxLength(200)),
          scope_dirty: Schema.Boolean,
        }),
        collectionEvent("activity", {
          session_id: Id,
          cursor: Cursor,
          status: Status,
          current_progress: SessionSummary.fields.current_progress,
        }),
        collectionEvent("mail", Mail.fields),
      ]),
    ).check(Schema.isMaxLength(256)),
  }),
  Schema.Struct({ events: Schema.Tuple([collectionEvent("overflow", {})]) }),
]);
export type CollectionBatch = typeof CollectionBatch.Type;
export const Session = Schema.Struct({
  ...SessionSummary.fields,
  creation: Protocol.SessionIdentity.fields.creation,
  pending_inputs: Schema.Array(
    Schema.Struct({
      id: Id,
      kind: Schema.Literals(["message", "continue", "skill", "command"]),
      preview: Preview,
      accepted_at: Timestamp,
      acceptance_order: Counter,
      delivery: Schema.Literal("pending"),
      blocking_reason: Schema.NullOr(Reason),
    }),
  ).check(Schema.isMaxLength(32)),
  input_order: Counter,
  kernel: Kernel,
  usage: Usage,
  history: HistoryPage,
  active_output: Schema.Array(ActiveOutput).check(Schema.isMaxLength(256)),
});
export type Session = typeof Session.Type;

const event = <const T extends string, F extends Schema.Struct.Fields>(type: T, fields: F) =>
  Schema.Struct({
    type: Schema.Literal(type),
    sequence: Counter,
    data: Schema.Struct(fields),
  });
const Glance = Schema.Struct({
  extension: Id,
  title: Schema.String,
  rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)).check(Schema.isMaxLength(12)),
  url: ResourceUrl,
  data: Schema.optional(Schema.Json),
});
export const Event = Schema.Union([
  event("status", Status.fields),
  event("input", { input: Protocol.Input }),
  event("text", { run_id: Id, message_id: Id, text: Text }),
  event("thinking", {
    run_id: Id,
    message_id: Id,
    text: Text,
    elapsed_ms: Schema.optional(Counter),
  }),
  event("message", {
    entry: HistoryEntry,
    replaces_live_ids: Schema.optional(Schema.Array(Id).check(Schema.isMaxLength(256))),
  }),
  event("tool_progress", { progress: Schema.NullOr(Progress) }),
  event("tool", {
    tool_call_id: Id,
    progress_call_id: Id,
    name: Schema.String,
    arguments: Schema.Json,
    result: Schema.Json,
    trace: Schema.NullOr(Schema.Record(Schema.String, Schema.Json)),
    content_complete: Schema.Boolean,
    reference: Schema.NullOr(Reference),
    title: Schema.optional(Schema.NullOr(Schema.String)),
    status: Schema.optional(Schema.Literals(["completed", "failed"])),
  }),
  event("note", { entry_id: Id, origin: Schema.String, text: Text, mail: Schema.NullOr(Mail) }),
  event("retry", { run_id: Id, attempt: Counter, reason: Reason, delay_ms: Counter }),
  event("usage", Usage.fields),
  event("committed", {
    high_water: Counter,
    replaces_all_live: Schema.Boolean,
    replaces_live_ids: Schema.Array(Id).check(Schema.isMaxLength(256)),
  }),
  event("turn_completed", {
    run_id: Id,
    state: Schema.Literals(["completed", "interrupted", "failed", "abandoned"]),
    input_ids: Schema.Array(Id).check(Schema.isMaxLength(200)),
    input_count: Counter,
    truncated: Schema.Boolean,
  }),
  event("error", {
    run_id: Schema.NullOr(Id),
    code: Protocol.Problem.fields.code,
    message: Protocol.Problem.fields.detail,
  }),
  event("invalidate", {
    kind: Schema.Literals(["session", "settings", "catalog", "context", "extension"]),
    url: ResourceUrl,
  }),
  event("kernel", { kernel: Kernel }),
  event("glances", { glances: Schema.Array(Glance).check(Schema.isMaxLength(16)) }),
  event("shell_command", { shell_command: Schema.Record(Schema.String, Schema.Json) }),
  event("side_question", {
    side_question: Schema.NullOr(Schema.Record(Schema.String, Schema.Json)),
  }),
  event("compacted", {
    strategy: Schema.NullOr(Schema.String),
    before_tokens: Schema.NullOr(Counter),
    after_tokens: Schema.NullOr(Counter),
    evicted_entries: Counter,
    summary: Schema.String.check(Schema.isMaxLength(32768)),
  }),
]);
export type Event = typeof Event.Type;
const Reset = Schema.Struct({
  type: Schema.Literal("reset"),
  data: Schema.Struct({
    reason: Schema.Literals(["initial", "generation_changed", "replay_unavailable", "recovery"]),
  }),
});
const Failure = Schema.Struct({ type: Schema.Literal("failure"), data: Reason });
export const Batch = Schema.Struct({
  generation: Generation,
  cursor: Counter,
  events: Schema.Array(Schema.Union([Reset, Failure, Event])).check(Schema.isMaxLength(256)),
  snapshot: Schema.optional(Session),
});
export type Batch = typeof Batch.Type;
export const ContentPage = Schema.Struct({
  entry_id: Id,
  next: Schema.NullOr(PageToken),
  parts: Schema.Array(
    Schema.Struct({
      field: Schema.String,
      offset_bytes: Counter,
      encoding: Schema.Literal("utf8"),
      text: Schema.String,
      complete: Schema.Boolean,
    }),
  ).check(Schema.isMaxLength(200)),
});
