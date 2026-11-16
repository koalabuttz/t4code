import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const Opaque = TrimmedNonEmptyString;
const OptionalText = Schema.optional(Schema.NullOr(Schema.String));
export const OutpostProject = Schema.Struct({
  id: Opaque,
  path: Schema.String,
  configuration_name: Schema.String,
});
export const OutpostSession = Schema.Struct({
  id: Opaque,
  project_id: Opaque,
  lifecycle_state: Schema.String,
  launch_mode: Schema.String,
  title: OptionalText,
  branch_name: OptionalText,
  observed_at: OptionalText,
  daemon_epoch: OptionalText,
  freshness: Schema.optional(Schema.String),
  busy: Schema.optional(Schema.NullOr(Schema.Boolean)),
  attention: Schema.optional(Schema.NullOr(Schema.Boolean)),
  availability: Schema.optional(
    Schema.Struct({
      read: Schema.optional(Schema.Boolean),
      history: Schema.optional(Schema.Boolean),
      stop: Schema.optional(Schema.Boolean),
      resume: Schema.optional(Schema.Boolean),
      reap: Schema.optional(Schema.Boolean),
    }),
  ),
});
export type OutpostSession = typeof OutpostSession.Type;
export const OutpostCatalog = Schema.Struct({
  version: Schema.Literal(1),
  fleet_epoch: Opaque,
  cursor: Opaque,
  generated_at: Schema.String,
  name: Schema.String,
  version_name: Schema.String,
  features: Schema.optional(Schema.Array(Schema.String)),
  projects: Schema.optional(Schema.Array(OutpostProject)),
  sessions: Schema.optional(Schema.Array(OutpostSession)),
});
export type OutpostCatalog = typeof OutpostCatalog.Type;
export const OutpostCatalogPage = Schema.Struct({
  catalog: OutpostCatalog,
  page: NonNegativeInt,
  page_count: NonNegativeInt,
  total_projects: NonNegativeInt,
  total_sessions: NonNegativeInt,
  expires_at: Schema.String,
  snapshot_cursor: Opaque,
  snapshot_token: Schema.optional(Schema.NullOr(Opaque)),
  truncated: Schema.optional(Schema.Boolean),
});
export const OutpostFleetEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("epoch_started"), fleet_epoch: Opaque, cursor: Opaque }),
  Schema.Struct({ type: Schema.Literal("catalog_snapshot"), catalog: OutpostCatalog }),
  Schema.Struct({ type: Schema.Literal("project_upsert"), project: OutpostProject }),
  Schema.Struct({ type: Schema.Literal("project_removed"), project_id: Opaque }),
  Schema.Struct({
    type: Schema.Literals(["session_upsert", "summary_changed"]),
    session: OutpostSession,
  }),
  Schema.Struct({ type: Schema.Literal("session_removed"), session_id: Opaque }),
  Schema.Struct({ type: Schema.Literal("heartbeat"), at: Schema.String }),
  Schema.Struct({ type: Schema.Literal("reset_required") }),
]);
export const OutpostFleetEvents = Schema.Struct({
  fleet_epoch: Opaque,
  cursor: Opaque,
  heartbeat_interval_secs: NonNegativeInt,
  events: Schema.optional(Schema.Array(OutpostFleetEvent)),
});
export const OutpostConnection = Schema.Struct({
  id: Opaque,
  label: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
});
export type OutpostConnection = typeof OutpostConnection.Type;
export const OutpostFleet = Schema.Struct({
  connection: OutpostConnection,
  status: Schema.Literals(["disconnected", "connecting", "connected", "stale"]),
  checkedAt: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  catalog: Schema.NullOr(OutpostCatalog),
});
export type OutpostFleet = typeof OutpostFleet.Type;
export const OutpostFleetList = Schema.Array(OutpostFleet);
export const OutpostConnectionSaveInput = Schema.Struct({
  id: Schema.optional(Opaque),
  label: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  token: Schema.optional(TrimmedNonEmptyString),
});
export type OutpostConnectionSaveInput = typeof OutpostConnectionSaveInput.Type;
export const OutpostConnectionInput = Schema.Struct({ connectionId: Opaque });
export const OutpostSessionInput = Schema.Struct({ connectionId: Opaque, sessionId: Opaque });
export type OutpostSessionInput = typeof OutpostSessionInput.Type;
export const OutpostSessionActionInput = Schema.Struct({
  ...OutpostSessionInput.fields,
  action: Schema.Literals(["stop", "resume", "reap"]),
});
export type OutpostSessionActionInput = typeof OutpostSessionActionInput.Type;
export const OutpostHistoryInput = Schema.Struct({
  ...OutpostSessionInput.fields,
  checkpoint: Schema.optional(Opaque),
  nextPage: Schema.optional(Opaque),
});
export type OutpostHistoryInput = typeof OutpostHistoryInput.Type;
export const OutpostHistoryItem = Schema.Struct({
  raw_index: NonNegativeInt,
  lineage: Opaque,
  attribution: Schema.Record(Schema.String, Schema.Unknown),
  body: Schema.Record(Schema.String, Schema.Unknown),
  emitted_at: OptionalText,
});
export const OutpostHistory = Schema.Struct({
  source_identity: Schema.String,
  page_number: NonNegativeInt,
  page_count: NonNegativeInt,
  page: Schema.Struct({
    checkpoint_id: Opaque,
    expires_at: Schema.String,
    items: Schema.Array(OutpostHistoryItem),
    total_items: NonNegativeInt,
    truncated: Schema.Boolean,
    next_page: Schema.optional(Schema.NullOr(Opaque)),
  }),
});
export type OutpostHistory = typeof OutpostHistory.Type;
export const OutpostAttachmentInput = Schema.Struct({
  ...OutpostSessionInput.fields,
  artifactId: Opaque,
  checkpoint: Opaque,
  offset: NonNegativeInt,
});
export type OutpostAttachmentInput = typeof OutpostAttachmentInput.Type;
export const OutpostAttachment = Schema.Struct({
  artifact_id: Opaque,
  media_type: Schema.String,
  total_length: NonNegativeInt,
  offset: NonNegativeInt,
  data_base64: Schema.String,
});
export type OutpostAttachment = typeof OutpostAttachment.Type;
export class OutpostError extends Schema.TaggedError<OutpostError>()("OutpostError", {
  code: Schema.Literals([
    "connection",
    "credentials",
    "http",
    "protocol",
    "unsupported",
    "storage",
    "missing",
  ]),
  status: Schema.optional(Schema.Number),
  remoteCode: Schema.optional(Schema.String),
}) {
  override get message(): string {
    switch (this.code) {
      case "credentials":
        return "An Outpost bearer token is required.";
      case "connection":
        return "Could not reach Outpost. Reconnect to try again.";
      case "http":
        return `Outpost rejected the request (HTTP ${this.status ?? 0}${this.remoteCode ? `, ${this.remoteCode}` : ""}).`;
      case "protocol":
        return "Outpost returned an unsupported or inconsistent response. Reconnect to refresh.";
      case "unsupported":
        return "This operation is not available for this Outpost session.";
      case "storage":
        return "Could not read or save Outpost connections on this environment.";
      case "missing":
        return "The Outpost connection or session no longer exists.";
    }
  }
}
