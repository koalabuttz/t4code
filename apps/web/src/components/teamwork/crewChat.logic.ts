import {
  CrewMessageRef,
  type CrewConsultation,
  type CrewHandoff,
  type CrewProjectScope,
} from "@t3tools/contracts/crewConversation";
import type { MessageId, ThreadId } from "@t3tools/contracts";
import { sameCrewConversation, sameCrewProject } from "@t3tools/shared/crewConversation";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import type { ChatMessage } from "../../types";

export function crewChatExchanges(
  scope: CrewProjectScope,
  threadId: ThreadId,
  consultations: readonly CrewConsultation[],
  handoffs: readonly CrewHandoff[],
) {
  const byOrigin = new Map<MessageId, CrewConsultation[]>();
  const byReturn = new Map<string, CrewConsultation>();
  const byExplanation = new Map<MessageId, CrewHandoff>();
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
      byExplanation.set(handoff.explanation.messageId, handoff);
    }
  }
  return { byOrigin, byReturn, byExplanation };
}

const decodeReturnSource = Schema.decodeUnknownOption(Schema.fromJsonString(CrewMessageRef));

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
  const endOfHeader = message.text.indexOf("\n");
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
