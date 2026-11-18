import { useNavigation } from "@react-navigation/native";
import { useRef } from "react";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";
import type { ScopedProjectRef, TeamworkReadResult } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import { openCrewPage } from "../threads/crewProjectNavigation";
import type { HomeProjectScope } from "./homeThreadList";

export interface HomeProjectItem {
  readonly group: HomeProjectScope;
  readonly project: EnvironmentProject;
}

export function useWorkspaceProjectSelection(
  groups: readonly HomeProjectScope[],
  showThreads: (key: string | null, scope?: ScopedProjectRef) => void,
) {
  const selectProject = useProjectListSelection(groups, showThreads, true);
  return ({ group, project }: HomeProjectItem) =>
    selectProject(group.key, { environmentId: project.environmentId, projectId: project.id });
}

export function useProjectListSelection(
  groups: ReadonlyArray<HomeProjectScope>,
  setFilter: (key: string | null, scope?: ScopedProjectRef) => void,
  deferFilter = false,
) {
  const navigation = useNavigation();
  const attempt = useRef(0);
  return (key: string | null, exactScope?: ScopedProjectRef) => {
    const request = ++attempt.current;
    const group = groups.find((entry) => entry.key === key);
    const scope =
      exactScope ?? (group?.projectRefs.length === 1 ? group.projectRefs[0] : undefined);
    if (
      !scope ||
      !appAtomRegistry.get(serverEnvironment.configValueAtom(scope.environmentId))?.environment
        .capabilities.projectTeamwork
    ) {
      setFilter(key, exactScope);
      return;
    }
    const top = navigation.getState()?.routes.at(-1)?.key;
    const atom = serverEnvironment.teamworkLive({
      environmentId: scope.environmentId,
      input: { projectId: scope.projectId },
    });
    const hasCrew = (read: TeamworkReadResult | null | undefined) =>
      Boolean(
        read?.snapshot.coordinatorThreadId ||
        read?.snapshot.initiatives.some(
          (initiative) =>
            initiative.status === "active" ||
            initiative.status === "paused" ||
            initiative.status === "draft",
        ),
      );
    const cached = appAtomRegistry.get(atom);
    if (cached._tag === "Success") {
      if (hasCrew(cached.value)) openCrewPage(navigation, scope);
      else setFilter(key, exactScope);
      return;
    }
    if (!deferFilter) setFilter(key, exactScope);
    void Effect.runPromise(
      AtomRegistry.getResult(appAtomRegistry, atom).pipe(
        Effect.timeoutOption("2 seconds"),
        Effect.orElseSucceed(() => null),
      ),
    ).then((result) => {
      if (request !== attempt.current || top !== navigation.getState()?.routes.at(-1)?.key) return;
      if (result?._tag === "Some" && hasCrew(result.value)) openCrewPage(navigation, scope);
      else if (deferFilter) setFilter(key, exactScope);
    });
  };
}
