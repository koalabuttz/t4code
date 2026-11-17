import {
  CrewMessageRef,
  type CrewConsultation,
  type CrewHandoff,
  type CrewProjectScope,
} from "@t3tools/contracts/crewConversation";
import type { MessageId, TeamworkSnapshot, ThreadId } from "@t3tools/contracts";
import { crewHandoffMessageId } from "@t3tools/client-runtime/state/crew";
import { sameCrewConversation, sameCrewProject } from "@t3tools/shared/crewConversation";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import type { ChatMessage } from "../../types";

type RuntimeRequestProjection = {
  readonly runtimeRequests: readonly { id: string; kind: string; status: string }[];
  readonly turnItems: readonly {
    type: string;
    requestId?: string | undefined;
    runId?: string | null | undefined;
  }[];
};

export function currentCrewRuntimeRequests(projection: RuntimeRequestProjection | null) {
  if (!projection) return [];
  const active = new Map(
    projection.runtimeRequests
      .filter((request) => request.status === "pending")
      .map((request) => [request.id, request]),
  );
  const actionable = new Map<
    string,
    { requestId: string; runId: string; kind: "user_input" | "approval" }
  >();
  for (const item of projection.turnItems) {
    if (item.type !== "approval_request" && item.type !== "user_input_request") continue;
    if (!item.requestId || !item.runId) continue;
    const request = active.get(item.requestId);
    if (!request || request.kind === "dynamic_tool_call" || request.kind === "auth_refresh")
      continue;
    if ((request.kind === "user_input") !== (item.type === "user_input_request")) continue;
    actionable.set(item.requestId, {
      requestId: item.requestId,
      runId: item.runId,
      kind: item.type === "user_input_request" ? "user_input" : "approval",
    });
  }
  return [...actionable.values()];
}

export function scopeCrewRuntimeRequests<
  A extends { requestId: string },
  U extends { requestId: string },
>(input: {
  projection: RuntimeRequestProjection | null;
  approvals: A[];
  questions: U[];
  requestId?: string | undefined;
  runId?: string | undefined;
}) {
  if (input.requestId === undefined)
    return { approvals: input.approvals, questions: input.questions, status: "unscoped" as const };
  const match = currentCrewRuntimeRequests(input.projection).find(
    (record) =>
      record.requestId === input.requestId &&
      (input.runId === undefined || record.runId === input.runId),
  );
  const approvals =
    match?.kind === "approval"
      ? input.approvals.filter((request) => request.requestId === match.requestId)
      : [];
  const questions =
    match?.kind === "user_input"
      ? input.questions.filter((request) => request.requestId === match.requestId)
      : [];
  return {
    approvals,
    questions,
    status:
      input.projection === null
        ? ("loading" as const)
        : approvals.length || questions.length
          ? ("pending" as const)
          : ("unavailable" as const),
  };
}

export function hasCrewProjectFootprint(
  snapshot: Pick<TeamworkSnapshot, "coordinatorThreadId" | "initiatives"> | null | undefined,
) {
  return !!snapshot && (snapshot.coordinatorThreadId !== null || snapshot.initiatives.length > 0);
}

export async function establishCrewCoordinator(input: {
  scope: CrewProjectScope;
  threadId: ThreadId;
  readCrew: () => Promise<Pick<TeamworkSnapshot, "revision" | "coordinatorThreadId" | "tasks">>;
  readThread: () => Promise<(CrewProjectScope & { threadId: ThreadId; eligible: boolean }) | null>;
  create?: () => Promise<void>;
  setCoordinator: (expectedRevision: number) => Promise<void>;
}) {
  const initial = await input.readCrew();
  if (initial.coordinatorThreadId !== null) return initial.coordinatorThreadId;

  let thread = await input.readThread();
  if (!thread && input.create) {
    let creationFailure: unknown;
    try {
      await input.create();
    } catch (error) {
      creationFailure = error;
    }
    const afterCreation = await input.readCrew();
    if (afterCreation.coordinatorThreadId !== null) return afterCreation.coordinatorThreadId;
    thread = await input.readThread();
    if (!thread && creationFailure !== undefined) throw creationFailure;
  }
  if (
    !thread ||
    !thread.eligible ||
    thread.threadId !== input.threadId ||
    !sameCrewProject(thread, input.scope)
  ) {
    throw new Error("This conversation cannot coordinate the selected project.");
  }

  const latest = await input.readCrew();
  if (latest.coordinatorThreadId !== null) return latest.coordinatorThreadId;
  if (latest.tasks.some((task) => task.ownerThreadId === input.threadId)) {
    throw new Error("This conversation already owns Crew work. Choose a different coordinator.");
  }
  try {
    await input.setCoordinator(latest.revision);
  } catch (error) {
    const winner = (await input.readCrew()).coordinatorThreadId;
    if (winner !== null) return winner;
    throw error;
  }
  return input.threadId;
}

export function crewUndeliveredAnswerSource(
  consultation: CrewConsultation,
  returnStatus: string | undefined,
  hasReturnedMessage: boolean,
) {
  if (
    (returnStatus !== "failed" && returnStatus !== "pending") ||
    hasReturnedMessage ||
    consultation.progress.state !== "answered"
  )
    return null;
  const { response, request } = consultation.progress.exchange;
  return response.actor === "agent" &&
    response.runId !== null &&
    response.runId === request.runId &&
    sameCrewConversation(consultation.destination, response.conversation) &&
    sameCrewConversation(consultation.destination, request.conversation) &&
    sameCrewProject(consultation.origin.conversation, response.conversation)
    ? response
    : null;
}

export function crewChatExchanges(
  scope: CrewProjectScope,
  threadId: ThreadId,
  consultations: readonly CrewConsultation[],
  handoffs: readonly CrewHandoff[],
  visibleMessageIds?: readonly MessageId[],
) {
  const byOrigin = new Map<MessageId, CrewConsultation[]>();
  const byReturn = new Map<string, CrewConsultation>();
  const byHandoffMessage = new Map<MessageId, CrewHandoff>();
  for (const consultation of consultations) {
    const { origin, destination, progress } = consultation;
    if (
      origin.conversation.threadId !== threadId ||
      !sameCrewProject(origin.conversation, scope) ||
      !sameCrewProject(destination, scope)
    )
      continue;
    const entries = byOrigin.get(origin.messageId) ?? [];
    entries.push(consultation);
    byOrigin.set(origin.messageId, entries);
    if (progress.state === "answered")
      byReturn.set(`${consultation.deliveryId}:return`, consultation);
  }
  for (const handoff of handoffs) {
    if (
      handoff.origin.conversation.threadId === threadId &&
      handoff.explanation.conversation.threadId === threadId &&
      sameCrewProject(handoff.origin.conversation, scope) &&
      sameCrewProject(handoff.explanation.conversation, scope) &&
      sameCrewProject(handoff.destination, scope)
    ) {
      const messageId = visibleMessageIds
        ? crewHandoffMessageId(handoff, visibleMessageIds)
        : handoff.explanation.messageId;
      if (messageId) byHandoffMessage.set(messageId, handoff);
    }
  }
  return { byOrigin, byReturn, byHandoffMessage };
}

const decodeReturnSource = Schema.decodeUnknownOption(Schema.fromJsonString(CrewMessageRef));

type ReturnMessage = Pick<
  ChatMessage,
  "id" | "text" | "creationSource" | "createdBy" | "senderThreadId"
>;

export function crewReturnLookupId(message: ReturnMessage, scope: CrewProjectScope) {
  if (
    !message.senderThreadId ||
    message.creationSource !== "server" ||
    message.createdBy !== "agent" ||
    !message.id.startsWith(`crew:${scope.projectId}:`) ||
    !message.id.endsWith(":return")
  )
    return null;
  const prefix = "Crew consultation ";
  const marker = ` answered. From ${message.senderThreadId}. Canonical source: `;
  const end = message.text.indexOf(marker, prefix.length);
  if (!message.text.startsWith(prefix) || end < 0) return null;
  const id = message.text.slice(prefix.length, end);
  return id.length > 0 && id.length <= 120 && id === id.trim() ? id : null;
}

export function crewReturnedAnswer(
  message: Pick<ChatMessage, "id" | "text" | "creationSource" | "createdBy" | "senderThreadId">,
  consultation: CrewConsultation | undefined,
) {
  if (
    !consultation ||
    consultation.progress.state !== "answered" ||
    message.id !== `${consultation.deliveryId}:return` ||
    message.creationSource !== "server" ||
    message.createdBy !== "agent" ||
    message.senderThreadId !== consultation.destination.threadId
  ) {
    return null;
  }
  const prefix = `Crew consultation ${consultation.id} answered. From ${consultation.destination.threadId}. Canonical source: `;
  const endOfHeader = message.text.indexOf("\n", prefix.length);
  if (endOfHeader < 0 || !message.text.startsWith(prefix)) return null;
  const response = consultation.progress.exchange.response;
  const source = Option.getOrNull(
    decodeReturnSource(message.text.slice(prefix.length, endOfHeader)),
  );
  if (
    !source ||
    !sameCrewConversation(source.conversation, response.conversation) ||
    source.messageId !== response.messageId ||
    source.runId !== response.runId ||
    source.actor !== response.actor ||
    (source.sender === null
      ? response.sender !== null
      : response.sender === null || !sameCrewConversation(source.sender, response.sender))
  )
    return null;
  return message.text.slice(endOfHeader + 1);
}
