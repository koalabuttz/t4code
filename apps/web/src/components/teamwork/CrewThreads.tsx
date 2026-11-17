import { useState } from "react";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  scopeThreadRef,
  scopedProjectKey,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import { crewLiveFreshness, isCrewCoordinatorCandidate } from "@t3tools/client-runtime/state/crew";
import { type ScopedProjectRef, type ThreadId } from "@t3tools/contracts";
import { crewExecutionLabels } from "@t3tools/shared/crewExecution";
import { hasUnseenCompletion, resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { useUiStateStore } from "../../uiStateStore";
import { classifyCrewSupervision } from "@t3tools/shared/crewSupervision";
import { useQuietThreadShells } from "../../state/entities";
import { useEnvironmentShellStatus } from "../../state/shell";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { crewSupervisionFacts } from "./crewPanel.logic";
import { crewSupervisionShells } from "./crewPanelState";
import {
  crewThreadRoute,
  useCrewCollection,
  useCrewConversationMutation,
  useCrewProject,
} from "./crewChatState";

const crewThreadBrowsing = Atom.family((_projectKey: string) =>
  Atom.make<{ filter: string; cursor?: string }>({ filter: "" }).pipe(Atom.keepAlive),
);

export function CrewThreads({ scope }: { scope: ScopedProjectRef }) {
  const { snapshot, query } = useCrewProject(scope);
  const projectKey = scopedProjectKey(scope);
  const [{ filter, cursor }, setBrowsing] = useAtom(crewThreadBrowsing(projectKey));
  const workstreams = useCrewCollection(scope, "workstreams", cursor ? { cursor } : {});
  const links = useCrewCollection(scope, "task-links");
  const [candidate, setCandidate] = useState("");
  const { act, disabled, error, retry } = useCrewConversationMutation(scope);
  const lastVisited = useUiStateStore((state) => state.threadLastVisitedAtById);
  const originHref = useRouterState({ select: (state) => state.location.href });
  const shells = useAtomValue(crewSupervisionShells(projectKey));
  const projectThreads = useQuietThreadShells().filter((shell) =>
    isCrewCoordinatorCandidate(scope, shell),
  );
  const connected = useEnvironmentShellStatus(scope.environmentId) === "live";
  if (!snapshot) return null;
  const freshness = crewLiveFreshness(connected, query);
  const facts = crewSupervisionFacts(snapshot, shells);
  const supervision = classifyCrewSupervision({
    snapshot,
    ...facts,
    deliveries: query.data?.deliveries ?? [],
    freshness,
  });
  const members = workstreams.data?.workstreams ?? [];
  const currentTasks = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const memberIds = new Set(members.map((member) => member.conversation.threadId));
  const groupedTasks = new Map<string, ThreadId>();
  for (const link of links.data?.taskLinks ?? [])
    groupedTasks.set(link.taskId, link.workstream.threadId);
  const rows = new Map(
    members
      .filter((member) => member.status !== "unlinked")
      .map(
        (member) =>
          [
            member.conversation.threadId,
            { id: member.conversation.threadId, title: member.title, membership: member.status },
          ] as const,
      ),
  );
  if (!cursor)
    for (const task of snapshot.tasks) {
      const id = task.ownerThreadId;
      if (
        !id ||
        id === snapshot.coordinatorThreadId ||
        memberIds.has(id) ||
        groupedTasks.has(task.id)
      )
        continue;
      rows.set(id, {
        id,
        title: projectThreads.find((shell) => shell.id === id)?.title ?? task.title,
        membership: "open",
      });
    }
  const groups = { "Needs you": [], Working: [], Waiting: [], Resolved: [] } as Record<
    string,
    React.ReactNode[]
  >;
  for (const row of rows.values()) {
    const shell = projectThreads.find((thread) => thread.id === row.id);
    const execution = facts.threadExecution.find((entry) => entry.threadId === row.id);
    const unread =
      shell &&
      hasUnseenCompletion({
        ...shell,
        lastVisitedAt: resolveThreadLastVisitedAt(
          shell.lastVisitedAt,
          lastVisited[scopedThreadKey(scopeThreadRef(scope.environmentId, row.id))],
        ),
      });
    const tasks = [...currentTasks.values()].filter(
      (task) => (groupedTasks.get(task.id) ?? task.ownerThreadId) === row.id,
    );
    const relevant = supervision.items.filter(
      (item) => item.threadId === row.id || tasks.some((task) => task.id === item.taskId),
    );
    const attention = relevant.find((item) => item.attention && item.responsibility !== "crew");
    const working = relevant.find((item) => item.underway);
    const stopped = relevant.every((item) => !item.underway && item.responsibility !== "unknown");
    const resolved =
      row.membership === "resolved" ||
      (tasks.length > 0 &&
        tasks.every((task) => task.status === "done" || task.status === "cancelled"));
    const group =
      attention ||
      freshness !== "current" ||
      !shell ||
      shell.deletedAt !== null ||
      execution?.needsAttention
        ? "Needs you"
        : working || execution?.state === "working" || execution?.state === "starting"
          ? "Working"
          : resolved && stopped
            ? "Resolved"
            : "Waiting";
    const update =
      attention?.label ??
      working?.label ??
      (freshness !== "current"
        ? "Execution unconfirmed"
        : !shell || shell.deletedAt !== null
          ? "Conversation unavailable"
          : (relevant[0]?.label ??
            (resolved
              ? "Resolved workstream"
              : execution
                ? crewExecutionLabels[execution.state]
                : "Execution unconfirmed")));
    if (!`${row.title} ${update}`.toLowerCase().includes(filter.trim().toLowerCase())) continue;
    const workstream = members.find((entry) => entry.conversation.threadId === row.id);
    groups[group]!.push(
      <li key={row.id} className="space-y-2 rounded-lg border px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            {shell?.deletedAt === null ? (
              <Link
                {...crewThreadRoute(scope, row.id)}
                state={{ crewSource: { projectKey, originHref } }}
                className="text-sm font-medium underline-offset-4 hover:underline"
              >
                {row.title}
              </Link>
            ) : (
              <span className="text-sm font-medium">{row.title}</span>
            )}
            <p className="text-xs text-muted-foreground">
              {unread ? "Unread update · " : ""}
              {update}
            </p>
          </div>
          {workstream ? (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() =>
                void act({
                  type: "workstream.status",
                  threadId: row.id,
                  status: row.membership === "resolved" ? "open" : "resolved",
                })
              }
            >
              {row.membership === "resolved" ? "Reopen thread" : "Resolve thread"}
            </Button>
          ) : null}
        </div>
        {tasks.length ? (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">Work and attempts</summary>
            <ul className="mt-1 space-y-1">
              {tasks.map((task) => (
                <li key={task.id}>
                  {task.title} Â· {task.status}
                  {task.attemptCount ? ` Â· ${task.attemptCount} attempts` : ""}
                  {task.ownerThreadId && task.ownerThreadId !== row.id ? (
                    <>
                      {" "}
                      Â·{" "}
                      <Link
                        {...crewThreadRoute(scope, task.ownerThreadId)}
                        state={{ crewSource: { projectKey, originHref } }}
                        className="underline"
                      >
                        Open current worker
                      </Link>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </li>,
    );
  }
  const candidates = projectThreads.filter(
    (thread) => thread.id !== snapshot.coordinatorThreadId && !memberIds.has(thread.id),
  );
  const candidateThread = candidates.find((thread) => thread.id === candidate);
  return (
    <section aria-label="Project workstreams" className="space-y-4">
      <Input
        type="search"
        aria-label="Search work threads"
        placeholder="Search work threads"
        value={filter}
        onChange={(event) =>
          setBrowsing({ filter: event.target.value, ...(cursor ? { cursor } : {}) })
        }
      />
      {workstreams.error || links.error || error ? (
        <p role="alert" className="text-sm text-destructive">
          {error ?? workstreams.error ?? links.error}
        </p>
      ) : null}
      {retry ? (
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => void retry()}>
          Retry last request
        </Button>
      ) : null}
      {Object.entries(groups).map(([group, entries]) =>
        entries.length ? (
          <section key={group} className="space-y-2">
            <h2 className="text-sm font-semibold">{group}</h2>
            <ul className="space-y-2">{entries}</ul>
          </section>
        ) : null,
      )}
      {workstreams.isSuccess && !Object.values(groups).some((entries) => entries.length) ? (
        <p className="text-sm text-muted-foreground">
          {filter ? "No matching work threads." : "No work threads are linked here yet."}
        </p>
      ) : null}
      <div className="flex gap-2">
        {cursor ? (
          <Button size="sm" variant="outline" onClick={() => setBrowsing({ filter })}>
            First page
          </Button>
        ) : null}
        {workstreams.data?.nextCursor ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const next = workstreams.data?.nextCursor;
              if (next) setBrowsing({ filter, cursor: next });
            }}
          >
            Next page
          </Button>
        ) : null}
      </div>
      <details className="rounded-lg border p-4 text-sm">
        <summary className="cursor-pointer font-medium">Link an existing conversation</summary>
        <form
          className="mt-2 flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (candidateThread && !disabled)
              void act({
                type: "workstream.link",
                threadId: candidateThread.id,
                title: candidateThread.title.trim().slice(0, 160) || "Work thread",
              });
          }}
        >
          <label>
            Conversation{" "}
            <select
              className="max-w-60 rounded border bg-background px-2 py-1"
              value={candidate}
              onChange={(event) => setCandidate(event.target.value)}
            >
              <option value="">Choose a conversation</option>
              {candidates.map((thread) => (
                <option key={thread.id} value={thread.id}>
                  {thread.title}
                </option>
              ))}
            </select>
          </label>
          <Button size="sm" type="submit" disabled={disabled || !candidateThread}>
            Link conversation
          </Button>
        </form>
      </details>
    </section>
  );
}
