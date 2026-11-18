import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  crewOriginThread,
  isCrewCoordinatorCandidate,
  resolveCrewCoordinator,
} from "@t3tools/client-runtime/state/crew";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { CommandId, DEFAULT_PROVIDER_INTERACTION_MODE, ThreadId } from "@t3tools/contracts";
import type { CrewProjectScope } from "@t3tools/contracts/crewConversation";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AtomRegistry } from "effect/reactivity";
import { useRef, useState } from "react";
import { ScrollView } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import {
  buildModelOptions,
  isModelSelectionUnavailable,
  resolveNewTaskModelSelection,
} from "../../lib/modelOptions";
import { appAtomRegistry } from "../../state/atom-registry";
import { orchestrationEnvironment } from "../../state/orchestration";
import { serverEnvironment } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useNewTaskProjectDefaults } from "./use-new-task-project-defaults";
import { openCrewPage } from "./crewProjectNavigation";
import { useCrewControls, useCrewProject } from "./use-crew-project";

export function CrewCoordinatorSetup({
  scope,
  project,
  originThreadId,
}: {
  scope: CrewProjectScope;
  project: EnvironmentProject;
  originThreadId: ThreadId | null;
}) {
  const { environmentId, projectId } = scope;
  const navigation = useNavigation();
  const { query, snapshot, freshness, threads } = useCrewProject(scope);
  const controls = useCrewControls(scope, snapshot?.revision, freshness === "current");
  const { serverConfig, projectSettings, defaultWorkspaceModeSettled } =
    useNewTaskProjectDefaults(project);
  const origin = useAtomValue(crewOriginThread(scopedProjectKey(scope)));
  const candidate = resolveCrewCoordinator({
    project: scope,
    threads,
    coordinatorThreadId: null,
    originThreadId: originThreadId ?? origin,
  }).threadId;
  const existing = threads.find(
    (thread) =>
      thread.id === candidate &&
      !thread.archivedAt &&
      !snapshot?.tasks.some((task) => task.ownerThreadId === thread.id),
  );
  const { defaultModelSelection, defaultRuntimeMode } = projectSettings.settings;
  const modelSelection = resolveNewTaskModelSelection({
    draftSelection: null,
    projectDefaultSelection: defaultModelSelection,
    stickySelection: null,
    modelOptions: buildModelOptions(serverConfig, defaultModelSelection, undefined, projectId),
  });
  const usableModel =
    modelSelection && !isModelSelectionUnavailable(serverConfig, modelSelection, projectId);
  const dispatch = useAtomCommand(orchestrationEnvironment.v2.dispatchCommand, {
    reportFailure: false,
  });
  const canCreate = useAtomValue(
    orchestrationEnvironment.v2.dispatchCommand.permissionAtom(environmentId),
  );
  const stableThreadId = ThreadId.make(`crew-coordinator:${projectId}`);
  const stableShell = useAtomValue(
    environmentThreadShells.threadShellAtom({ environmentId, threadId: stableThreadId }),
  );
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const inFlight = useRef(false);
  const establish = async (useExisting: boolean) => {
    const revision = snapshot?.revision;
    if (
      inFlight.current ||
      revision === undefined ||
      snapshot?.coordinatorThreadId ||
      !controls.canEdit
    )
      return;
    const threadId = useExisting ? existing?.id : stableThreadId;
    if (!threadId) return;
    inFlight.current = true;
    setCreating(true);
    setError(null);
    await (async () => {
      const shellAtom = environmentThreadShells.threadShellAtom({ environmentId, threadId });
      if (!useExisting && appAtomRegistry.get(shellAtom) === null) {
        if (!canCreate || !usableModel || !modelSelection) return;
        const result = await dispatch({
          environmentId,
          input: {
            type: "thread.create",
            commandId: CommandId.make(`create:${threadId}`),
            threadId,
            projectId,
            title: "Project coordinator",
            modelSelection,
            runtimeMode: defaultRuntimeMode,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "mobile",
          },
        });
        const shell = await Effect.runPromise(
          AtomRegistry.toStream(appAtomRegistry, shellAtom).pipe(
            Stream.filter((entry) => entry !== null),
            Stream.runHead,
            Effect.timeoutOption("3 seconds"),
          ),
        );
        const created = Option.flatMap(shell, (value) => value);
        if (
          Option.isNone(created) ||
          !isCrewCoordinatorCandidate(scope, created.value) ||
          created.value.archivedAt
        ) {
          query.refresh();
          if (result._tag !== "Failure") {
            setError(
              "The coordinator conversation could not be confirmed. Refresh the connection and retry.",
            );
            return;
          }
          const failure = squashAtomCommandFailure(result);
          setError(
            failure instanceof Error
              ? failure.message
              : "Could not create the coordinator conversation.",
          );
          return;
        }
      }
      const liveAtom = serverEnvironment.teamworkLive({ environmentId, input: { projectId } });
      const previous = appAtomRegistry.get(liveAtom);
      query.refresh();
      const latest = await Effect.runPromise(
        AtomRegistry.toStream(appAtomRegistry, liveAtom).pipe(
          Stream.filter(
            (value) =>
              value._tag === "Success" &&
              (previous._tag !== "Success" || previous.value !== value.value),
          ),
          Stream.runHead,
          Effect.timeoutOption("3 seconds"),
        ),
      );
      const value = Option.getOrNull(Option.flatMap(latest, (entry) => entry));
      if (!value || value._tag !== "Success" || !value.value) {
        setError("Crew state could not be refreshed. Confirm again when connected.");
        return;
      }
      const current = value.value.snapshot;
      if (current.coordinatorThreadId) return;
      const shell = appAtomRegistry.get(shellAtom);
      if (
        !shell ||
        !isCrewCoordinatorCandidate(scope, shell) ||
        shell.archivedAt ||
        current.tasks.some((task) => task.ownerThreadId === threadId)
      ) {
        setError("This conversation is unavailable or already assigned to project work.");
        return;
      }
      if (!(await controls.act({ type: "coordinator.set", threadId }, current.revision)))
        query.refresh();
    })().catch((failure: unknown) => {
      setError(
        failure instanceof Error ? failure.message : "Could not establish the project coordinator.",
      );
      query.refresh();
    });
    setCreating(false);
    inFlight.current = false;
  };
  return (
    <ScrollView contentContainerClassName="gap-4 p-5" contentInsetAdjustmentBehavior="never">
      <AppText className="text-lg font-t3-semibold" accessibilityRole="header">
        Set up project chat
      </AppText>
      <AppText>
        The coordinator plans, consults work threads and delegates changes. Confirming creates a
        conversation you can message.
      </AppText>
      {freshness !== "current" && (
        <AppText accessibilityRole="alert">Reconnect to confirm the project coordinator.</AppText>
      )}
      {(error || controls.error || query.error) && (
        <AppText accessibilityRole="alert" className="text-danger">
          {error ?? controls.error ?? query.error}
        </AppText>
      )}
      <Button
        label={stableShell ? "Confirm project coordinator" : "Create project coordinator"}
        tone="primary"
        disabled={
          creating ||
          !controls.canEdit ||
          (!stableShell && (!canCreate || !usableModel || !defaultWorkspaceModeSettled))
        }
        onPress={() => void establish(false)}
      />
      {!stableShell && !usableModel && (
        <AppText>The configured model is unavailable. Check the project’s model settings.</AppText>
      )}
      {existing && (
        <Button
          label={`Use ${existing.title}`}
          disabled={creating || !controls.canEdit}
          onPress={() => void establish(true)}
        />
      )}
      <Button
        label="Choose another conversation"
        onPress={() => openCrewPage(navigation, scope, "recovery")}
      />
    </ScrollView>
  );
}
