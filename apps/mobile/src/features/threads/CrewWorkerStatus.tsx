import { View } from "react-native";
import type { EnvironmentId, TeamworkTask } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { crewExecutionLabels, crewTaskExecution } from "@t3tools/shared/crewExecution";
import { AppText } from "../../components/ui/AppText";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentShellReadiness } from "../../state/shell";

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
