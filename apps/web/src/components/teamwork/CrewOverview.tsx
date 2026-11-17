import type { TeamworkSnapshot, ThreadId } from "@t3tools/contracts";
import type { classifyCrewSupervision, CrewSupervisionItem } from "@t3tools/shared/crewSupervision";
import { crewDeliveryNotice } from "@t3tools/shared/crewArtifacts";
import { Button } from "../ui/button";

export function CrewOverview({
  supervision,
  state,
  initiativeId,
  disabled,
  onAction,
  onStart,
  threadTitle,
}: {
  supervision: ReturnType<typeof classifyCrewSupervision>;
  state: TeamworkSnapshot;
  initiativeId: string | null;
  disabled: boolean;
  onAction: (item: CrewSupervisionItem) => void;
  onStart: () => void;
  threadTitle: (id: ThreadId) => string;
}) {
  const summary = supervision.initiatives.find((entry) => entry.initiativeId === initiativeId);
  const actor = (item: CrewSupervisionItem) =>
    item.actor.kind === "human"
      ? "You"
      : item.actor.kind === "agent"
        ? threadTitle(item.actor.threadId)
        : "Responsibility unknown";
  const itemView = (item: CrewSupervisionItem) => (
    <li key={item.id} className="space-y-2 rounded border p-3">
      <p className="text-xs text-muted-foreground">
        {item.initiativeTitle ?? "Project crew"}
        {item.taskId
          ? ` · ${state.tasks.find((task) => task.id === item.taskId)?.title ?? item.taskId}`
          : ""}
      </p>
      <p className="text-sm font-medium">{item.label}</p>
      {item.threadId && <p className="text-xs">Conversation: {threadTitle(item.threadId)}</p>}
      <p className="text-sm">
        {actor(item)} ·{" "}
        {item.responsibility === "waiting"
          ? "Waiting on dependencies or delivery"
          : item.underway
            ? "Crew is handling it"
            : "No response in progress is confirmed"}
        {item.freshness !== "current"
          ? ` · ${item.freshness === "last-known" ? "Last known; refresh required" : "Execution unavailable"}`
          : ""}
      </p>
      {item.detail && <p className="whitespace-pre-wrap text-sm">{item.detail}</p>}
      {item.dependencyIds?.length ? (
        <p className="text-xs">
          Waiting for:{" "}
          {item.dependencyIds
            .map((id) => state.tasks.find((task) => task.id === id)?.title ?? id)
            .join(", ")}
        </p>
      ) : null}
      {item.action && (
        <Button
          size="sm"
          variant="outline"
          disabled={
            disabled &&
            ![
              "open-thread",
              "open-task",
              "select-coordinator",
              "refresh-connection",
              "resume",
              "approve-plan",
            ].includes(item.action.kind)
          }
          onClick={() => onAction(item)}
        >
          {item.action.kind === "open-thread"
            ? item.action.focus === "approval"
              ? "Open approval conversation"
              : item.action.focus === "input"
                ? "Open question conversation"
                : "Open conversation"
            : item.action.kind === "open-task"
              ? "Inspect work"
              : item.action.kind === "retry-delivery"
                ? "Retry delivery"
                : item.action.kind === "approve-plan"
                  ? "Inspect plan approval"
                  : item.action.kind === "resume"
                    ? "Inspect resume prerequisites"
                    : item.action.kind === "select-coordinator"
                      ? "Choose coordinator"
                      : "Refresh crew facts"}
        </Button>
      )}
      {item.action?.kind === "open-thread" && item.action.focus && (
        <p className="text-xs text-muted-foreground">
          Opens the correct conversation; find its pending{" "}
          {item.action.focus === "input" ? "question" : "approval"}
          {item.action.requestId ? ` (${item.action.requestId})` : ""}.
        </p>
      )}
    </li>
  );
  return (
    <section aria-label="Crew supervision" className="space-y-4">
      {summary ? (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">{summary.title}</h2>
          <p className="whitespace-pre-wrap text-sm">{summary.goal}</p>
          <p className="text-sm">
            Recorded initiative: {summary.status} · {summary.progress.accepted}/
            {summary.progress.total} tasks accepted · {summary.progress.needingReview} needing
            review · {summary.progress.milestonesAccepted}/{summary.progress.milestonesTotal}{" "}
            milestones verified
          </p>
          <p className="text-sm">
            Activity:{" "}
            {summary.progress.running === null
              ? "current execution unavailable"
              : `${summary.progress.running} workers running · ${summary.progress.starting} starting · ${summary.progress.finished} finished`}
            {summary.progress.executionUnknown > 0
              ? ` · ${summary.progress.executionUnknown} execution states unknown`
              : ""}
          </p>
          <p className="text-sm">
            Project coordinator activity:{" "}
            {supervision.items.find((item) => item.id === "coordinator:execution")?.label ??
              "No current activity observed"}
          </p>
          {summary.pause.state !== "not-requested" && (
            <p role="status" className="text-sm font-medium">
              {summary.pause.state === "stopping"
                ? "Stopping workers…"
                : summary.pause.state === "failed"
                  ? "Pause requested; a worker stop failed"
                  : summary.pause.state === "unknown"
                    ? "Pause requested; stopped execution is unconfirmed"
                    : "Workers stopped; resume explicitly to continue"}
            </p>
          )}
          <p className="text-sm">
            <span className="font-medium">Next known step: </span>
            {summary.next
              ? `${summary.next.label} · ${actor(summary.next)}`
              : "No next step is recorded. Inspect tasks and milestone evidence."}
          </p>
          {summary.status === "completed" && (
            <p className="text-sm">
              {crewDeliveryNotice} Inspect accepted task outputs and milestone evidence below; any
              integration, merge or publication still needs its own evidence.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">What should the crew deliver?</h2>
          <p className="text-sm">
            Start with an outcome and success criteria. Choose an available project coordinator
            before starting.
          </p>
          <Button size="sm" onClick={onStart}>
            Start an initiative
          </Button>
        </div>
      )}
      <section aria-label="Project attention" className="space-y-2">
        <h3 className="font-medium">Project attention · {supervision.attention.length}</h3>
        {supervision.freshness !== "current" && (
          <p role="status" className="text-sm">
            Execution is last known or unavailable. Reconnect and refresh before relying on stopped
            or clear status.
          </p>
        )}
        {supervision.attention.length ? (
          <ul className="space-y-2">{supervision.attention.map(itemView)}</ul>
        ) : (
          <p className="text-sm">
            {supervision.clear
              ? "No current attention items."
              : "No confirmed attention items; responsibility or execution remains uncertain."}
          </p>
        )}
      </section>
      {summary?.items.some((item) => !item.attention) && (
        <details>
          <summary className="cursor-pointer text-sm">
            Activity, ownership and dependency waits
          </summary>
          <ul className="mt-2 space-y-2">
            {summary.items.filter((item) => !item.attention).map(itemView)}
          </ul>
        </details>
      )}
    </section>
  );
}
