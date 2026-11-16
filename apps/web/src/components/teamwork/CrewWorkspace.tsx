import { useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { parseScopedProjectKey } from "@t3tools/client-runtime/environment";
import type { ScopedProjectRef, ThreadId } from "@t3tools/contracts";
import { useProject, useThreadShellsForProjectRefs } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { SidebarInset, useSidebar } from "../ui/sidebar";
import { cn } from "../../lib/utils";
import { TeamworkPanel } from "./TeamworkPanel";

export function CrewWorkspace() {
  const { projectKey } = useParams({ from: "/_chat/projects/$projectKey/crew" });
  const projectRef = parseScopedProjectKey(projectKey);
  return (
    <SidebarInset className="h-dvh overflow-y-auto">
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
  const threads = useThreadShellsForProjectRefs(refs).filter(
    (thread) => thread.lineage.parentThreadId === null,
  );
  const [selected, setSelected] = useState<ThreadId | null>(null);
  const candidate = threads.find((thread) => thread.id === selected) ?? threads[0];
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
          Conversation to use when choosing a coordinator
          <select
            className="mt-1 block w-full rounded border bg-background p-2"
            value={candidate?.id ?? ""}
            onChange={(event) =>
              setSelected(threads.find((thread) => thread.id === event.target.value)?.id ?? null)
            }
          >
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
      <TeamworkPanel
        {...projectRef}
        threadId={candidate?.id ?? null}
        onOpenThread={(threadId) => {
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId: projectRef.environmentId, threadId },
          });
        }}
      />
    </div>
  );
}
