import type {
  CrewAttention,
  CrewAttentionObservation,
  CrewConsultation,
  CrewConsultationObservation,
  CrewConsultationRequest,
  CrewCoordinationCapability,
  CrewConversationRef,
  CrewHandoff,
  CrewMessageRef,
  CrewProjectScope,
  CrewTaskAssignmentRef,
  CrewWorkstream,
} from "@t3tools/contracts/crewConversation";
import type {
  CommandId,
  IsoDateTime,
  OrchestrationV2AppThread,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import { isProviderNativeSubagentThread } from "@t3tools/contracts";

export const sameCrewProject = (a: CrewProjectScope, b: CrewProjectScope) =>
  a.environmentId === b.environmentId && a.projectId === b.projectId;

export const sameCrewConversation = (a: CrewConversationRef, b: CrewConversationRef) =>
  sameCrewProject(a, b) && a.threadId === b.threadId;

const sameMessage = (a: CrewMessageRef, b: CrewMessageRef) =>
  sameCrewConversation(a.conversation, b.conversation) &&
  a.messageId === b.messageId &&
  a.runId === b.runId &&
  a.actor === b.actor &&
  (a.sender === null
    ? b.sender === null
    : b.sender !== null && sameCrewConversation(a.sender, b.sender));

export function canLinkCrewWorkstream(
  scope: CrewProjectScope,
  threadEnvironmentId: CrewProjectScope["environmentId"],
  thread: Pick<OrchestrationV2AppThread, "id" | "projectId" | "creationSource" | "lineage">,
  coordinatorThreadId: ThreadId | null,
): boolean {
  return (
    sameCrewProject(scope, { environmentId: threadEnvironmentId, projectId: thread.projectId }) &&
    thread.id !== coordinatorThreadId &&
    !isProviderNativeSubagentThread(thread)
  );
}

// Validation here is structural; source access, attachment grants and canonical provenance require service lookups.
export function crewConsultationRequestProblem(
  scope: CrewProjectScope,
  request: CrewConsultationRequest,
  workstream: CrewWorkstream,
  previous: CrewConsultation | null = null,
): "scope" | "destination" | "reply" | null {
  const messages = [
    request.origin,
    request.context.replyTo,
    ...request.context.sources,
    ...request.context.attachments.map((attachment) => attachment.message),
  ].filter((m) => m !== null);
  if (
    !sameCrewProject(scope, request.destination) ||
    messages.some(
      (m) =>
        !sameCrewProject(scope, m.conversation) ||
        (m.sender !== null && !sameCrewProject(scope, m.sender)),
    )
  )
    return "scope";
  if (
    workstream.status === "unlinked" ||
    !sameCrewConversation(request.destination, workstream.conversation) ||
    sameCrewConversation(request.origin.conversation, request.destination)
  )
    return "destination";
  if (
    request.replyTo !== null &&
    (previous === null ||
      request.id === previous.id ||
      request.replyTo.consultationId !== previous.id ||
      previous.progress.state !== "answered" ||
      request.replyTo.responseId !== previous.progress.exchange.responseId ||
      !sameCrewConversation(request.origin.conversation, previous.origin.conversation) ||
      !sameCrewConversation(request.destination, previous.destination))
  )
    return "reply";
  return null;
}

type ConsultationTransition =
  | { readonly accepted: true; readonly consultation: CrewConsultation }
  | {
      readonly accepted: false;
      readonly reason: "scope" | "correlation" | "terminal" | "source" | "state";
    };

export function observeCrewConsultation(
  current: CrewConsultation,
  observation: CrewConsultationObservation,
  now: IsoDateTime,
): ConsultationTransition {
  if (
    !sameCrewProject(current.origin.conversation, observation.scope) ||
    !sameCrewProject(current.destination, observation.scope)
  )
    return { accepted: false, reason: "scope" };
  if (observation.consultationId !== current.id || observation.deliveryId !== current.deliveryId)
    return { accepted: false, reason: "correlation" };
  const outcome = observation.outcome;
  if (outcome.type !== "failed") {
    const request = outcome.type === "answered" ? outcome.exchange.request : outcome.request;
    if (
      !sameCrewConversation(request.conversation, current.destination) ||
      request.runId === null ||
      (request.sender !== null && !sameCrewProject(request.sender, observation.scope))
    )
      return { accepted: false, reason: "source" };
    if (outcome.type === "answered") {
      const response = outcome.exchange.response;
      if (
        !sameCrewConversation(response.conversation, current.destination) ||
        response.runId !== request.runId ||
        response.actor !== "agent" ||
        response.messageId === request.messageId ||
        (response.sender !== null && !sameCrewConversation(response.sender, current.destination))
      )
        return { accepted: false, reason: "source" };
    }
    const knownRequest =
      current.progress.state === "delivered" || current.progress.state === "failed"
        ? current.progress.request
        : null;
    if (knownRequest !== null && !sameMessage(request, knownRequest))
      return { accepted: false, reason: "correlation" };
  }
  if (current.progress.state === "answered") {
    if (
      outcome.type === "delivered" &&
      sameMessage(outcome.request, current.progress.exchange.request)
    )
      return { accepted: true, consultation: current };
    if (
      outcome.type === "answered" &&
      outcome.exchange.responseId === current.progress.exchange.responseId &&
      sameMessage(outcome.exchange.request, current.progress.exchange.request) &&
      sameMessage(outcome.exchange.response, current.progress.exchange.response)
    )
      return { accepted: true, consultation: current };
    return { accepted: false, reason: "terminal" };
  }
  if (current.progress.state === "cancelled") return { accepted: false, reason: "terminal" };
  if (current.progress.state === "delivered" && outcome.type === "delivered")
    return { accepted: true, consultation: current };
  if (
    current.progress.state === "failed" &&
    outcome.type === "failed" &&
    outcome.detail === current.progress.detail
  )
    return { accepted: true, consultation: current };
  const progress =
    outcome.type === "answered"
      ? { state: "answered" as const, exchange: outcome.exchange }
      : outcome.type === "delivered"
        ? { state: "delivered" as const, request: outcome.request }
        : {
            state: "failed" as const,
            detail: outcome.detail,
            request:
              current.progress.state === "delivered" || current.progress.state === "failed"
                ? current.progress.request
                : null,
          };
  return { accepted: true, consultation: { ...current, progress, updatedAt: now } };
}

export function retryCrewConsultation(
  current: CrewConsultation,
  previousDeliveryId: CommandId,
  deliveryId: CommandId,
  now: IsoDateTime,
): ConsultationTransition {
  if (current.deliveryId !== previousDeliveryId || deliveryId === previousDeliveryId)
    return { accepted: false, reason: "correlation" };
  if (current.progress.state !== "failed") return { accepted: false, reason: "state" };
  return {
    accepted: true,
    consultation: { ...current, deliveryId, progress: { state: "queued" }, updatedAt: now },
  };
}

const sameAssignment = (a: CrewTaskAssignmentRef, b: CrewTaskAssignmentRef) =>
  a.initiativeId === b.initiativeId &&
  a.taskId === b.taskId &&
  a.attemptId === b.attemptId &&
  sameCrewConversation(a.owner, b.owner);

// The service supplies current authoritative assignment/stop evidence; a delivered stop is insufficient.
export function canCompleteCrewHandoff(
  handoff: CrewHandoff,
  currentAssignment: CrewTaskAssignmentRef | null,
  stop: {
    readonly deliveryId: CommandId;
    readonly thread: CrewConversationRef;
    readonly runId: CrewMessageRef["runId"];
    readonly state: "confirmed" | "pending" | "failed" | "unknown";
  } | null,
): boolean {
  if (
    handoff.state !== "ready" ||
    sameCrewConversation(handoff.origin.conversation, handoff.destination) ||
    !sameCrewProject(handoff.origin.conversation, handoff.destination) ||
    !sameCrewConversation(handoff.explanation.conversation, handoff.origin.conversation)
  )
    return false;
  const ownership = handoff.ownership;
  if (ownership.state === "discussion-only") return currentAssignment === null;
  return (
    ownership.state === "reconciled" &&
    currentAssignment !== null &&
    sameCrewProject(handoff.origin.conversation, ownership.assignment.owner) &&
    sameAssignment(ownership.assignment, currentAssignment) &&
    stop !== null &&
    stop.state === "confirmed" &&
    stop.deliveryId === ownership.stopDeliveryId &&
    stop.runId === ownership.stoppedRunId &&
    sameCrewConversation(stop.thread, ownership.assignment.owner)
  );
}

export function shouldRecordCrewAttention(
  source: CrewMessageRef,
  coordinator: CrewConversationRef,
  workstreams: readonly CrewWorkstream[],
): boolean {
  return (
    sameCrewProject(source.conversation, coordinator) &&
    !sameCrewConversation(source.conversation, coordinator) &&
    (source.sender === null ||
      (sameCrewProject(source.sender, coordinator) &&
        !sameCrewConversation(source.sender, coordinator))) &&
    workstreams.some(
      (w) => w.status !== "unlinked" && sameCrewConversation(w.conversation, source.conversation),
    )
  );
}

export const crewAttentionKey = (
  attention: Pick<CrewAttention, "source" | "coordinator" | "reason" | "pendingRequest">,
) =>
  JSON.stringify([
    attention.source.conversation.environmentId,
    attention.source.conversation.projectId,
    attention.source.conversation.threadId,
    attention.source.messageId,
    attention.coordinator.environmentId,
    attention.coordinator.projectId,
    attention.coordinator.threadId,
    attention.reason,
    attention.pendingRequest?.requestId ?? null,
  ]);

export function observeCrewAttention(
  current: CrewAttention,
  observation: CrewAttentionObservation,
  now: IsoDateTime,
): CrewAttention | null {
  if (
    !sameCrewProject(current.coordinator, observation.scope) ||
    observation.attentionId !== current.id ||
    current.progress.state === "pending" ||
    current.progress.deliveryId !== observation.deliveryId
  )
    return null;
  const outcome = observation.outcome;
  if (
    current.progress.state === "failed" &&
    outcome.type === "failed" &&
    current.progress.detail === outcome.detail
  )
    return current;
  if (current.progress.state === "considered")
    return outcome.type !== "failed" && outcome.runId === current.progress.runId ? current : null;
  if (
    (current.progress.state === "delivered" || current.progress.state === "failed") &&
    current.progress.runId !== null &&
    outcome.type !== "failed" &&
    outcome.runId !== current.progress.runId
  )
    return null;
  if (current.progress.state === "delivered" && outcome.type === "delivered") return current;
  return {
    ...current,
    updatedAt: now,
    progress:
      outcome.type === "failed"
        ? {
            state: "failed",
            deliveryId: observation.deliveryId,
            detail: outcome.detail,
            runId:
              current.progress.state === "delivered" || current.progress.state === "failed"
                ? current.progress.runId
                : null,
          }
        : { state: outcome.type, deliveryId: observation.deliveryId, runId: outcome.runId },
  };
}

// Response authority grants no task ownership; services resolve provenance and access from canonical state.
export function canAgentAnswerCrewAttention(
  attention: CrewAttention,
  target: {
    readonly conversation: CrewConversationRef;
    readonly requestId: string;
    readonly runId: CrewMessageRef["runId"];
  },
): boolean {
  const pending = attention.pendingRequest;
  return (
    attention.reason !== "approval" &&
    pending !== null &&
    pending.responder === "authorized-agent" &&
    sameCrewConversation(attention.source.conversation, target.conversation) &&
    pending.requestId === target.requestId &&
    pending.runId === target.runId
  );
}

// Capability evidence comes from the selected adapter, never from model text or a client assertion.
export function crewCoordinationCapabilityProblem(
  driver: ProviderDriverKind,
  capability: CrewCoordinationCapability | null,
): "unsupported" | "provider-mismatch" | null {
  if (capability === null) return "unsupported";
  if (capability.driver !== driver) return "provider-mismatch";
  return capability.state === "enforced" ? null : "unsupported";
}
