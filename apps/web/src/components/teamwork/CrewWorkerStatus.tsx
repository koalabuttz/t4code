import type { EnvironmentId, TeamworkTask } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { crewExecutionLabels, crewTaskExecution } from "@t3tools/shared/crewExecution";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentShellStatus } from "../../state/shell";

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
  const connected = useEnvironmentShellStatus(environmentId) === "live";
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
    <div className="space-y-1 text-sm" aria-label="Worker execution">
      <p>
        {execution.needsAttention ? "Needs attention · " : ""}
        {crewExecutionLabels[execution.state]}
      </p>
      {execution.detail && <p className="text-xs text-muted-foreground">{execution.detail}</p>}
    </div>
  );
}
