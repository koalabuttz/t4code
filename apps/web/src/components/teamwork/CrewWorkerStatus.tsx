import type { EnvironmentId, TeamworkTask } from "@t3tools/contracts";
import { useEffect } from "react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { crewExecutionLabels, crewTaskExecution } from "@t3tools/shared/crewExecution";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentShellStatus } from "../../state/shell";
import { threadFamilies } from "../../state/threads";
import { appAtomRegistry } from "../../rpc/atomRegistry";

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
  const familyThreadId = task.ownerThreadId;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keep the worker's family mounted; changing the key when its root arrives drops those same rows.
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
    <div className="space-y-1 text-sm" aria-label="Worker execution">
      <p>
        {execution.needsAttention ? "Needs attention · " : ""}
        {crewExecutionLabels[execution.state]}
      </p>
      {execution.detail && <p className="text-xs text-muted-foreground">{execution.detail}</p>}
    </div>
  );
}
