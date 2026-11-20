import { useNavigation } from "@react-navigation/native";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import {
  crewDraftBrief,
  crewSelectedInitiative,
  crewHandoffMessageId,
} from "@t3tools/client-runtime/state/crew";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { AuthOrchestrationReadScope, type MessageId, type ThreadId } from "@t3tools/contracts";
import type {
  CrewConsultation,
  CrewHandoff,
  CrewWorkstream,
} from "@t3tools/contracts/crewConversation";
import { sameCrewConversation, sameCrewProject } from "@t3tools/shared/crewConversation";
import { createContext, use, useMemo, useState, type ReactNode } from "react";
import * as Option from "effect/Option";
import { Keyboard, View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  environmentThreadDetails,
  threadEnvironment,
  useEnvironmentThread,
} from "../../state/threads";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { appendComposerDraftText, getComposerDraftSnapshot } from "../../state/use-composer-drafts";
import { scopedThreadKey } from "../../lib/scopedEntities";
import type { ThreadFeedEntry } from "../../lib/threadActivity";
import {
  mobileCrewReturnedAnswer,
  mobileCrewReturnEnvelope,
  type CrewRequestTarget,
} from "./crewMobile.logic";
import { openCrewExchange, openCrewPage, openCrewSource } from "./crewProjectNavigation";
import {
  useCrewCollection,
  useCrewControls,
  useCrewHumanAttention,
  useCrewProject,
  useCrewRead,
  useCrewTimelineMetadata,
} from "./use-crew-project";

export type CrewChatRoute = {
  projectTitle: string;
  coordinator: boolean;
  source: boolean;
};

const CrewChatContext = createContext<ReturnType<typeof useCrewChatModel> | null>(null);
const emptyCrewQueue = Atom.make(null);
export const useCrewChat = () => use(CrewChatContext);

export function CrewChatFrame({
  thread,
  route,
  children,
}: {
  thread: EnvironmentThreadShell;
  route: CrewChatRoute;
  children: ReactNode;
}) {
  const scope = { environmentId: thread.environmentId, projectId: thread.projectId };
  const { data } = useCrewRead(scope);
  const coordinator = route.coordinator || data?.snapshot.coordinatorThreadId === thread.id;
  const membership = useCrewCollection(
    !coordinator && data?.snapshot.coordinatorThreadId ? scope : null,
    { collection: "workstreams", threadId: thread.id, limit: 1 },
  );
  const workstream = membership.data?.workstreams.find(
    (entry) =>
      entry.status !== "unlinked" &&
      sameCrewConversation(entry.conversation, { ...scope, threadId: thread.id }),
  );
  const active = coordinator || workstream !== undefined || route.source;
  const model = useCrewChatModel(thread, { ...route, coordinator }, workstream, active);
  return <CrewChatContext value={active ? model : null}>{children}</CrewChatContext>;
}

function useCrewChatModel(
  thread: EnvironmentThreadShell,
  route: CrewChatRoute,
  workstream: CrewWorkstream | undefined,
  active: boolean,
) {
  const scope = { environmentId: thread.environmentId, projectId: thread.projectId };
  const conversation = useMemo(
    () => ({
      environmentId: thread.environmentId,
      projectId: thread.projectId,
      threadId: thread.id,
    }),
    [thread.environmentId, thread.projectId, thread.id],
  );
  const { snapshot, query, freshness, supervision, threads } = useCrewProject(scope, active);
  const canRead = useEnvironmentScope(
    active ? scope.environmentId : null,
    AuthOrchestrationReadScope,
  );
  const navigation = useNavigation();
  const controls = useCrewControls(scope, snapshot?.revision, freshness === "current");
  const queue = useAtomValue(
    active
      ? environmentThreadDetails.queueWorkflowAtom({
          environmentId: thread.environmentId,
          threadId: thread.id,
        })
      : emptyCrewQueue,
  );
  const queuedMessageIds = queue?.queuedRuns.map((entry) => entry.messageId) ?? [];
  const metadata = useCrewTimelineMetadata(
    active && canRead ? scope : null,
    thread.id,
    snapshot?.revision,
    queuedMessageIds,
  );
  const exchange = useMemo(() => {
    const byOrigin = new Map<MessageId, CrewConsultation[]>();
    const returns = new Map<string, CrewConsultation>();
    for (const consultation of metadata.data?.consultations ?? []) {
      if (
        !sameCrewConversation(consultation.origin.conversation, conversation) ||
        !sameCrewProject(consultation.destination, conversation)
      )
        continue;
      const items = byOrigin.get(consultation.origin.messageId) ?? [];
      items.push(consultation);
      byOrigin.set(consultation.origin.messageId, items);
      if (consultation.progress.state === "answered")
        returns.set(`${consultation.deliveryId}:return`, consultation);
    }
    const routes = new Map<MessageId, CrewHandoff[]>();
    for (const handoff of metadata.data?.handoffs ?? []) {
      if (
        !sameCrewConversation(handoff.origin.conversation, conversation) ||
        !sameCrewConversation(handoff.explanation.conversation, conversation) ||
        !sameCrewProject(handoff.destination, conversation)
      )
        continue;
      const messageId =
        crewHandoffMessageId(handoff, metadata.visibleMessageIds) ??
        crewHandoffMessageId(handoff, metadata.data?.messageIds ?? []);
      if (!messageId) continue;
      const items = routes.get(messageId) ?? [];
      items.push(handoff);
      routes.set(messageId, items);
    }
    return { byOrigin, returns, routes };
  }, [conversation, metadata.data, metadata.visibleMessageIds]);
  const initiatives = snapshot?.initiatives ?? [];
  const actionInitiative =
    initiatives.findLast((initiative) => initiative.status === "active") ??
    initiatives.findLast(
      (initiative) => initiative.status === "paused" || initiative.status === "draft",
    );
  const stop = supervision?.attention.find(
    (item) => item.kind === "stop-failed" || item.kind === "stop-pending",
  );
  const humanAttention = useCrewHumanAttention(
    scope,
    active && route.coordinator && freshness === "current" ? thread.id : null,
    snapshot?.revision,
  );
  const threadName = (id: ThreadId) =>
    threads.find((shell) => shell.id === id && shell.deletedAt === null)?.title ?? "Work thread";
  const available = (id: ThreadId) =>
    canRead && threads.some((shell) => shell.id === id && shell.deletedAt === null);
  const go = (page?: Parameters<typeof openCrewPage>[2]) => {
    Keyboard.dismiss();
    openCrewPage(navigation, scope, page);
  };
  const pauseOrRecover = () => {
    if (!actionInitiative || stop || actionInitiative.status !== "active") {
      const initiativeId = stop?.initiativeId ?? actionInitiative?.id;
      if (initiativeId)
        appAtomRegistry.set(crewSelectedInitiative(scopedProjectKey(scope)), initiativeId);
      go(actionInitiative?.status === "draft" && !stop ? "settings" : "recovery");
      return;
    }
    Dialog.alert("Pause project work?", "Crew will request stops for the current workers.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Pause work",
        onPress: () =>
          void controls.act({
            type: "initiative.status",
            id: actionInitiative.id,
            status: "paused",
          }),
      },
    ]);
  };
  return {
    canRead,
    queuedMessageIds: new Set(queuedMessageIds),
    route,
    conversation,
    workstream,
    freshness,
    controls,
    exchange,
    onVisibleMessages: metadata.onVisibleMessages,
    requests: humanAttention.requests,
    requestsComplete: !humanAttention.checking && humanAttention.nextCursor === null,
    actionInitiative,
    stop,
    go,
    pauseOrRecover,
    threadName,
    available,
    queryError: metadata.error ?? humanAttention.error,
    metadataError: metadata.error,
    refreshMetadata: metadata.refresh,
    deliveries: query.data?.deliveries ?? [],
    openExchange: (kind: "handoffs" | "consultations", id: string) => {
      Keyboard.dismiss();
      openCrewExchange(navigation, scope, kind, id);
    },
    openSource: (
      ref: Parameters<typeof openCrewSource>[2],
      message?: Parameters<typeof openCrewSource>[3],
      request?: CrewRequestTarget,
    ) => {
      if (!canRead) return;
      Keyboard.dismiss();
      openCrewSource(navigation, scope, ref, message, request);
    },
  };
}

export function moveCrewEntryDraft(conversation: {
  environmentId: EnvironmentThreadShell["environmentId"];
  projectId: EnvironmentThreadShell["projectId"];
  threadId: ThreadId;
}) {
  const key = scopedProjectKey(conversation);
  const draftKey = scopedThreadKey(conversation.environmentId, conversation.threadId);
  const brief = appAtomRegistry.get(crewDraftBrief(key));
  if (!brief) return;
  const draft = getComposerDraftSnapshot(draftKey);
  appendComposerDraftText(draftKey, draft.text ? `\n\n${brief}` : brief);
  appAtomRegistry.set(crewDraftBrief(key), "");
}

export function CrewQueuedHandoffs() {
  const chat = useCrewChat();
  if (!chat) return null;
  const handoffs = [...chat.exchange.routes].flatMap(([messageId, records]) =>
    chat.queuedMessageIds.has(messageId) ? records : [],
  );
  if (handoffs.length === 0) return null;
  return (
    <View className="mx-4 mb-2 gap-2">
      {handoffs.map((handoff) => (
        <Button
          key={handoff.id}
          label={`Handoff · ${chat.threadName(handoff.destination.threadId)}`}
          accessibilityLabel="View handoff details"
          size="compact"
          onPress={() => chat.openExchange("handoffs", handoff.id)}
        />
      ))}
    </View>
  );
}

export function CrewChatStatus() {
  const chat = useCrewChat();
  if (!chat) return null;
  const { route, freshness, controls, requests, stop, actionInitiative } = chat;
  const request = freshness === "current" ? requests[0] : undefined;
  const pending = request?.pendingRequest;
  const plan = !stop && actionInitiative?.status === "draft" && !actionInitiative.approved;
  const status =
    freshness !== "current"
      ? "Project updates are last known. Execution is unconfirmed."
      : (controls.error ?? stop?.label ?? (plan ? "Project plan needs approval" : null));
  if (!status && !pending && !chat.queryError && chat.requestsComplete) return null;
  return (
    <View className="mx-4 mb-2 gap-1 rounded-xl border border-border bg-screen px-3 py-2">
      {(status || chat.queryError) && (
        <AppText accessibilityRole="alert" numberOfLines={2}>
          {status ?? "Crew activity is unavailable."}
        </AppText>
      )}
      {chat.metadataError && (
        <Button label="Retry exchanges" size="compact" onPress={chat.refreshMetadata} />
      )}
      {route.coordinator && (stop || plan) && (
        <Button
          label={stop ? "Open stop recovery" : "Review plan"}
          size="compact"
          onPress={chat.pauseOrRecover}
        />
      )}
      {request && pending && (
        <Button
          size="compact"
          label={`${request.reason === "approval" ? "Review request" : "Open question"} · ${chat.threadName(request.source.conversation.threadId)}`}
          disabled={!chat.available(request.source.conversation.threadId)}
          onPress={() => chat.openSource(request.source.conversation, undefined, pending)}
        />
      )}
      {route.coordinator && (requests.length > 1 || !chat.requestsComplete) && (
        <Button
          label={
            chat.requestsComplete
              ? `More requests · ${requests.length - 1}`
              : "View pending requests"
          }
          size="compact"
          onPress={() => chat.go("threads")}
        />
      )}
    </View>
  );
}

type ChatMessage = Extract<ThreadFeedEntry, { type: "message" }>["message"];

export function CrewChatMessage({
  entry,
  children,
  returnMessages,
}: {
  entry: Extract<ThreadFeedEntry, { type: "message" }>;
  children: ReactNode;
  returnMessages: ReadonlyMap<string, ChatMessage>;
}) {
  const chat = useCrewChat();
  if (!chat) return children;
  const { message } = entry;
  const returned = chat.exchange.returns.get(message.id);
  const answer = returned ? mobileCrewReturnedAnswer(chat.conversation, returned, message) : null;
  if (returned && returned.progress.state === "answered" && answer !== null) {
    return <ConsultationAnswer key={returned.id} consultation={returned} answer={answer} />;
  }
  if (!returned && message.id.startsWith(`crew:${chat.conversation.projectId}:`)) {
    const envelope = mobileCrewReturnEnvelope(message);
    if (envelope && sameCrewProject(chat.conversation, envelope.source.conversation)) {
      return (
        <HistoricalConsultationReturn message={message} consultationId={envelope.consultationId}>
          {children}
        </HistoricalConsultationReturn>
      );
    }
  }
  const consultations = chat.exchange.byOrigin.get(message.id);
  const handoffs = chat.queuedMessageIds.has(message.id)
    ? undefined
    : chat.exchange.routes.get(message.id);
  if (!consultations && !handoffs) return children;
  return (
    <>
      {children}
      <View className="mx-4 mb-2 gap-2">
        {consultations?.map((item) => {
          const echo = returnMessages.get(`${item.deliveryId}:return`);
          return (
            <ConsultationStatus
              key={item.id}
              consultation={item}
              hasEcho={
                echo !== undefined &&
                mobileCrewReturnedAnswer(chat.conversation, item, echo) !== null
              }
            />
          );
        })}
        {handoffs?.map((handoff) => (
          <HandoffCard key={handoff.id} handoff={handoff} />
        ))}
      </View>
    </>
  );
}

function HistoricalConsultationReturn({
  message,
  consultationId,
  children,
}: {
  message: ChatMessage;
  consultationId: string;
  children: ReactNode;
}) {
  const chat = useCrewChat()!;
  const { environmentId, projectId, threadId } = chat.conversation;
  const query = useCrewCollection(
    { environmentId, projectId },
    {
      collection: "consultations",
      id: consultationId,
      threadId,
      limit: 1,
    },
  );
  const consultation = query.data?.consultations[0];
  const answer = consultation
    ? mobileCrewReturnedAnswer(chat.conversation, consultation, message)
    : null;
  if (consultation && answer !== null) {
    return <ConsultationAnswer consultation={consultation} answer={answer} />;
  }
  return (
    <>
      {children}
      {query.error && (
        <AppText className="mx-4 text-foreground-muted">
          The source exchange is unavailable.
        </AppText>
      )}
    </>
  );
}

function ConsultationStatus({
  consultation,
  hasEcho,
}: {
  consultation: CrewConsultation;
  hasEcho: boolean;
}) {
  const chat = useCrewChat()!;
  const [showRecordedAnswer, setShowRecordedAnswer] = useState(false);
  const name = chat.threadName(consultation.destination.threadId);
  const progress = consultation.progress;
  const canReadAnswer =
    chat.canRead &&
    progress.state === "answered" &&
    sameCrewProject(chat.conversation, consultation.destination) &&
    sameCrewConversation(consultation.destination, progress.exchange.response.conversation);
  const returned = chat.deliveries.find(
    (delivery) =>
      delivery.id === `${consultation.deliveryId}:return` &&
      delivery.threadId === chat.conversation.threadId &&
      delivery.kind === "message",
  );
  return (
    <View className="gap-1">
      <AppText className="text-foreground-muted">
        {progress.state === "queued"
          ? `Waiting to ask ${name}`
          : progress.state === "delivered"
            ? `Waiting for a reply from ${name}`
            : progress.state === "failed"
              ? `Could not get a reply from ${name}`
              : progress.state === "cancelled"
                ? `Consultation with ${name} cancelled`
                : `Answer received from ${name}`}
      </AppText>
      {progress.state === "failed" &&
        (progress.request === null ? (
          <Button
            label="Retry consultation"
            size="compact"
            disabled={!chat.controls.canEditConversations}
            onPress={() =>
              void chat.controls.change({
                type: "consultation.retry",
                id: consultation.id,
                previousDeliveryId: consultation.deliveryId,
              })
            }
          />
        ) : (
          <Button
            label="Inspect failed consultation"
            size="compact"
            onPress={() => chat.openSource(consultation.destination, progress.request ?? undefined)}
          />
        ))}
      {progress.state === "answered" && !hasEcho && (
        <>
          {returned?.status === "failed" && (
            <AppText>The answer is recorded. Delivery to this chat failed.</AppText>
          )}
          {returned?.status === "pending" && (
            <AppText>Answer recorded. Waiting to deliver it to this chat.</AppText>
          )}
          <Button
            label={showRecordedAnswer ? "Hide recorded answer" : "Read recorded answer"}
            size="compact"
            disabled={!canReadAnswer}
            onPress={() => setShowRecordedAnswer(!showRecordedAnswer)}
          />
          {showRecordedAnswer && canReadAnswer && (
            <CrewRecordedAnswer consultation={consultation} source={progress.exchange.response} />
          )}
          {returned?.status === "failed" && (
            <Button
              label="Retry answer delivery"
              size="compact"
              disabled={!chat.controls.canEdit}
              onPress={() => void chat.controls.act({ type: "delivery.retry", id: returned.id })}
            />
          )}
        </>
      )}
      {progress.state === "answered" && (
        <Button
          label="Open specialist answer"
          size="compact"
          disabled={!canReadAnswer}
          onPress={() => chat.openSource(consultation.destination, progress.exchange.response)}
        />
      )}
    </View>
  );
}

function CrewRecordedAnswer({
  consultation,
  source,
}: {
  consultation: CrewConsultation;
  source: NonNullable<CrewConsultation["context"]["replyTo"]>;
}) {
  const { environmentId, projectId, threadId } = source.conversation;
  const thread = useEnvironmentThread(environmentId, threadId);
  const load = useAtomCommand(threadEnvironment.loadEarlierHistory, { reportFailure: false });
  const projection = Option.getOrNull(thread.data);
  const answer =
    projection?.thread.id === threadId &&
    projection.thread.projectId === projectId &&
    projection.thread.deletedAt === null &&
    source.actor === "agent"
      ? projection.messages.find(
          (message) =>
            message.id === source.messageId &&
            message.threadId === threadId &&
            message.role === "assistant" &&
            message.runId === source.runId &&
            !message.streaming,
        )
      : undefined;
  const [error, setError] = useState<string | null>(null);
  if (answer) return <ConsultationAnswer consultation={consultation} answer={answer.text} />;
  return (
    <>
      <AppText>
        {error ??
          (thread.status === "empty" || thread.status === "synchronizing"
            ? "Loading source answer…"
            : "The answer is outside the loaded source history.")}
      </AppText>
      {thread.history.hasMoreHistory && (
        <Button
          label="Load source answer"
          size="compact"
          disabled={thread.history.loading}
          onPress={() =>
            void load({
              environmentId,
              input: { threadId, throughEntryId: source.messageId },
            }).then((result) => {
              if (result._tag !== "Success") setError("Could not load the recorded answer.");
            })
          }
        />
      )}
    </>
  );
}

function ConsultationAnswer({
  consultation,
  answer,
}: {
  consultation: CrewConsultation;
  answer: string;
}) {
  const chat = useCrewChat()!;
  const [expanded, setExpanded] = useState(false);
  const { threadId } = consultation.destination;
  const canOpenSource =
    chat.canRead && sameCrewProject(chat.conversation, consultation.destination);
  const source = useCrewCollection(expanded && canOpenSource ? consultation.destination : null, {
    collection: "workstreams",
    threadId,
    limit: 1,
  });
  const name =
    source.data?.workstreams.find((entry) =>
      sameCrewConversation(consultation.destination, entry.conversation),
    )?.title ?? chat.threadName(threadId);
  if (consultation.progress.state !== "answered") return null;
  const { exchange } = consultation.progress;
  return (
    <View className="mx-4 mb-3 gap-2 rounded-xl border border-border p-3">
      <Button
        label={`From ${name}`}
        accessibilityHint={expanded ? "Hide source details" : "Show source details"}
        size="compact"
        tone="text"
        onPress={() => setExpanded(!expanded)}
      />
      <AppText selectable>{answer}</AppText>
      {expanded && (
        <>
          <AppText className="text-foreground-muted">
            {consultation.replyTo ? "Follow-up answer" : "Specialist answer"} ·{" "}
            {consultation.context.attachments.length} referenced attachments
          </AppText>
          <Button
            label="Open source answer"
            size="compact"
            disabled={
              !canOpenSource ||
              !sameCrewConversation(consultation.destination, exchange.response.conversation)
            }
            onPress={() => chat.openSource(consultation.destination, exchange.response)}
          />
          <Button
            label="Open source question"
            size="compact"
            disabled={
              !canOpenSource ||
              !sameCrewConversation(consultation.destination, exchange.request.conversation)
            }
            onPress={() => chat.openSource(consultation.destination, exchange.request)}
          />
          <Button
            label="View exchange details"
            size="compact"
            onPress={() => chat.openExchange("consultations", consultation.id)}
          />
          <Button
            label="Draft follow-up"
            size="compact"
            onPress={() => {
              const key = scopedThreadKey(
                chat.conversation.environmentId,
                chat.conversation.threadId,
              );
              const draft = getComposerDraftSnapshot(key);
              appendComposerDraftText(
                key,
                `${draft.text ? "\n\n" : ""}Following up with ${name} on consultation ${consultation.id} (answer ${exchange.responseId}) and the same context: `,
              );
            }}
          />
        </>
      )}
    </View>
  );
}

function HandoffCard({ handoff }: { handoff: CrewHandoff }) {
  const chat = useCrewChat()!;
  const ownership = handoff.ownership;
  const destination = chat.threadName(handoff.destination.threadId);
  const owner =
    ownership.state === "discussion-only"
      ? null
      : chat.threadName(ownership.assignment.owner.threadId);
  const delivery =
    ownership.state !== "discussion-only" && ownership.state !== "reconciled"
      ? chat.deliveries.find((item) => item.id === ownership.stopDeliveryId && item.kind === "stop")
      : undefined;
  return (
    <View className="gap-2 rounded-xl border border-border p-3">
      <AppText className="font-t3-semibold">{`Handoff · ${destination}`}</AppText>
      <AppText>
        {handoff.state === "cancelled"
          ? "Handoff cancelled"
          : handoff.state === "completed"
            ? "Handoff recorded"
            : owner
              ? `${owner} owns the current assignment. ${destination} is waiting for confirmation.`
              : "The coordinator proposed moving this discussion."}
      </AppText>
      {delivery?.status === "failed" && (
        <Button
          label="Retry owner stop"
          disabled={!chat.controls.canEdit}
          size="compact"
          onPress={() => void chat.controls.act({ type: "delivery.retry", id: delivery.id })}
        />
      )}
      <Button
        label="Open handoff message"
        size="compact"
        onPress={() => chat.openSource(chat.conversation, handoff.explanation)}
      />
      <Button
        label="View handoff details"
        size="compact"
        onPress={() => chat.openExchange("handoffs", handoff.id)}
      />
      <Button
        label={`Open ${destination}`}
        size="compact"
        disabled={!chat.canRead}
        onPress={() => chat.openSource(handoff.destination)}
      />
    </View>
  );
}
