import { View } from "react-native";
import { useEffect } from "react";
import type { EnvironmentId, TeamworkTask } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { crewExecutionLabels, crewTaskExecution } from "@t3tools/shared/crewExecution";
import { AppText } from "../../components/ui/AppText";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentShellReadiness } from "../../state/shell";
import { threadFamilies } from "../../state/threads";
import { appAtomRegistry } from "../../state/atom-registry";

export function CrewWorkerStatus({
  environmentId,
  task,
}: {
  environmentId: EnvironmentId;
  task: TeamworkTask;
}) {
  const worker = useQuietThreadShell(
    task.ownerThreadId === null ? null : scopeThreadRef(environmentId, task.ownerThreadId),
  );
  const connected = useEnvironmentShellReadiness(environmentId).status === "live";
  const familyThreadId = worker?.lineage.rootThreadId ?? task.ownerThreadId;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Retain the assigned worker's original family after coordinator handover.
  useEffect(() => {
    if (familyThreadId === null) return;
    return threadFamilies.mount(appAtomRegistry, environmentId, familyThreadId);
  }, [environmentId, familyThreadId]);
  const execution = crewTaskExecution(
    task,
    worker
      ? {
          status: worker.runtime?.status ?? null,
          hasPendingApprovals: worker.hasPendingApprovals,
          hasPendingUserInput: worker.hasPendingUserInput,
          hasPendingBackgroundTasks: worker.pendingBackgroundTasks.length > 0,
          lastError: worker.runtime?.lastError,
        }
      : null,
    connected,
  );
  return (
    <View className="gap-1" accessibilityLabel="Worker execution">
      <AppText>
        {execution.needsAttention ? "Needs attention · " : ""}
        {crewExecutionLabels[execution.state]}
      </AppText>
      {execution.detail && (
        <AppText className="text-sm text-foreground-muted">{execution.detail}</AppText>
      )}
    </View>
  );
}
