import type {
  OrchestrationV2ThreadShell,
  ScopedProjectRef,
  TeamworkSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { crewTaskExecution } from "@t3tools/shared/crewExecution";
import type { CrewPrerequisite } from "@t3tools/shared/crewSupervision";

export function crewMessageRecipients(input: {
  snapshot: TeamworkSnapshot;
  initiativeId: string | null;
  project: ScopedProjectRef;
  threads: readonly Pick<
    EnvironmentThreadShell,
    "id" | "environmentId" | "projectId" | "deletedAt"
  >[];
  selected: readonly ThreadId[];
}) {
  const { snapshot, initiativeId, selected } = input;
  const available = new Set(
    input.threads
      .filter(
        (thread) =>
          thread.environmentId === input.project.environmentId &&
          thread.projectId === input.project.projectId &&
          thread.deletedAt === null,
      )
      .map((thread) => thread.id),
  );
  const members = [
    ...new Map(
      [
        ...(snapshot.coordinatorThreadId
          ? [{ id: snapshot.coordinatorThreadId, label: "Project coordinator" }]
          : []),
        ...snapshot.tasks
          .filter((task) => task.initiativeId === initiativeId && task.ownerThreadId !== null)
          .map((task) => ({ id: task.ownerThreadId!, label: task.title })),
      ]
        .filter((member) => available.has(member.id))
        .map((member) => [member.id, member]),
    ).values(),
  ];
  const recipients = selected.filter((id) => members.some((member) => member.id === id));
  const invalidRecipients = selected.filter((id) => !members.some((member) => member.id === id));
  return {
    members,
    recipients,
    invalidRecipients,
    canAsk: recipients.length > 0 && invalidRecipients.length === 0,
  };
}

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
    threadExecution: shells.map((shell) =>
      crewTaskExecution(
        { id: shell.id, ownerThreadId: shell.id, status: "done" },
        worker(shell.id),
      ),
    ),
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
