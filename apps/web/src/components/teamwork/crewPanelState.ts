import { Atom } from "effect/reactivity";
import { parseScopedProjectKey } from "@t3tools/client-runtime/environment";
import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { threadFamilies } from "../../state/threads";
import type { crewSupervisionFacts } from "./crewPanel.logic";

type Shell = Parameters<typeof crewSupervisionFacts>[1][number] &
  Pick<OrchestrationV2ThreadShell, "title">;

export const crewSupervisionShells = Atom.family((projectKey: string) => {
  const project = parseScopedProjectKey(projectKey);
  let previous: readonly Shell[] = [];
  return Atom.make((get) => {
    if (!project) return previous;
    const shells = get(threadFamilies.snapshotAtom(project.environmentId))?.threads ?? [];
    const byId = new Map(previous.map((shell) => [shell.id, shell]));
    const next = shells
      .filter((shell) => shell.projectId === project.projectId)
      .map((shell) => {
        const old = byId.get(shell.id);
        // Streaming text and timestamps do not change Crew execution or question ownership.
        return old &&
          old.status === shell.status &&
          old.title === shell.title &&
          old.deletedAt === shell.deletedAt &&
          old.lastError === shell.lastError &&
          old.pendingRuntimeRequest?.id === shell.pendingRuntimeRequest?.id &&
          old.pendingRuntimeRequest?.kind === shell.pendingRuntimeRequest?.kind &&
          old.pendingRuntimeRequest?.userOnly === shell.pendingRuntimeRequest?.userOnly &&
          (old.pendingBackgroundTasks?.length ?? 0) === (shell.pendingBackgroundTasks?.length ?? 0)
          ? old
          : shell;
      });
    if (previous.length === next.length && previous.every((shell, index) => shell === next[index]))
      return previous;
    previous = next;
    return previous;
  });
});
