import * as Schema from "effect/Schema";
import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ChatAttachmentId } from "./chatAttachment.ts";
import { ProviderDriverKind } from "./providerInstance.ts";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "./auth.ts";

const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(120));
const Title = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
const Detail = TrimmedNonEmptyString.check(Schema.isMaxLength(2000));

export const CrewProjectScope = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
});
export type CrewProjectScope = typeof CrewProjectScope.Type;
export const CrewConversationRef = Schema.Struct({
  ...CrewProjectScope.fields,
  threadId: ThreadId,
});
export type CrewConversationRef = typeof CrewConversationRef.Type;

// The service resolves provenance from canonical messages, never from caller-supplied authorship.
export const CrewMessageRef = Schema.Struct({
  conversation: CrewConversationRef,
  messageId: MessageId,
  runId: Schema.NullOr(RunId),
  actor: Schema.Literals(["user", "agent", "system"]),
  sender: Schema.NullOr(CrewConversationRef),
});
export type CrewMessageRef = typeof CrewMessageRef.Type;
export const CrewAttachmentRef = Schema.Struct({
  message: CrewMessageRef,
  attachmentId: ChatAttachmentId,
});
export const CrewConversationContext = Schema.Struct({
  replyTo: Schema.NullOr(CrewMessageRef),
  sources: Schema.Array(CrewMessageRef).check(Schema.isMaxLength(20)),
  attachments: Schema.Array(CrewAttachmentRef).check(Schema.isMaxLength(100)),
});
export type CrewConversationContext = typeof CrewConversationContext.Type;

// Membership survives task completion and worker replacement; linking never changes thread lineage.
export const CrewWorkstream = Schema.Struct({
  conversation: CrewConversationRef,
  title: Title,
  status: Schema.Literals(["open", "resolved", "unlinked"]),
  linkedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CrewWorkstream = typeof CrewWorkstream.Type;
// Task grouping is stable across attempts and grants no execution ownership or review authority.
export const CrewWorkstreamTaskLink = Schema.Struct({
  workstream: CrewConversationRef,
  initiativeId: Id,
  taskId: Id,
});
export type CrewWorkstreamTaskLink = typeof CrewWorkstreamTaskLink.Type;

export const CrewConsultationReply = Schema.Struct({
  consultationId: Id,
  responseId: MessageId,
});
export const CrewConsultationRequest = Schema.Struct({
  id: Id,
  origin: CrewMessageRef,
  destination: CrewConversationRef,
  context: CrewConversationContext,
  replyTo: Schema.NullOr(CrewConsultationReply),
});
export type CrewConsultationRequest = typeof CrewConsultationRequest.Type;

export const CrewConsultationExchange = Schema.Struct({
  request: CrewMessageRef,
  response: CrewMessageRef,
  responseId: MessageId,
});
export type CrewConsultationExchange = typeof CrewConsultationExchange.Type;
export const CrewConsultationProgress = Schema.Union([
  Schema.Struct({ state: Schema.Literal("queued") }),
  Schema.Struct({ state: Schema.Literal("delivered"), request: CrewMessageRef }),
  Schema.Struct({ state: Schema.Literal("answered"), exchange: CrewConsultationExchange }),
  Schema.Struct({
    state: Schema.Literal("failed"),
    detail: Detail,
    request: Schema.NullOr(CrewMessageRef),
  }),
  Schema.Struct({ state: Schema.Literal("cancelled") }),
]);
export const CrewConsultation = Schema.Struct({
  ...CrewConsultationRequest.fields,
  deliveryId: CommandId,
  progress: CrewConsultationProgress,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CrewConsultation = typeof CrewConsultation.Type;

// Internal observations require authenticated source/run lookup before entering the command journal.
export const CrewConsultationObservation = Schema.Struct({
  scope: CrewProjectScope,
  consultationId: Id,
  deliveryId: CommandId,
  outcome: Schema.Union([
    Schema.Struct({ type: Schema.Literal("delivered"), request: CrewMessageRef }),
    Schema.Struct({ type: Schema.Literal("answered"), exchange: CrewConsultationExchange }),
    Schema.Struct({ type: Schema.Literal("failed"), detail: Detail }),
  ]),
});
export type CrewConsultationObservation = typeof CrewConsultationObservation.Type;

export const CrewTaskAssignmentRef = Schema.Struct({
  initiativeId: Id,
  taskId: Id,
  attemptId: Id,
  owner: CrewConversationRef,
});
export type CrewTaskAssignmentRef = typeof CrewTaskAssignmentRef.Type;
export const CrewHandoffOwnership = Schema.Union([
  Schema.Struct({ state: Schema.Literal("discussion-only") }),
  Schema.Struct({
    state: Schema.Literals(["required", "stopping", "failed", "unknown"]),
    assignment: CrewTaskAssignmentRef,
    stopDeliveryId: Schema.NullOr(CommandId),
  }),
  Schema.Struct({
    state: Schema.Literal("reconciled"),
    assignment: CrewTaskAssignmentRef,
    stopDeliveryId: CommandId,
    stoppedRunId: RunId,
    reconciledRevision: NonNegativeInt,
  }),
]);
export type CrewHandoffOwnership = typeof CrewHandoffOwnership.Type;
export const CrewHandoff = Schema.Struct({
  id: Id,
  origin: CrewMessageRef,
  destination: CrewConversationRef,
  context: CrewConversationContext,
  consultationId: Schema.NullOr(Id),
  explanation: CrewMessageRef,
  ownership: CrewHandoffOwnership,
  state: Schema.Literals(["proposed", "ready", "completed", "cancelled"]),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CrewHandoff = typeof CrewHandoff.Type;
export const CrewHandoffReconciliation = Schema.Struct({
  scope: CrewProjectScope,
  handoffId: Id,
  assignment: CrewTaskAssignmentRef,
  stopDeliveryId: CommandId,
  stoppedRunId: RunId,
  reconciledRevision: NonNegativeInt,
});
export type CrewHandoffReconciliation = typeof CrewHandoffReconciliation.Type;

export const CrewAttentionReason = Schema.Literals([
  "user-message",
  "result",
  "blocker",
  "routing",
  "question",
  "approval",
]);
export const CrewAttention = Schema.Struct({
  id: Id,
  source: CrewMessageRef,
  coordinator: CrewConversationRef,
  reason: CrewAttentionReason,
  correlationId: Schema.NullOr(Id),
  pendingRequest: Schema.NullOr(
    Schema.Struct({
      requestId: RuntimeRequestId,
      runId: RunId,
      responder: Schema.Literals(["user-only", "authorized-agent"]),
    }),
  ),
  progress: Schema.Union([
    Schema.Struct({ state: Schema.Literal("pending") }),
    Schema.Struct({ state: Schema.Literal("queued"), deliveryId: CommandId }),
    Schema.Struct({ state: Schema.Literal("delivered"), deliveryId: CommandId, runId: RunId }),
    Schema.Struct({ state: Schema.Literal("considered"), deliveryId: CommandId, runId: RunId }),
    Schema.Struct({
      state: Schema.Literal("failed"),
      deliveryId: CommandId,
      detail: Detail,
      runId: Schema.NullOr(RunId),
    }),
  ]),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CrewAttention = typeof CrewAttention.Type;
export const CrewAttentionObservation = Schema.Struct({
  scope: CrewProjectScope,
  attentionId: Id,
  deliveryId: CommandId,
  outcome: Schema.Union([
    Schema.Struct({ type: Schema.Literal("delivered"), runId: RunId }),
    Schema.Struct({ type: Schema.Literal("considered"), runId: RunId }),
    Schema.Struct({ type: Schema.Literal("failed"), detail: Detail }),
  ]),
});
export type CrewAttentionObservation = typeof CrewAttentionObservation.Type;

export const CrewConversationAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("workstream.link"), threadId: ThreadId, title: Title }),
  Schema.Struct({
    type: Schema.Literal("workstream.task"),
    initiativeId: Id,
    taskId: Id,
    threadId: Schema.NullOr(ThreadId),
  }),
  Schema.Struct({
    type: Schema.Literal("workstream.status"),
    threadId: ThreadId,
    status: CrewWorkstream.fields.status,
  }),
  Schema.Struct({ type: Schema.Literal("consultation.request"), request: CrewConsultationRequest }),
  Schema.Struct({
    type: Schema.Literal("consultation.request-from-message"),
    id: Id,
    originThreadId: Schema.optional(ThreadId),
    originMessageId: Schema.optional(MessageId),
    destinationThreadId: ThreadId,
    replyTo: Schema.optional(CrewConsultationReply),
  }),
  Schema.Struct({
    type: Schema.Literal("consultation.retry"),
    id: Id,
    previousDeliveryId: CommandId,
  }),
  Schema.Struct({ type: Schema.Literal("consultation.cancel"), id: Id }),
  Schema.Struct({ type: Schema.Literal("attention.retry"), id: Id, previousDeliveryId: CommandId }),
  Schema.Struct({
    type: Schema.Literal("handoff.propose"),
    id: Id,
    origin: CrewMessageRef,
    destination: CrewConversationRef,
    context: CrewConversationContext,
    explanation: CrewMessageRef,
    consultationId: Schema.NullOr(Id),
    assignment: Schema.NullOr(CrewTaskAssignmentRef),
  }),
  Schema.Struct({
    type: Schema.Literal("handoff.propose-from-attention"),
    id: Id,
    attentionId: Id,
    destinationThreadId: ThreadId,
    explanationMessageId: MessageId,
    taskId: Schema.optional(Id),
    consultationId: Schema.optional(Id),
  }),
  Schema.Struct({ type: Schema.Literal("handoff.complete"), id: Id }),
  Schema.Struct({ type: Schema.Literal("handoff.cancel"), id: Id }),
]);
export type CrewConversationAction = typeof CrewConversationAction.Type;

// Receipt lookup precedes revision validation; identical retries reuse commandId and return the receipt.
// Commit changes, receipts and outbox effects atomically through Crew; observations are internal-only.
export const CrewConversationCommand = Schema.Struct({
  scope: CrewProjectScope,
  commandId: CommandId,
  expectedRevision: NonNegativeInt,
  action: CrewConversationAction,
});
export type CrewConversationCommand = typeof CrewConversationCommand.Type;
export const CrewConversationReceipt = Schema.Struct({
  commandId: CommandId,
  revision: NonNegativeInt,
});
export type CrewConversationReceipt = typeof CrewConversationReceipt.Type;
export const CrewConversationQuery = Schema.Struct({
  scope: CrewProjectScope,
  collection: Schema.Literals([
    "workstreams",
    "task-links",
    "consultations",
    "handoffs",
    "attention",
  ]),
  threadId: Schema.optional(ThreadId),
  id: Schema.optional(Id),
  messageIds: Schema.optional(
    Schema.Array(MessageId).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  ),
  cursor: Schema.optional(TrimmedNonEmptyString),
  limit: Schema.optional(NonNegativeInt.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type CrewConversationQuery = typeof CrewConversationQuery.Type;
export const CrewConversationPage = Schema.Struct({
  scope: CrewProjectScope,
  revision: NonNegativeInt,
  workstreams: Schema.Array(CrewWorkstream).check(Schema.isMaxLength(100)),
  taskLinks: Schema.Array(CrewWorkstreamTaskLink).check(Schema.isMaxLength(100)),
  consultations: Schema.Array(CrewConsultation).check(Schema.isMaxLength(100)),
  handoffs: Schema.Array(CrewHandoff).check(Schema.isMaxLength(100)),
  attention: Schema.Array(CrewAttention).check(Schema.isMaxLength(100)),
  nextCursor: Schema.NullOr(TrimmedNonEmptyString),
});
export type CrewConversationPage = typeof CrewConversationPage.Type;

// Hard enforcement evidence is separate from the coordinator's behavioral role and provider availability.
export const CrewCoordinationCapability = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("enforced"),
    driver: ProviderDriverKind,
    policyVersion: Detail,
    filesystem: Schema.Literal("read-only"),
    process: Schema.Literal("restricted"),
    tools: Schema.Literal("allowlisted"),
    delegation: Schema.Literal("guarded-service"),
  }),
  Schema.Struct({
    state: Schema.Literal("unsupported"),
    driver: ProviderDriverKind,
    detail: Detail,
  }),
]);
export type CrewCoordinationCapability = typeof CrewCoordinationCapability.Type;
// Selecting this role does not claim that the adapter enforces an inability to implement.
export const CrewCoordinatorPolicy = Schema.Struct({
  role: Schema.Literal("coordination-only"),
  capability: CrewCoordinationCapability,
});
export type CrewCoordinatorPolicy = typeof CrewCoordinatorPolicy.Type;

export const CREW_CONVERSATION_REQUIRED_SCOPES = {
  query: AuthOrchestrationReadScope,
  command: AuthOrchestrationOperateScope,
} as const;
