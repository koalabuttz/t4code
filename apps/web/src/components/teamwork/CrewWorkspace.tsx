import { useLayoutEffect, useRef } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { parseScopedProjectKey, scopedProjectKey } from "@t3tools/client-runtime/environment";
import {
  crewCandidateThread,
  crewOriginThread,
  crewReturnContext,
  crewScrollOffset,
  crewSelectedTask,
  isCrewCoordinatorCandidate,
  resolveCrewCoordinator,
} from "@t3tools/client-runtime/state/crew";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { useProject, useThreadShellsForProjectRefs } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { SidebarInset, useSidebar } from "../ui/sidebar";
import { cn } from "../../lib/utils";
import { observeResize } from "../../lib/observeResize";
import { TeamworkPanel } from "./TeamworkPanel";

export function CrewWorkspace() {
  const { projectKey } = useParams({ from: "/_chat/projects/$projectKey/crew" });
  const projectRef = parseScopedProjectKey(projectKey);
  const scrollRef = useRef<HTMLElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Restore the route's DOM scroll position after the project content loads.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const restore = () => {
      element.scrollTop = appAtomRegistry.get(crewScrollOffset(projectKey));
    };
    restore();
    let stopObserving: (() => void) | undefined;
    const observeContent = () => {
      stopObserving?.();
      stopObserving = element.firstElementChild
        ? observeResize(element.firstElementChild, restore)
        : undefined;
      restore();
    };
    const contentObserver = new MutationObserver(observeContent);
    contentObserver.observe(element, { childList: true });
    observeContent();
    return () => {
      stopObserving?.();
      contentObserver.disconnect();
    };
  }, [projectKey]);
  return (
    <SidebarInset
      ref={scrollRef}
      className="h-dvh overflow-y-auto"
      onScroll={(event) => {
        const element = event.currentTarget;
        const saved = appAtomRegistry.get(crewScrollOffset(projectKey));
        const max = element.scrollHeight - element.clientHeight;
        if (saved > max && element.scrollTop === max) return;
        appAtomRegistry.set(crewScrollOffset(projectKey), element.scrollTop);
      }}
    >
      {projectRef ? (
        <ProjectCrew key={projectKey} projectRef={projectRef} />
      ) : (
        <p className="p-6">This Crew link does not identify a project and environment.</p>
      )}
    </SidebarInset>
  );
}

function ProjectCrew({ projectRef }: { projectRef: ScopedProjectRef }) {
  const navigate = useNavigate();
  const sidebar = useSidebar();
  const project = useProject(projectRef);
  const refs = [projectRef];
  const allThreads = useThreadShellsForProjectRefs(refs);
  const threads = allThreads.filter((thread) => isCrewCoordinatorCandidate(projectRef, thread));
  const projectKey = scopedProjectKey(projectRef);
  const [selected, setSelected] = useAtom(crewCandidateThread(projectKey));
  const originThreadId = useAtomValue(crewOriginThread(projectKey));
  const query = useEnvironmentQuery(
    serverEnvironment.teamworkLive({
      environmentId: projectRef.environmentId,
      input: { projectId: projectRef.projectId },
    }),
  );
  const coordinatorThreadId = query.data?.snapshot.coordinatorThreadId ?? null;
  const selection = resolveCrewCoordinator({
    project: projectRef,
    threads: allThreads,
    coordinatorThreadId,
    candidateThreadId: selected,
    originThreadId,
  });
  const handoverCandidate = selected ? threads.find((thread) => thread.id === selected) : null;
  const candidateId = handoverCandidate?.id ?? selection.threadId;
  const candidate = threads.find((thread) => thread.id === candidateId);
  const config = useAtomValue(serverEnvironment.configValueAtom(projectRef.environmentId));
  if (!config) return <p className="p-6">Connect to this environment to open its crew.</p>;
  if (!config.environment.capabilities.projectTeamwork)
    return (
      <p className="p-6">
        This server does not support Crew. Update the environment to use this workspace.
      </p>
    );
  if (!project)
    return <p className="p-6">This project is unavailable in the selected environment.</p>;
  return (
    <div
      className={cn(
        "mx-auto w-full max-w-6xl space-y-5 p-6",
        (sidebar.isMobile || sidebar.state === "collapsed") && "pt-14",
      )}
    >
      <header>
        <h1 className="text-xl font-semibold">Project crew</h1>
        <p className="text-sm text-muted-foreground">{project.title}</p>
      </header>
      {threads.length > 0 ? (
        <label className="block text-sm">
          {coordinatorThreadId
            ? "Conversation for explicit coordinator handover"
            : "Conversation to use when choosing a coordinator"}
          <select
            className="mt-1 block w-full rounded border bg-background p-2"
            value={candidateId ?? ""}
            disabled={query.data === null}
            onChange={(event) =>
              setSelected(threads.find((thread) => thread.id === event.target.value)?.id ?? null)
            }
          >
            <option value="">Choose a conversation</option>
            {coordinatorThreadId && !candidate && (
              <option value={coordinatorThreadId}>Existing coordinator (unavailable)</option>
            )}
            {threads.map((thread) => (
              <option key={thread.id} value={thread.id}>
                {thread.title}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="text-sm">Start a conversation in this project to choose a coordinator.</p>
      )}
      {selection.reason && (
        <p className="text-sm" role="status">
          {selection.reason}
        </p>
      )}
      {coordinatorThreadId && (
        <p className="text-sm text-muted-foreground">
          New initiatives reuse the existing coordinator. Choosing a conversation does not change
          it; use the handover controls to replace it explicitly.
        </p>
      )}
      <TeamworkPanel
        {...projectRef}
        threadId={query.data ? candidateId : null}
        onOpenThread={(threadId) => {
          const context = appAtomRegistry.get(crewReturnContext(projectKey));
          if (context?.threadId !== threadId)
            appAtomRegistry.set(crewReturnContext(projectKey), {
              threadId,
              taskId: appAtomRegistry.get(crewSelectedTask(projectKey)),
              kind: "conversation",
              requestId: null,
            });
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId: projectRef.environmentId, threadId },
          });
        }}
      />
    </div>
  );
}
