import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import {
  CrewAttention,
  CrewConsultation,
  CrewConsultationObservation,
  CrewHandoff,
  type CrewCoordinationCapability,
  type CrewMessageRef,
  type CrewWorkstream,
} from "@t3tools/contracts/crewConversation";
import {
  canCompleteCrewHandoff,
  canAgentAnswerCrewAttention,
  canLinkCrewWorkstream,
  crewAttentionKey,
  crewConsultationRequestProblem,
  crewCoordinationCapabilityProblem,
  observeCrewAttention,
  observeCrewConsultation,
  retryCrewConsultation,
  sameCrewConversation,
  shouldRecordCrewAttention,
} from "./crewConversation.ts";

const scope = { environmentId: EnvironmentId.make("host"), projectId: ProjectId.make("project") };
const origin = { ...scope, threadId: ThreadId.make("coordinator") };
const destination = { ...scope, threadId: ThreadId.make("android") };
const at = "2026-11-17T00:00:00Z";
const later = "2026-11-17T00:01:00Z";
const decodeConsultation = Schema.decodeSync(CrewConsultation);
const decodeObservation = Schema.decodeSync(CrewConsultationObservation);
const decodeHandoff = Schema.decodeSync(CrewHandoff);
const decodeAttention = Schema.decodeSync(CrewAttention);
const message = (
  thread: typeof origin,
  id: string,
  actor: CrewMessageRef["actor"],
  runId: string | null,
): CrewMessageRef => ({
  conversation: thread,
  messageId: MessageId.make(id),
  actor,
  runId: runId === null ? null : RunId.make(runId),
  sender: null,
});
const question = message(origin, "question", "user", null);
const request = message(destination, "forwarded", "system", "run");
const response = message(destination, "answer", "agent", "run");
const responseId = MessageId.make("response");
const workstream: CrewWorkstream = {
  conversation: destination,
  title: "Android",
  status: "resolved",
  linkedAt: at,
  updatedAt: at,
};
const consultation = () =>
  decodeConsultation({
    id: "consult",
    origin: question,
    destination,
    context: {
      replyTo: question,
      sources: [question],
      attachments: [{ message: question, attachmentId: "image-1" }],
    },
    replyTo: null,
    deliveryId: "delivery",
    progress: { state: "queued" },
    createdAt: at,
    updatedAt: at,
  });
const observation = () =>
  decodeObservation({
    scope,
    consultationId: "consult",
    deliveryId: "delivery",
    outcome: { type: "answered", exchange: { request, response, responseId } },
  });
const answered = () => {
  const result = observeCrewConsultation(consultation(), observation(), later);
  if (!result.accepted) throw new Error(result.reason);
  return result.consultation;
};

describe("Crew conversation state", () => {
  it("requires selected-adapter enforcement evidence rather than Plan mode or a provider fallback", () => {
    const driver = ProviderDriverKind.make("codex");
    const capability: CrewCoordinationCapability = {
      state: "enforced",
      driver,
      policyVersion: "fixture-policy",
      filesystem: "read-only",
      process: "restricted",
      tools: "allowlisted",
      delegation: "guarded-service",
    };
    expect(crewCoordinationCapabilityProblem(driver, null)).toBe("unsupported");
    expect(
      crewCoordinationCapabilityProblem(driver, {
        state: "unsupported",
        driver,
        detail: "No runtime guard",
      }),
    ).toBe("unsupported");
    expect(crewCoordinationCapabilityProblem(ProviderDriverKind.make("claude"), capability)).toBe(
      "provider-mismatch",
    );
    expect(crewCoordinationCapabilityProblem(driver, capability)).toBeNull();
  });
  it("keeps retained workstreams independent of assignments and rejects native children and cross-scope identities", () => {
    const thread = {
      id: destination.threadId,
      projectId: scope.projectId,
      creationSource: "mcp" as const,
      lineage: {
        parentThreadId: origin.threadId,
        rootThreadId: origin.threadId,
        relationshipToParent: "subagent" as const,
      },
    };
    expect(canLinkCrewWorkstream(scope, scope.environmentId, thread, origin.threadId)).toBe(true);
    expect(
      canLinkCrewWorkstream(
        scope,
        scope.environmentId,
        { ...thread, creationSource: "provider" },
        origin.threadId,
      ),
    ).toBe(false);
    expect(canLinkCrewWorkstream(scope, EnvironmentId.make("other"), thread, origin.threadId)).toBe(
      false,
    );
    expect(
      canLinkCrewWorkstream(
        scope,
        scope.environmentId,
        { ...thread, id: origin.threadId },
        origin.threadId,
      ),
    ).toBe(false);
    expect(
      sameCrewConversation(destination, { ...destination, projectId: ProjectId.make("other") }),
    ).toBe(false);
    const current = consultation();
    expect(crewConsultationRequestProblem(scope, current, workstream)).toBeNull();
    expect(
      crewConsultationRequestProblem(scope, current, { ...workstream, status: "unlinked" }),
    ).toBe("destination");
    expect(
      crewConsultationRequestProblem(
        scope,
        {
          ...current,
          context: {
            ...current.context,
            attachments: [
              {
                message: {
                  ...question,
                  conversation: { ...origin, environmentId: EnvironmentId.make("other") },
                },
                attachmentId: "image-1",
              },
            ],
          },
        },
        workstream,
      ),
    ).toBe("scope");
  });

  it("correlates an early answer, ignores late delivery, and rejects conflicting or foreign responses", () => {
    const current = answered();
    expect(current.progress.state).toBe("answered");
    expect(observeCrewConsultation(current, observation(), later)).toEqual({
      accepted: true,
      consultation: current,
    });
    expect(
      observeCrewConsultation(
        current,
        { ...observation(), outcome: { type: "delivered", request } },
        later,
      ),
    ).toEqual({ accepted: true, consultation: current });
    expect(
      observeCrewConsultation(
        current,
        { ...observation(), outcome: { type: "failed", detail: "Late failure" } },
        later,
      ).accepted,
    ).toBe(false);
    for (const invalidResponse of [
      { ...response, conversation: origin },
      { ...response, conversation: { ...destination, environmentId: EnvironmentId.make("other") } },
      { ...response, runId: RunId.make("other") },
      { ...response, actor: "user" as const },
      { ...response, sender: origin },
      { ...response, messageId: request.messageId },
    ]) {
      expect(
        observeCrewConsultation(
          consultation(),
          {
            ...observation(),
            outcome: {
              type: "answered",
              exchange: { request, response: invalidResponse, responseId },
            },
          },
          later,
        ),
      ).toEqual({ accepted: false, reason: "source" });
    }
    expect(
      observeCrewConsultation(
        current,
        {
          ...observation(),
          outcome: {
            type: "answered",
            exchange: { request, response, responseId: MessageId.make("different") },
          },
        },
        later,
      ).accepted,
    ).toBe(false);
    const delivered = { ...consultation(), progress: { state: "delivered" as const, request } };
    const failureAfterDelivery = observeCrewConsultation(
      delivered,
      { ...observation(), outcome: { type: "failed", detail: "Disconnected" } },
      later,
    );
    if (!failureAfterDelivery.accepted) throw new Error("fixture");
    expect(
      observeCrewConsultation(
        failureAfterDelivery.consultation,
        {
          ...observation(),
          outcome: {
            type: "answered",
            exchange: {
              request: { ...request, runId: RunId.make("wrong-run") },
              response: { ...response, runId: RunId.make("wrong-run") },
              responseId,
            },
          },
        },
        later,
      ).accepted,
    ).toBe(false);
    expect(
      observeCrewConsultation(
        delivered,
        { ...observation(), outcome: { type: "delivered", request } },
        later,
      ),
    ).toEqual({ accepted: true, consultation: delivered });
    expect(
      observeCrewConsultation(
        delivered,
        {
          ...observation(),
          outcome: {
            type: "answered",
            exchange: {
              request: { ...request, messageId: MessageId.make("different") },
              response,
              responseId,
            },
          },
        },
        later,
      ).accepted,
    ).toBe(false);
  });

  it("retains origin, attachments and reply context across restart/retry without accepting replaced delivery results", () => {
    const current = consultation();
    const failed = {
      ...current,
      progress: { state: "failed" as const, detail: "Disconnected", request: null },
    };
    const retried = retryCrewConsultation(
      decodeConsultation(JSON.parse(JSON.stringify(failed))),
      current.deliveryId,
      CommandId.make("retry"),
      later,
    );
    expect(retried.accepted).toBe(true);
    if (!retried.accepted) throw new Error(retried.reason);
    expect(retried.consultation.origin).toEqual(current.origin);
    expect(retried.consultation.context).toEqual(current.context);
    expect(observeCrewConsultation(retried.consultation, observation(), later)).toEqual({
      accepted: false,
      reason: "correlation",
    });
    expect(
      retryCrewConsultation(current, current.deliveryId, CommandId.make("retry"), later).accepted,
    ).toBe(false);
    expect(
      retryCrewConsultation(failed, current.deliveryId, current.deliveryId, later).accepted,
    ).toBe(false);
    expect(
      observeCrewConsultation(
        { ...current, progress: { state: "cancelled" } },
        observation(),
        later,
      ).accepted,
    ).toBe(false);
    const followup = {
      ...current,
      id: "followup",
      replyTo: { consultationId: current.id, responseId },
    };
    expect(crewConsultationRequestProblem(scope, followup, workstream, answered())).toBeNull();
    expect(crewConsultationRequestProblem(scope, followup, workstream, current)).toBe("reply");
    expect(
      crewConsultationRequestProblem(
        scope,
        { ...followup, origin: { ...question, conversation: destination } },
        workstream,
        answered(),
      ),
    ).toBe("destination");
  });

  it("requires exact assignment and confirmed execution evidence before an implementation handoff", () => {
    const handoff = decodeHandoff({
      id: "handoff",
      origin: response,
      destination: origin,
      context: consultation().context,
      consultationId: "consult",
      explanation: response,
      state: "ready",
      createdAt: at,
      updatedAt: at,
      ownership: {
        state: "reconciled",
        assignment: {
          initiativeId: "initiative",
          taskId: "task",
          attemptId: "attempt",
          owner: destination,
        },
        stopDeliveryId: "stop",
        stoppedRunId: "run",
        reconciledRevision: 1,
      },
    });
    if (handoff.ownership.state !== "reconciled") throw new Error("fixture");
    const assignment = handoff.ownership.assignment;
    const stop = {
      deliveryId: CommandId.make("stop"),
      thread: destination,
      runId: RunId.make("run"),
      state: "confirmed" as const,
    };
    expect(canCompleteCrewHandoff(handoff, assignment, stop)).toBe(true);
    for (const state of ["pending", "failed", "unknown"] as const)
      expect(canCompleteCrewHandoff(handoff, assignment, { ...stop, state })).toBe(false);
    expect(canCompleteCrewHandoff(handoff, { ...assignment, attemptId: "replacement" }, stop)).toBe(
      false,
    );
    expect(
      canCompleteCrewHandoff(handoff, assignment, { ...stop, runId: RunId.make("different") }),
    ).toBe(false);
    expect(canCompleteCrewHandoff(handoff, null, stop)).toBe(false);
    expect(
      canCompleteCrewHandoff(
        { ...handoff, ownership: { state: "discussion-only" } },
        assignment,
        null,
      ),
    ).toBe(false);
    expect(
      canCompleteCrewHandoff({ ...handoff, ownership: { state: "discussion-only" } }, null, null),
    ).toBe(true);
  });

  it("records bounded direct-thread attention without coordinator reflection loops or false consideration", () => {
    const source = message(destination, "direct", "user", null);
    expect(shouldRecordCrewAttention(source, origin, [workstream])).toBe(true);
    expect(shouldRecordCrewAttention(source, origin, [])).toBe(false);
    expect(shouldRecordCrewAttention(source, origin, [{ ...workstream, status: "unlinked" }])).toBe(
      false,
    );
    expect(shouldRecordCrewAttention({ ...source, sender: origin }, origin, [workstream])).toBe(
      false,
    );
    expect(shouldRecordCrewAttention(question, origin, [workstream])).toBe(false);
    const attention = decodeAttention({
      id: "attention",
      source,
      coordinator: origin,
      reason: "user-message",
      correlationId: null,
      pendingRequest: null,
      progress: { state: "queued", deliveryId: "attention-delivery" },
      createdAt: at,
      updatedAt: at,
    });
    const observed = {
      scope,
      attentionId: attention.id,
      deliveryId: CommandId.make("attention-delivery"),
      outcome: { type: "delivered" as const, runId: RunId.make("coordinator-run") },
    };
    const delivered = observeCrewAttention(attention, observed, later);
    expect(delivered?.progress.state).toBe("delivered");
    const pending = {
      ...attention,
      pendingRequest: {
        requestId: RuntimeRequestId.make("request"),
        runId: RunId.make("question-run"),
        responder: "user-only" as const,
      },
    };
    const target = {
      conversation: destination,
      requestId: "request",
      runId: RunId.make("question-run"),
    };
    expect(canAgentAnswerCrewAttention(pending, target)).toBe(false);
    const answerable = {
      ...pending,
      reason: "question" as const,
      pendingRequest: { ...pending.pendingRequest, responder: "authorized-agent" as const },
    };
    const approval = decodeAttention({ ...answerable, reason: "approval" });
    expect(canAgentAnswerCrewAttention(approval, target)).toBe(false);
    expect(canAgentAnswerCrewAttention(answerable, target)).toBe(true);
    expect(canAgentAnswerCrewAttention(answerable, { ...target, requestId: "different" })).toBe(
      false,
    );
    expect(
      canAgentAnswerCrewAttention(answerable, { ...target, runId: RunId.make("different") }),
    ).toBe(false);
    expect(canAgentAnswerCrewAttention(answerable, { ...target, conversation: origin })).toBe(
      false,
    );
    expect(crewAttentionKey(attention)).toBe(
      crewAttentionKey({ ...attention, source: { ...source } }),
    );
    expect(crewAttentionKey(attention)).not.toBe(
      crewAttentionKey({
        ...attention,
        source: {
          ...source,
          conversation: { ...destination, environmentId: EnvironmentId.make("other") },
        },
      }),
    );
    if (!delivered) throw new Error("fixture");
    const failed = observeCrewAttention(
      delivered,
      { ...observed, outcome: { type: "failed", detail: "Disconnected" } },
      later,
    );
    if (!failed) throw new Error("fixture");
    expect(
      observeCrewAttention(
        failed,
        { ...observed, outcome: { type: "considered", runId: RunId.make("wrong-run") } },
        later,
      ),
    ).toBeNull();
    expect(
      observeCrewAttention(delivered, { ...observed, deliveryId: CommandId.make("old") }, later),
    ).toBeNull();
    const considered = observeCrewAttention(
      delivered,
      { ...observed, outcome: { ...observed.outcome, type: "considered" } },
      later,
    );
    expect(considered?.progress.state).toBe("considered");
    if (!considered) throw new Error("fixture");
    expect(observeCrewAttention(considered, observed, later)).toBe(considered);
    expect(
      observeCrewAttention(
        delivered,
        { ...observed, outcome: { type: "considered", runId: RunId.make("wrong-run") } },
        later,
      ),
    ).toBeNull();
  });
});
