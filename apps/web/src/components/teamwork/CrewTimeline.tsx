import { createContext, use, type ReactNode } from "react";
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
  CrewHandoff,
  CrewMessageRef,
} from "@t3tools/contracts/crewConversation";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import { assistantCitationRoute } from "../../lib/assistantCitationNavigation";
import { useQuietThreadShell } from "../../state/entities";
import { Button } from "../ui/button";
import type { ChatMessage } from "../../types";
import { crewChatExchanges, crewReturnedAnswer } from "./crewChat.logic";
import {
  crewThreadRoute,
  useCrewCollection,
  useCrewConversationMutation,
  useCrewProject,
} from "./crewChatState";

type DeliveryStatus = TeamworkReadResult["deliveries"][number]["status"];

const CrewTimelineContext = createContext<{
  scope: ScopedProjectRef;
  exchanges: ReturnType<typeof crewChatExchanges>;
  deliveries: ReadonlyMap<string, DeliveryStatus>;
} | null>(null);
const expandedCrewAnswers = Atom.family((_threadKey: string) =>
  Atom.make<readonly string[]>([]).pipe(Atom.keepAlive),
);

export function CrewTimeline({
  scope,
  threadId,
  children,
}: {
  scope: ScopedProjectRef | null;
  threadId: ThreadId | null;
  children: ReactNode;
}) {
  const filter = threadId ? { threadId } : {};
  const consultations = useCrewCollection(threadId ? scope : null, "consultations", filter);
  const handoffs = useCrewCollection(threadId ? scope : null, "handoffs", filter);
  const { query } = useCrewProject(scope);
  const value =
    scope && threadId
      ? {
          scope,
          exchanges: crewChatExchanges(
            scope,
            threadId,
            consultations.data?.consultations ?? [],
            handoffs.data?.handoffs ?? [],
          ),
          deliveries: new Map(
            query.data?.deliveries
              .filter((delivery) => delivery.threadId === threadId && delivery.kind === "message")
              .map((delivery) => [delivery.id, delivery.status]),
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
  const { scope, exchanges, deliveries } = context;
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
        />
      ))}
    </>
  );
}

function CrewAnswer({
  scope,
  consultation,
  response,
  answer,
}: {
  scope: ScopedProjectRef;
  consultation: CrewConsultation;
  response: CrewMessageRef;
  answer: string;
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
      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{answer}</p>
    </article>
  );
}

function CrewConsultationStatus({
  scope,
  consultation,
  returned,
}: {
  scope: ScopedProjectRef;
  consultation: CrewConsultation;
  returned: DeliveryStatus | undefined;
}) {
  const destination = useQuietThreadShell(consultation.destination);
  const name = destination?.title ?? "work thread";
  const progress = consultation.progress;
  if (progress.state === "answered") {
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
