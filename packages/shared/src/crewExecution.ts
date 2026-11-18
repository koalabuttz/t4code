import type {
  OrchestrationV2ShellThreadStatus,
  TeamworkExecutionState,
  TeamworkTask,
  TeamworkTaskExecution,
} from "@t3tools/contracts";

interface Worker {
  readonly status: OrchestrationV2ShellThreadStatus | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly hasPendingBackgroundTasks?: boolean;
  readonly lastError?: string | null | undefined;
}

export const crewExecutionLabels: Record<TeamworkExecutionState, string> = {
  unassigned: "No worker assigned",
  starting: "Worker starting",
  working: "Worker running",
  approval: "Approval needed",
  input: "Question pending",
  waiting: "Worker waiting",
  finished: "Worker finished",
  stopped: "Worker stopped",
  failed: "Worker failed",
  unavailable: "Worker unavailable",
  unknown: "Worker status unavailable",
  disconnected: "Connection interrupted",
};

export function crewTaskExecution(
  task: Pick<TeamworkTask, "id" | "ownerThreadId" | "status">,
  worker: Worker | "unavailable" | null,
  connected = true,
): TeamworkTaskExecution {
  const unfinished = !["done", "cancelled"].includes(task.status);
  const result = (
    state: TeamworkExecutionState,
    detail: string | null = null,
    needsAttention = false,
  ): TeamworkTaskExecution => ({
    taskId: task.id,
    threadId: task.ownerThreadId,
    state,
    detail,
    needsAttention,
  });
  if (!connected) return result("disconnected", "Reconnect to see the worker's current state.");
  if (task.ownerThreadId === null)
    return result(task.status === "delegating" ? "starting" : "unassigned");
  if (worker === null) return result("unknown", "Open the worker to load its current state.");
  if (worker === "unavailable")
    return result("unavailable", "The assigned thread is no longer available.", unfinished);
  if (worker.hasPendingApprovals) return result("approval", null, true);
  if (worker.hasPendingUserInput) return result("input", null, true);
  switch (worker.status) {
    case "preparing":
    case "queued":
    case "starting":
      return result("starting");
    case "running":
      return result("working");
    case "waiting":
      return result("waiting");
    case "failed":
      return result("failed", worker.lastError?.slice(0, 1200) ?? null, unfinished);
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      return result("stopped", null, unfinished);
    case "idle":
    case "completed":
      if (worker.hasPendingBackgroundTasks) return result("waiting");
      return result(
        "finished",
        task.status === "running" ? "No result has been submitted for review." : null,
        task.status === "running" || task.status === "blocked",
      );
    default:
      return result("unknown");
  }
}
