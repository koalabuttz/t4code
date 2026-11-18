import { createContext, use, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  type ScopedProjectRef,
  type TeamworkReadResult,
  type ThreadId,
  type MessageId,
} from "@t3tools/contracts";
import type {
  CrewConsultation,
  CrewHandoff,
  CrewMessageRef,
} from "@t3tools/contracts/crewConversation";
import { scopedProjectKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { assistantCitationRoute } from "../../lib/assistantCitationNavigation";
import {
  useQuietThreadProjection,
  useQuietThreadShell,
  useThreadVisibleTurnItems,
} from "../../state/entities";
import type { TimelineEntry } from "../../session-logic";
import { useCitedMessageHistory } from "../chat/citationProcedure";
import { Button } from "../ui/button";
import type { ChatMessage } from "../../types";
import {
  crewChatExchanges,
  crewReturnLookupId,
  crewReturnedAnswer,
  crewUndeliveredAnswerSource,
} from "./crewChat.logic";
import {
  crewThreadRoute,
  useCrewCollection,
  useCrewConversationMutation,
  useCrewProject,
  useCrewTimelineMetadata,
} from "./crewChatState";

type DeliveryStatus = TeamworkReadResult["deliveries"][number]["status"];

const CrewTimelineContext = createContext<{
  scope: ScopedProjectRef;
  threadId: ThreadId;
  exchanges: ReturnType<typeof crewChatExchanges>;
  deliveries: ReadonlyMap<string, DeliveryStatus>;
  returnedMessages: ReadonlySet<string>;
  queuedMessageIds: ReadonlySet<MessageId>;
  onVisibleMessages: (ids: readonly MessageId[]) => void;
} | null>(null);
const expandedCrewAnswers = Atom.family((_threadKey: string) =>
  Atom.make<readonly string[]>([]).pipe(Atom.keepAlive),
);

export function useCrewTimelineVisibility() {
  return use(CrewTimelineContext)?.onVisibleMessages;
}

export function CrewTimeline({
  scope,
  threadId,
  entries,
  children,
}: {
  scope: ScopedProjectRef | null;
  threadId: ThreadId | null;
  entries: readonly TimelineEntry[];
  children: ReactNode;
}) {
  const { query, snapshot } = useCrewProject(scope);
  const projection = useQuietThreadProjection(
    scope && threadId ? scopeThreadRef(scope.environmentId, threadId) : null,
  )?.projection;
  const queuedMessageIds =
    projection?.runs.filter((run) => run.status === "queued").map((run) => run.userMessageId) ?? [];
  const metadata = useCrewTimelineMetadata(scope, threadId, snapshot?.revision, queuedMessageIds);
  const deliveries = new Map(
    query.data?.deliveries
      .filter((delivery) => delivery.threadId === threadId && delivery.kind === "message")
      .map((delivery) => [delivery.id, delivery.status]),
  );
  const exchanges =
    scope && threadId
      ? crewChatExchanges(
          scope,
          threadId,
          metadata.data?.consultations ?? [],
          metadata.data?.handoffs ?? [],
          metadata.data?.messageIds ?? [],
        )
      : null;
  const returnsToCheck = new Set<string>();
  for (const id of exchanges?.byReturn.keys() ?? []) {
    const delivery = deliveries.get(id);
    if (delivery === "pending" || delivery === "failed") returnsToCheck.add(id);
  }
  const value =
    scope && threadId && exchanges
      ? {
          scope,
          threadId,
          exchanges,
          deliveries,
          queuedMessageIds: new Set(queuedMessageIds),
          onVisibleMessages: metadata.onVisibleMessages,
          returnedMessages: new Set(
            returnsToCheck.size === 0
              ? []
              : entries.flatMap((entry) =>
                  entry.kind === "message" &&
                  returnsToCheck.has(entry.message.id) &&
                  crewReturnedAnswer(entry.message, exchanges.byReturn.get(entry.message.id)) !==
                    null
                    ? [entry.message.id]
                    : [],
                ),
          ),
        }
      : null;
  return (
    <CrewTimelineContext value={value}>
      {metadata.error ? (
        <div role="status" className="flex items-center gap-2 px-3 text-xs text-muted-foreground">
          <p>{metadata.error}</p>
          <Button size="xs" variant="outline" onClick={metadata.refresh}>
            Retry exchanges
          </Button>
        </div>
      ) : null}
      {children}
    </CrewTimelineContext>
  );
}

export function CrewQueuedHandoffs() {
  const context = use(CrewTimelineContext);
  if (!context) return null;
  return [...context.exchanges.byHandoffMessage].map(([messageId, handoff]) =>
    context.queuedMessageIds.has(messageId) ? (
      <CrewHandoffEntry key={handoff.id} scope={context.scope} handoff={handoff} />
    ) : null,
  );
}

export function CrewTimelineMessage({
  message,
  children,
}: {
  message: ChatMessage;
  children: ReactNode;
}) {
  const context = use(CrewTimelineContext);
  if (!context) return children;
  const { scope, threadId, exchanges, deliveries, returnedMessages } = context;
  const consultation = exchanges.byReturn.get(message.id);
  const answer = crewReturnedAnswer(message, consultation);
  if (answer !== null && consultation?.progress.state === "answered") {
    return (
      <CrewAnswer
        scope={scope}
        consultation={consultation}
        response={consultation.progress.exchange.response}
        answer={answer}
      />
    );
  }
  const lookupId = consultation ? null : crewReturnLookupId(message, scope);
  if (lookupId)
    return (
      <CrewHistoricalReturn scope={scope} threadId={threadId} id={lookupId} message={message}>
        {children}
      </CrewHistoricalReturn>
    );
  const handoff = exchanges.byHandoffMessage.get(message.id);
  const origins = exchanges.byOrigin.get(message.id);
  return (
    <>
      {children}
      {handoff && !context.queuedMessageIds.has(message.id) ? (
        <CrewHandoffEntry scope={scope} handoff={handoff} />
      ) : null}
      {origins?.map((record) => (
        <CrewConsultationStatus
          key={record.id}
          scope={scope}
          consultation={record}
          returned={deliveries.get(`${record.deliveryId}:return`)}
          hasReturnedMessage={returnedMessages.has(`${record.deliveryId}:return`)}
        />
      ))}
    </>
  );
}

function CrewHistoricalReturn({
  scope,
  threadId,
  id,
  message,
  children,
}: {
  scope: ScopedProjectRef;
  threadId: ThreadId;
  id: string;
  message: ChatMessage;
  children: ReactNode;
}) {
  const query = useCrewCollection(scope, "consultations", { id, threadId, limit: 1 });
  const record = crewChatExchanges(
    scope,
    threadId,
    query.data?.consultations ?? [],
    [],
  ).byReturn.get(message.id);
  const answer = crewReturnedAnswer(message, record);
  if (answer !== null && record?.progress.state === "answered") {
    return (
      <CrewAnswer
        scope={scope}
        consultation={record}
        response={record.progress.exchange.response}
        answer={answer}
      />
    );
  }
  if (query.error)
    return (
      <div className="space-y-1">
        {children}
        <Button size="xs" variant="outline" onClick={query.refresh}>
          Retry source attribution
        </Button>
      </div>
    );
  return query.isSuccess ? (
    children
  ) : (
    <p role="status" className="text-xs text-muted-foreground">
      Loading consultation source…
    </p>
  );
}

function CrewAnswer({
  scope,
  consultation,
  response,
  answer,
  returnStatus,
}: {
  scope: ScopedProjectRef;
  consultation: CrewConsultation;
  response: CrewMessageRef;
  answer: string;
  returnStatus?: "failed" | "pending";
}) {
  const shell = useQuietThreadShell(response.conversation);
  const originHref = useRouterState({ select: (state) => state.location.href });
  const projectKey = scopedProjectKey(scope);
  const [expanded, setExpanded] = useAtom(
    expandedCrewAnswers(`${projectKey}:${consultation.origin.conversation.threadId}`),
  );
  const open = expanded.includes(consultation.id);
  const quote = answer.slice(0, ASSISTANT_CITATION_MAX_TEXT_LENGTH);
  const source = quote.trim()
    ? assistantCitationRoute(
        {
          version: 1,
          ...response.conversation,
          messageId: response.messageId,
          text: quote,
          start: 0,
          end: quote.length,
          prefix: "",
          suffix: "",
        },
        shell,
      )
    : crewThreadRoute(scope, response.conversation.threadId);
  return (
    <article
      className="my-1 min-w-0 space-y-2 rounded-lg border bg-card px-3 py-2"
      aria-label="Specialist answer"
    >
      <details
        className="text-sm"
        open={open}
        onToggle={(event) => {
          const next = event.currentTarget.open;
          if (next !== open)
            setExpanded(
              next
                ? [...expanded.slice(-49), consultation.id]
                : expanded.filter((id) => id !== consultation.id),
            );
        }}
      >
        <summary className="cursor-pointer font-medium">
          From {shell?.title ?? "work thread"}
        </summary>
        <div className="mt-2 space-y-1 text-xs text-muted-foreground">
          <p>{consultation.replyTo ? "Follow-up answer" : "Consultation answer"}</p>
          <Link
            {...source}
            state={{ crewSource: { projectKey, originHref } }}
            className="text-foreground underline underline-offset-4"
          >
            Open source answer
          </Link>
        </div>
      </details>
      {returnStatus ? (
        <p role="status" className="text-xs text-muted-foreground">
          Read from the source conversation.{" "}
          {returnStatus === "failed" ? "Return delivery failed." : "Return delivery is queued."}
        </p>
      ) : null}
      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{answer}</p>
    </article>
  );
}

function CrewConsultationStatus({
  scope,
  consultation,
  returned,
  hasReturnedMessage,
}: {
  scope: ScopedProjectRef;
  consultation: CrewConsultation;
  returned: DeliveryStatus | undefined;
  hasReturnedMessage: boolean;
}) {
  const destination = useQuietThreadShell(consultation.destination);
  const name = destination?.title ?? "work thread";
  const progress = consultation.progress;
  if (progress.state === "answered") {
    if (hasReturnedMessage) return null;
    const source = crewUndeliveredAnswerSource(consultation, returned, hasReturnedMessage);
    if (source && (returned === "pending" || returned === "failed"))
      return (
        <CrewUndeliveredAnswer
          scope={scope}
          consultation={consultation}
          source={source}
          returnStatus={returned}
        />
      );
    if (returned !== "pending" && returned !== "failed") return null;
    return (
      <p className="my-1 px-1 text-xs text-muted-foreground">
        {returned === "pending"
          ? `Answer from ${name} is queued for this conversation`
          : `Answer from ${name} could not reach this conversation. See delivery recovery in Project chat.`}
      </p>
    );
  }
  return (
    <div className="my-1 space-y-1 px-1 text-xs text-muted-foreground">
      <p>
        {progress.state === "queued"
          ? `Waiting to reach ${name}`
          : progress.state === "delivered"
            ? `Waiting for a reply from ${name}`
            : progress.state === "failed"
              ? `Consultation with ${name} failed. ${progress.detail}`
              : `Consultation with ${name} cancelled`}
      </p>
      {progress.state === "failed" ? (
        <RetryConsultation scope={scope} consultation={consultation} />
      ) : null}
    </div>
  );
}

function CrewUndeliveredAnswer({
  scope,
  consultation,
  source,
  returnStatus,
}: {
  scope: ScopedProjectRef;
  consultation: CrewConsultation;
  source: CrewMessageRef;
  returnStatus: "failed" | "pending";
}) {
  const ref = source.conversation;
  const projection = useQuietThreadProjection(ref);
  const sameProject = projection?.projection.thread.projectId === scope.projectId;
  const items = useThreadVisibleTurnItems(sameProject ? ref : null);
  const history = useCitedMessageHistory(
    projection && !sameProject
      ? null
      : {
          key: `crew-return:${consultation.deliveryId}`,
          ...ref,
          messageId: source.messageId,
          reportFailure: false,
        },
  );
  const answer = items.find(
    ({ item }) =>
      item.type === "assistant_message" &&
      item.messageId === source.messageId &&
      item.runId === source.runId &&
      !item.streaming,
  )?.item;
  if (answer?.type === "assistant_message" && answer.text.trim()) {
    return (
      <CrewAnswer
        scope={scope}
        consultation={consultation}
        response={source}
        answer={answer.text.slice(0, 10_000)}
        returnStatus={returnStatus}
      />
    );
  }
  const unavailable = history._tag !== "loading" || (projection && !sameProject);
  const statusText =
    returnStatus === "failed" ? "Return delivery failed." : "Return delivery is queued.";
  return (
    <p role="status" className="my-1 px-1 text-xs text-muted-foreground">
      {unavailable
        ? `${statusText} The recorded answer is unavailable from its source.`
        : `${statusText} Loading the recorded answer from its source…`}
    </p>
  );
}

function RetryConsultation({
  scope,
  consultation,
}: {
  scope: ScopedProjectRef;
  consultation: CrewConsultation;
}) {
  const { act, disabled, error, retry } = useCrewConversationMutation(scope);
  return (
    <>
      <Button
        size="xs"
        variant="outline"
        disabled={disabled}
        onClick={() =>
          void act({
            type: "consultation.retry",
            id: consultation.id,
            previousDeliveryId: consultation.deliveryId,
          })
        }
      >
        Retry consultation
      </Button>
      {error ? <p role="alert">{error}</p> : null}
      {retry ? (
        <Button size="xs" variant="outline" disabled={disabled} onClick={() => void retry()}>
          Retry last request
        </Button>
      ) : null}
    </>
  );
}

function CrewHandoffEntry({ scope, handoff }: { scope: ScopedProjectRef; handoff: CrewHandoff }) {
  const destination = useQuietThreadShell(handoff.destination);
  const owner = useQuietThreadShell(
    "assignment" in handoff.ownership ? handoff.ownership.assignment.owner : null,
  );
  const projectKey = scopedProjectKey(scope);
  const originHref = useRouterState({ select: (state) => state.location.href });
  return (
    <aside
      className="my-1 space-y-1 rounded-lg border bg-card px-3 py-2 text-sm"
      aria-label="Crew handoff"
    >
      <p className="font-medium">
        {handoff.state === "cancelled"
          ? "Handoff cancelled"
          : `Handoff to ${destination?.title ?? "work thread"}`}
      </p>
      {"assignment" in handoff.ownership &&
      handoff.ownership.state !== "reconciled" &&
      handoff.state !== "cancelled" ? (
        <p className="text-muted-foreground">
          {owner?.title ?? "The current owner"} retains the assignment. The destination is held
          until the stop is confirmed.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3 text-xs">
        <Link
          to="/projects/$projectKey/crew"
          params={{ projectKey }}
          search={{ view: "settings", section: "advanced", handoff: handoff.id }}
          state={{ crewSource: { projectKey, originHref } }}
          className="underline underline-offset-4"
        >
          Inspect handoff
        </Link>
        <Link
          {...crewThreadRoute(scope, handoff.destination.threadId)}
          state={{ crewSource: { projectKey, originHref } }}
          className="underline underline-offset-4"
        >
          Open destination
        </Link>
      </div>
    </aside>
  );
}
