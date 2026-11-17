import { useState } from "react";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import { crewLiveFreshness } from "@t3tools/client-runtime/state/crew";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  type ScopedProjectRef,
  type TeamworkAction,
  type ThreadId,
} from "@t3tools/contracts";
import type { CrewAttention } from "@t3tools/contracts/crewConversation";
import { classifyCrewSupervision } from "@t3tools/shared/crewSupervision";
import { randomUUID } from "../../lib/utils";
import { useEnvironmentShellStatus } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import {
  crewThreadRoute,
  type CrewDestination,
  useCrewCollection,
  useCrewProject,
} from "./crewChatState";
import { crewSupervisionFacts } from "./crewPanel.logic";
import { crewSupervisionShells } from "./crewPanelState";

export function CrewNavigation({
  scope,
  view,
  coordinatorThreadId,
}: {
  scope: ScopedProjectRef;
  view?: CrewDestination | undefined;
  coordinatorThreadId?: ThreadId | null;
}) {
  const projectKey = scopedProjectKey(scope);
  return (
    <nav aria-label="Crew project" className="flex flex-wrap items-center gap-1">
      <Button
        variant={view === "chat" ? "secondary" : "ghost"}
        size="sm"
        render={
          coordinatorThreadId ? (
            <Link
              {...crewThreadRoute(scope, coordinatorThreadId)}
              aria-current={view === "chat" ? "page" : undefined}
            />
          ) : (
            <Link
              to="/projects/$projectKey/crew"
              params={{ projectKey }}
              aria-current={view === "chat" ? "page" : undefined}
            />
          )
        }
      >
        Project chat
      </Button>
      {(["threads", "results", "settings"] as const).map((destination) => (
        <Button
          key={destination}
          variant={view === destination ? "secondary" : "ghost"}
          size="sm"
          render={
            <Link
              to="/projects/$projectKey/crew"
              params={{ projectKey }}
              search={{ view: destination }}
              aria-current={view === destination ? "page" : undefined}
            />
          }
        >
          {destination[0]!.toUpperCase() + destination.slice(1)}
        </Button>
      ))}
    </nav>
  );
}

export function CrewChatControls({
  scope,
  threadId,
  coordinator,
  workstreamTitle,
}: {
  scope: ScopedProjectRef;
  threadId: ThreadId;
  coordinator: boolean;
  workstreamTitle: string | null;
}) {
  const { snapshot, query } = useCrewProject(scope);
  const connected = useEnvironmentShellStatus(scope.environmentId) === "live";
  const projectKey = scopedProjectKey(scope);
  const shells = useAtomValue(crewSupervisionShells(projectKey));
  const router = useRouter();
  const origin = useRouterState({ select: (state) => state.location.state.crewSource });
  const originHref = useRouterState({ select: (state) => state.location.href });
  const attention = useCrewCollection(coordinator ? scope : null, "attention");
  const direct = useCrewCollection(coordinator ? null : scope, "attention", { threadId });
  const permission = useAtomValue(
    serverEnvironment.mutateTeamwork.permissionAtom(scope.environmentId),
  );
  const mutate = useAtomCommand(serverEnvironment.mutateTeamwork, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!snapshot) return null;
  const freshness = crewLiveFreshness(connected, query);
  const supervision = classifyCrewSupervision({
    snapshot,
    ...crewSupervisionFacts(snapshot, shells),
    deliveries: query.data?.deliveries ?? [],
    freshness,
  });
  const active = supervision.initiatives.filter((initiative) => initiative.status === "active");
  const activity = supervision.items.find((item) => item.id === "coordinator:execution");
  const ownsWork = snapshot.tasks.some(
    (task) =>
      task.ownerThreadId === threadId && ["running", "blocked", "review"].includes(task.status),
  );
  const pendingRequests = new Map(
    (attention.data?.attention ?? []).flatMap((entry) => {
      const request = entry.pendingRequest;
      const shell = shells.find((candidate) => candidate.id === entry.source.conversation.threadId);
      return request &&
        shell?.deletedAt === null &&
        shell.pendingRuntimeRequest?.id === request.requestId &&
        entry.coordinator.threadId === threadId
        ? [
            [
              JSON.stringify([shell.id, request.runId, request.requestId]),
              { request, entry, shell },
            ] as const,
          ]
        : [];
    }),
  );
  const directAttention = (direct.data?.attention ?? [])
    .filter((entry) => entry.reason === "user-message")
    .reduce<CrewAttention | null>(
      (latest, next) => (latest === null || next.createdAt > latest.createdAt ? next : latest),
      null,
    );
  const act = async (action: TeamworkAction) => {
    setBusy(true);
    setError(null);
    const result = await mutate({
      environmentId: scope.environmentId,
      input: {
        projectId: scope.projectId,
        expectedRevision: snapshot.revision,
        commandId: CommandId.make(randomUUID()),
        action,
      },
    });
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not save the Crew action.");
    }
    setBusy(false);
  };
  const unavailable = !connected || freshness !== "current";
  return (
    <section
      aria-label={coordinator ? "Project conversation" : "Crew work thread"}
      className="space-y-2 border-b px-(--workspace-gutter-start) py-2 pr-(--workspace-gutter-end)"
    >
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <CrewNavigation
          scope={scope}
          view={coordinator ? "chat" : undefined}
          coordinatorThreadId={snapshot.coordinatorThreadId}
        />
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {origin?.projectKey === projectKey && origin.originHref !== originHref ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void router.navigate({ href: origin.originHref })}
            >
              Return to origin
            </Button>
          ) : null}
          {coordinator ? "Coordinator" : (workstreamTitle ?? "Crew work thread")}
          {coordinator && !unavailable && activity ? <span>{activity.label}</span> : null}
          {!coordinator && ownsWork ? <span>Implementation owner</span> : null}
          {unavailable ? (
            <span role="status">
              {connected ? "Execution last known" : "Offline · execution unconfirmed"}
            </span>
          ) : null}
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {coordinator ? (
        <div className="flex max-h-36 flex-wrap items-center gap-2 overflow-y-auto">
          {active.map((initiative) => (
            <Button
              key={initiative.initiativeId}
              size="sm"
              variant="outline"
              disabled={busy || !permission || unavailable}
              title={initiative.title}
              onClick={() =>
                void act({
                  type: "initiative.status",
                  id: initiative.initiativeId,
                  status: "paused",
                })
              }
            >
              {active.length === 1 ? "Pause work" : `Pause ${initiative.title}`}
            </Button>
          ))}
          {supervision.items
            .filter(
              (item) =>
                item.kind === "plan-approval" ||
                item.kind === "resume" ||
                item.kind === "stop-failed" ||
                item.kind === "stop-pending" ||
                item.kind === "stopping" ||
                item.kind === "message-failed",
            )
            .slice(0, 8)
            .map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-2 rounded border px-2 py-1 text-xs"
              >
                <span>
                  {item.label}
                  {item.initiativeTitle ? ` · ${item.initiativeTitle}` : ""}
                </span>
                {item.action?.kind === "retry-delivery" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !permission || unavailable}
                    onClick={() =>
                      item.action?.kind === "retry-delivery" &&
                      void act({ type: "delivery.retry", id: item.action.deliveryId })
                    }
                  >
                    Retry delivery
                  </Button>
                ) : (
                  <Link
                    to="/projects/$projectKey/crew"
                    params={{ projectKey }}
                    search={{ view: "settings", section: "crew" }}
                    className="underline underline-offset-4"
                  >
                    Inspect
                  </Link>
                )}
              </div>
            ))}
          {!unavailable
            ? [...pendingRequests]
                .filter(([, { shell }]) => shell.id !== threadId)
                .map(([key, { request, entry, shell }]) => (
                  <Button
                    key={key}
                    size="sm"
                    variant="outline"
                    render={
                      <Link
                        {...crewThreadRoute(scope, shell.id)}
                        state={{
                          crewRequestId: request.requestId,
                          crewRequestRunId: request.runId,
                          crewSource: { projectKey, originHref },
                        }}
                      />
                    }
                  >
                    {entry.reason === "approval"
                      ? "Review approval"
                      : entry.pendingRequest?.responder === "user-only"
                        ? "Open user-only request"
                        : "Open question"}{" "}
                    · {shell.title}
                  </Button>
                ))
            : null}
        </div>
      ) : directAttention && directAttention.progress.state !== "considered" ? (
        <p className="text-xs text-muted-foreground">
          {directAttention.progress.state === "failed"
            ? "Coordinator delivery failed"
            : "Coordinator attention recorded · awaiting consideration"}
        </p>
      ) : null}
    </section>
  );
}
