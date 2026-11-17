import { createContext, use, useEffect, useState, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  type ScopedProjectRef,
  type TeamworkReadResult,
  type ThreadId,
} from "@t3tools/contracts";
import type {
  CrewConsultation,
  CrewConversationPage,
  CrewHandoff,
  CrewMessageRef,
} from "@t3tools/contracts/crewConversation";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { assistantCitationRoute } from "../../lib/assistantCitationNavigation";
import {
  useQuietThreadProjection,
  useQuietThreadShell,
  useThreadVisibleTurnItems,
} from "../../state/entities";
import type { TimelineEntry } from "../../session-logic";
import { useCitedMessageHistory } from "../chat/citationProcedure";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
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
} from "./crewChatState";

type DeliveryStatus = TeamworkReadResult["deliveries"][number]["status"];

const CrewTimelineContext = createContext<{
  scope: ScopedProjectRef;
  threadId: ThreadId;
  exchanges: ReturnType<typeof crewChatExchanges>;
  deliveries: ReadonlyMap<string, DeliveryStatus>;
  returnedMessages: ReadonlySet<string>;
} | null>(null);
const expandedCrewAnswers = Atom.family((_threadKey: string) =>
  Atom.make<readonly string[]>([]).pipe(Atom.keepAlive),
);

function useDeferredReturnRecords(
  scope: ScopedProjectRef | null,
  threadId: ThreadId | null,
  page: CrewConversationPage | null,
  deliveries: ReadonlyMap<string, DeliveryStatus>,
) {
  const included = new Set(
    page?.consultations.map((consultation) => `${consultation.deliveryId}:return`),
  );
  const wanted = [...deliveries]
    .filter(
      ([id, status]) =>
        scope &&
        id.startsWith(`crew:${scope.projectId}:`) &&
        id.endsWith(":return") &&
        (status === "pending" || status === "failed") &&
        !included.has(id),
    )
    .map(([id]) => id)
    .sort();
  const key =
    scope && threadId && page?.nextCursor && wanted.length > 0
      ? JSON.stringify({ scope, threadId, cursor: page.nextCursor, wanted })
      : null;
  const [recovered, setRecovered] = useState<{
    key: string;
    records: readonly CrewConsultation[];
  } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Search bounded pages only for known outstanding return deliveries, and cancel when the conversation changes.
  useEffect(() => {
    if (!key) return;
    const target = JSON.parse(key) as {
      scope: ScopedProjectRef;
      threadId: ThreadId;
      cursor: string;
      wanted: string[];
    };
    const controller = new AbortController();
    const remaining = new Set(target.wanted);
    const records: CrewConsultation[] = [];
    void (async () => {
      let cursor: string | null = target.cursor;
      while (cursor && remaining.size > 0 && !controller.signal.aborted) {
        const currentCursor: string = cursor;
        const result = await executeAtomQuery(
          appAtomRegistry,
          serverEnvironment.crewConversations({
            environmentId: target.scope.environmentId,
            input: {
              scope: target.scope,
              collection: "consultations",
              threadId: target.threadId,
              limit: 100,
              cursor: currentCursor,
            },
          }),
          {
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(6_000)]),
            reportFailure: false,
          },
        );
        if (result._tag === "Failure") break;
        for (const record of result.value.consultations) {
          if (
            record.origin.conversation.threadId === target.threadId &&
            remaining.delete(`${record.deliveryId}:return`)
          )
            records.push(record);
        }
        cursor = result.value.nextCursor === currentCursor ? null : result.value.nextCursor;
      }
      if (!controller.signal.aborted) setRecovered({ key, records });
    })();
    return () => controller.abort();
  }, [key]);
  return recovered?.key === key ? (recovered?.records ?? []) : [];
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
  const filter = threadId ? { threadId } : {};
  const consultations = useCrewCollection(threadId ? scope : null, "consultations", filter);
  const handoffs = useCrewCollection(threadId ? scope : null, "handoffs", filter);
  const { query } = useCrewProject(scope);
  const deliveries = new Map(
    query.data?.deliveries
      .filter((delivery) => delivery.threadId === threadId && delivery.kind === "message")
      .map((delivery) => [delivery.id, delivery.status]),
  );
  const recovered = useDeferredReturnRecords(scope, threadId, consultations.data, deliveries);
  const exchanges =
    scope && threadId
      ? crewChatExchanges(
          scope,
          threadId,
          [...(consultations.data?.consultations ?? []), ...recovered],
          handoffs.data?.handoffs ?? [],
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
  return <CrewTimelineContext value={value}>{children}</CrewTimelineContext>;
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
  const handoff = exchanges.byExplanation.get(message.id);
  const origins = exchanges.byOrigin.get(message.id);
  return (
    <>
      {children}
      {handoff ? <CrewHandoffEntry scope={scope} handoff={handoff} /> : null}
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
