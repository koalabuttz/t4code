import type { OrchestrationV2ThreadShell, TeamworkSnapshot } from "@t3tools/contracts";
import { crewTaskExecution } from "@t3tools/shared/crewExecution";
import type { CrewPrerequisite } from "@t3tools/shared/crewSupervision";

export function crewSupervisionFacts(
  snapshot: TeamworkSnapshot,
  shells: readonly Pick<
    OrchestrationV2ThreadShell,
    "id" | "deletedAt" | "status" | "pendingRuntimeRequest" | "pendingBackgroundTasks" | "lastError"
  >[],
) {
  const byId = new Map(shells.map((shell) => [shell.id, shell]));
  const participantIds = new Set([
    snapshot.coordinatorThreadId,
    ...snapshot.tasks.map((task) => task.ownerThreadId),
  ]);
  const worker = (id: TeamworkSnapshot["coordinatorThreadId"]) => {
    const shell = id ? byId.get(id) : null;
    return shell && shell.deletedAt === null
      ? {
          status: shell.status,
          hasPendingApprovals:
            shell.pendingRuntimeRequest !== null &&
            !["user_input", "auth_refresh"].includes(shell.pendingRuntimeRequest.kind),
          hasPendingUserInput: shell.pendingRuntimeRequest?.kind === "user_input",
          hasPendingBackgroundTasks: !!shell.pendingBackgroundTasks?.length,
          lastError: shell.lastError,
        }
      : shell
        ? ("unavailable" as const)
        : null;
  };
  return {
    execution: snapshot.tasks.map((task) => crewTaskExecution(task, worker(task.ownerThreadId))),
    coordinatorExecution: snapshot.coordinatorThreadId
      ? crewTaskExecution(
          { id: "coordinator", ownerThreadId: snapshot.coordinatorThreadId, status: "done" },
          worker(snapshot.coordinatorThreadId),
        )
      : null,
    inputRequests: shells.flatMap((shell) =>
      participantIds.has(shell.id) &&
      shell.deletedAt === null &&
      shell.pendingRuntimeRequest?.kind === "user_input"
        ? [
            {
              threadId: shell.id,
              requestId: shell.pendingRuntimeRequest.id,
              ...(shell.pendingRuntimeRequest.userOnly === undefined
                ? {}
                : { userOnly: shell.pendingRuntimeRequest.userOnly }),
            },
          ]
        : [],
    ),
  };
}

export function crewPrerequisiteLabel(prerequisite: CrewPrerequisite): string {
  switch (prerequisite.kind) {
    case "refresh-connection":
      return "Reconnect and refresh execution facts.";
    case "select-coordinator":
      return "Choose an available project coordinator.";
    case "verify-assignment":
      return `Confirm the assignment for ${prerequisite.taskId}.`;
    case "approve-plan":
      return "Approve the revised plan before resuming.";
    case "pause-initiative":
      return "Pause active initiatives before handover.";
    case "wait-worker":
      return "Wait for the worker to stop.";
    case "verify-execution":
      return "Confirm the conversation's current execution state.";
    case "stop-coordinator":
      return "Stop the coordinator before handover.";
    case "retry-stop":
      return "Retry the failed stop and confirm it completes.";
    case "wait-stop":
      return "Wait for the pending stop delivery.";
  }
}
