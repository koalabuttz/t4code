import type {
  TeamworkExecutionState,
  TeamworkReadResult,
  TeamworkSnapshot,
  TeamworkTaskExecution,
  ThreadId,
} from "@t3tools/contracts";

import { crewTaskExecution } from "./crewExecution.ts";

type Execution = Pick<TeamworkTaskExecution, "threadId" | "state" | "detail">;
type Freshness = "current" | "stale" | "disconnected" | "unknown";
type Actor =
  | { readonly kind: "human" | "unknown" }
  | { readonly kind: "agent"; readonly threadId: ThreadId };
type Action =
  | {
      readonly kind: "open-thread";
      readonly threadId: ThreadId;
      readonly focus?: "approval" | "input";
    }
  | { readonly kind: "open-task"; readonly taskId: string }
  | { readonly kind: "retry-delivery"; readonly deliveryId: string }
  | { readonly kind: "refresh-connection" | "select-coordinator" }
  | { readonly kind: "approve-plan" | "resume"; readonly initiativeId: string };

export interface CrewSupervisionInput {
  readonly snapshot: TeamworkSnapshot;
  readonly execution: ReadonlyArray<TeamworkTaskExecution>;
  readonly coordinatorExecution: Execution | null;
  readonly deliveries: TeamworkReadResult["deliveries"];
  readonly freshness: Freshness;
  // Only explicit review assignments for this exact submission belong here.
  readonly reviewAssignments?: ReadonlyArray<{
    readonly taskId: string;
    readonly submissionRevision: number;
    readonly threadId: ThreadId;
    readonly execution?: Execution | undefined;
  }>;
}

export interface CrewSupervisionItem {
  readonly id: string;
  readonly initiativeId: string | null;
  readonly initiativeTitle: string | null;
  readonly taskId: string | null;
  readonly threadId: ThreadId | null;
  readonly kind:
    | "approval"
    | "input"
    | "review"
    | "dependencies"
    | "worker-active"
    | "worker-waiting"
    | "worker-finished"
    | "worker-stopped"
    | "worker-failed"
    | "worker-unavailable"
    | "execution-unknown"
    | "assignment-needed"
    | "coordinator-failed"
    | "coordinator-unavailable"
    | "coordinator-active"
    | "coordinator-stopped"
    | "stop-failed"
    | "stop-pending"
    | "message-failed"
    | "message-pending"
    | "stopping"
    | "plan-approval"
    | "resume";
  readonly label: string;
  readonly detail: string | null;
  readonly responsibility: "human" | "crew" | "waiting" | "unknown";
  readonly actor: Actor;
  readonly underway: boolean;
  readonly attention: boolean;
  readonly freshness: "current" | "last-known" | "unavailable";
  readonly lastKnownState: TeamworkExecutionState | null;
  readonly action: Action | null;
  readonly submissionRevision?: number;
  readonly dependencyIds?: ReadonlyArray<string>;
  readonly deliveryId?: string;
}

export type CrewPrerequisite =
  | { readonly kind: "refresh-connection" | "select-coordinator" }
  | { readonly kind: "verify-assignment"; readonly taskId: string }
  | { readonly kind: "approve-plan" | "pause-initiative"; readonly initiativeId: string }
  | {
      readonly kind: "wait-worker" | "verify-execution" | "stop-coordinator";
      readonly threadId: ThreadId;
    }
  | {
      readonly kind: "retry-stop" | "wait-stop";
      readonly threadId: ThreadId;
      readonly deliveryId: string;
    };

const active = (state: TeamworkExecutionState) =>
  ["starting", "working", "approval", "input", "waiting"].includes(state);
const uncertain = (state: TeamworkExecutionState) =>
  ["unknown", "unavailable", "disconnected", "unassigned"].includes(state);
const human: Actor = { kind: "human" };
const unknown: Actor = { kind: "unknown" };
const agent = (threadId: ThreadId | null): Actor =>
  threadId === null ? unknown : { kind: "agent", threadId };

export function classifyCrewSupervision(input: CrewSupervisionInput) {
  const { snapshot, freshness } = input;
  const current = freshness === "current";
  const tasks = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const initiatives = new Map(
    snapshot.initiatives.map((initiative) => [initiative.id, initiative]),
  );
  const executions = new Map(input.execution.map((execution) => [execution.taskId, execution]));
  const deliveries = [
    ...new Map(input.deliveries.map((delivery) => [delivery.id, delivery])).values(),
  ];
  const items = new Map<string, CrewSupervisionItem>();
  const add = (
    item: Omit<
      CrewSupervisionItem,
      "initiativeTitle" | "freshness" | "lastKnownState" | "detail" | "underway" | "threadId"
    > &
      Partial<
        Pick<
          CrewSupervisionItem,
          "freshness" | "lastKnownState" | "detail" | "underway" | "threadId"
        >
      >,
  ) => {
    const value: CrewSupervisionItem = {
      detail: null,
      underway: false,
      lastKnownState: null,
      threadId: null,
      freshness: current ? "current" : "last-known",
      ...item,
      initiativeTitle:
        item.initiativeId === null ? null : (initiatives.get(item.initiativeId)?.title ?? null),
    };
    items.set(value.id, value);
    return value;
  };
  const observed = new Map<string, Execution>();
  const threadExecution = new Map<ThreadId, Execution>();
  for (const task of snapshot.tasks) {
    const fact = executions.get(task.id);
    const execution = fact?.threadId === task.ownerThreadId ? fact : crewTaskExecution(task, null);
    observed.set(task.id, execution);
    if (execution.threadId !== null) threadExecution.set(execution.threadId, execution);
  }
  const coordinator =
    input.coordinatorExecution?.threadId === snapshot.coordinatorThreadId
      ? input.coordinatorExecution
      : null;
  if (coordinator?.threadId) threadExecution.set(coordinator.threadId, coordinator);

  const executionItem = (
    execution: Execution,
    taskId: string | null,
    initiativeId: string | null,
    paused: boolean,
  ) => {
    const isCoordinator = taskId === null;
    const base = {
      id: isCoordinator ? "coordinator:execution" : `task:${taskId}:execution`,
      taskId,
      threadId: execution.threadId,
      initiativeId,
      lastKnownState: execution.state,
      action:
        execution.threadId === null
          ? null
          : { kind: "open-thread" as const, threadId: execution.threadId },
      detail: execution.detail,
    };
    if (!current || uncertain(execution.state)) {
      return add({
        ...base,
        kind:
          execution.state === "unavailable" && current
            ? isCoordinator
              ? "coordinator-unavailable"
              : "worker-unavailable"
            : "execution-unknown",
        label: current
          ? "Execution unavailable"
          : "Execution is last known; refresh the connection",
        responsibility: "unknown",
        actor: unknown,
        attention: true,
        freshness:
          execution.state === "unknown" || execution.state === "unavailable"
            ? "unavailable"
            : "last-known",
      });
    }
    if (execution.state === "approval" || execution.state === "input") {
      return add({
        ...base,
        kind: execution.state,
        label: execution.state === "approval" ? "Approval needed" : "Question needs a response",
        actor: human,
        responsibility: "human",
        attention: true,
        action:
          execution.threadId === null
            ? null
            : { kind: "open-thread", threadId: execution.threadId, focus: execution.state },
      });
    }
    if (execution.state === "failed")
      return add({
        ...base,
        kind: isCoordinator ? "coordinator-failed" : "worker-failed",
        label: isCoordinator ? "Coordinator failed" : "Worker failed",
        actor: unknown,
        responsibility: "unknown",
        attention: true,
      });
    if (active(execution.state))
      return add({
        ...base,
        kind:
          paused && !isCoordinator
            ? "stopping"
            : isCoordinator
              ? "coordinator-active"
              : execution.state === "waiting"
                ? "worker-waiting"
                : "worker-active",
        label:
          paused && !isCoordinator
            ? "Stopping workers…"
            : execution.state === "waiting"
              ? "Waiting for ongoing work"
              : isCoordinator
                ? "Coordinator running"
                : "Worker running",
        responsibility: execution.state === "waiting" && !paused ? "waiting" : "crew",
        actor: agent(execution.threadId),
        underway: true,
        attention: paused && !isCoordinator,
      });
    if (execution.state === "stopped" && !paused)
      return add({
        ...base,
        kind: isCoordinator ? "coordinator-stopped" : "worker-stopped",
        label: isCoordinator
          ? "Coordinator stopped"
          : "Worker stopped before completing the assignment",
        responsibility: "unknown",
        actor: unknown,
        attention: true,
      });
    return null;
  };

  if (snapshot.coordinatorThreadId === null) {
    if (
      snapshot.initiatives.some((initiative) =>
        ["active", "paused", "draft"].includes(initiative.status),
      )
    )
      add({
        id: "coordinator:missing",
        initiativeId: null,
        taskId: null,
        kind: "assignment-needed",
        label: "Choose a project coordinator",
        responsibility: "human",
        actor: human,
        attention: true,
        action: { kind: "select-coordinator" },
      });
  } else {
    const coordinatorPaused = !snapshot.initiatives.some(
      (initiative) => initiative.status === "active",
    );
    executionItem(
      coordinator ?? { threadId: snapshot.coordinatorThreadId, state: "unknown", detail: null },
      null,
      null,
      coordinatorPaused,
    );
  }

  for (const task of snapshot.tasks) {
    const initiative = initiatives.get(task.initiativeId);
    const paused = initiative?.status === "paused" || initiative?.status === "cancelled";
    const execution = observed.get(task.id)!;
    const unfinished = task.status !== "done" && task.status !== "cancelled";
    const base = {
      taskId: task.id,
      initiativeId: task.initiativeId,
      action: { kind: "open-task" as const, taskId: task.id },
    };
    if (
      task.ownerThreadId !== null &&
      (unfinished || active(execution.state) || uncertain(execution.state))
    )
      executionItem(execution, task.id, task.initiativeId, paused);
    if (!unfinished) continue;
    if (task.ownerThreadId === null && ["running", "blocked", "delegating"].includes(task.status))
      add({
        ...base,
        id: `task:${task.id}:assignment`,
        kind: "assignment-needed",
        label:
          task.status === "delegating"
            ? "Worker assignment pending"
            : "No worker assigned to unfinished work",
        responsibility: "unknown",
        actor: unknown,
        attention: task.status !== "delegating",
      });
    if (task.status === "review") {
      const assignments =
        input.reviewAssignments?.filter(
          (assignment) =>
            assignment.taskId === task.id &&
            assignment.submissionRevision === task.submission?.revision,
        ) ?? [];
      const assignment = assignments.length === 1 ? assignments[0] : undefined;
      const reviewing =
        current &&
        assignment?.execution?.threadId === assignment?.threadId &&
        assignment?.execution !== undefined &&
        ["starting", "working"].includes(assignment.execution.state);
      add({
        ...base,
        id: `task:${task.id}:review`,
        kind: "review",
        label: "Submitted result needs review",
        responsibility: assignment ? "crew" : "unknown",
        actor: assignment ? agent(assignment.threadId) : unknown,
        underway: reviewing,
        attention: true,
        ...(task.submission ? { submissionRevision: task.submission.revision } : {}),
      });
    }
    const dependencyIds = task.dependencies.filter((id) => tasks.get(id)?.status !== "done");
    if (dependencyIds.length)
      add({
        ...base,
        id: `task:${task.id}:dependencies`,
        kind: "dependencies",
        label: "Waiting for accepted dependencies",
        responsibility: "waiting",
        actor: unknown,
        dependencyIds,
        attention: false,
      });
    if (current && execution.state === "finished" && ["running", "blocked"].includes(task.status))
      add({
        ...base,
        id: `task:${task.id}:result`,
        kind: "worker-finished",
        label: "Worker finished without submitting a result",
        responsibility: "crew",
        actor: agent(task.ownerThreadId),
        attention: true,
      });
    if (!paused && task.status === "ready" && !dependencyIds.length)
      add({
        ...base,
        id: `task:${task.id}:assignment`,
        kind: "assignment-needed",
        label: "Ready for assignment",
        responsibility: snapshot.coordinatorThreadId ? "crew" : "unknown",
        actor: agent(snapshot.coordinatorThreadId),
        attention: false,
      });
    if (
      task.status === "blocked" &&
      !dependencyIds.length &&
      !["finished", "failed", "stopped"].includes(execution.state)
    )
      add({
        ...base,
        id: `task:${task.id}:blocked`,
        kind: "assignment-needed",
        label: "Blocked; next step needs clarification",
        responsibility: "unknown",
        actor: unknown,
        attention: true,
        detail: task.evidence || null,
      });
  }

  const deliveryInitiative = (threadId: ThreadId) => {
    if (threadId === snapshot.coordinatorThreadId) return null;
    const ids = new Set(
      snapshot.tasks
        .filter((task) => task.ownerThreadId === threadId)
        .map((task) => task.initiativeId),
    );
    return ids.size === 1 ? [...ids][0]! : null;
  };
  for (const delivery of deliveries) {
    if (delivery.status !== "failed" && delivery.status !== "pending") continue;
    const failed = delivery.status === "failed";
    const stop = delivery.kind === "stop";
    const initiativeId = deliveryInitiative(delivery.threadId);
    const pausedMessage =
      !stop && initiativeId !== null && initiatives.get(initiativeId)?.status === "paused";
    add({
      id: `delivery:${delivery.id}`,
      initiativeId,
      taskId: null,
      deliveryId: delivery.id,
      threadId: delivery.threadId,
      kind: stop
        ? failed
          ? "stop-failed"
          : "stop-pending"
        : failed
          ? "message-failed"
          : "message-pending",
      label: stop
        ? failed
          ? "Worker stop failed"
          : "Worker stop pending"
        : failed
          ? "Message delivery failed"
          : "Message delivery pending",
      responsibility: failed ? "human" : "waiting",
      actor: failed ? human : unknown,
      attention: failed || stop,
      detail: pausedMessage
        ? "Resume the initiative explicitly before notifying its worker."
        : null,
      action: pausedMessage
        ? { kind: "resume", initiativeId }
        : failed
          ? { kind: "retry-delivery", deliveryId: delivery.id }
          : { kind: "open-thread", threadId: delivery.threadId },
    });
  }

  const stopPrerequisites = (threadIds: ReadonlySet<ThreadId>): CrewPrerequisite[] => {
    const result: CrewPrerequisite[] = current ? [] : [{ kind: "refresh-connection" }];
    for (const delivery of deliveries)
      if (
        threadIds.has(delivery.threadId) &&
        delivery.kind === "stop" &&
        ["failed", "pending"].includes(delivery.status)
      )
        result.push({
          kind: delivery.status === "failed" ? "retry-stop" : "wait-stop",
          threadId: delivery.threadId,
          deliveryId: delivery.id,
        });
    for (const threadId of threadIds) {
      const execution = threadExecution.get(threadId);
      if (!current || !execution || uncertain(execution.state))
        result.push({ kind: "verify-execution", threadId });
      else if (active(execution.state))
        result.push({
          kind: threadId === snapshot.coordinatorThreadId ? "stop-coordinator" : "wait-worker",
          threadId,
        });
    }
    return result;
  };
  const summaries = snapshot.initiatives.map((initiative) => {
    const owned = snapshot.tasks.filter((task) => task.initiativeId === initiative.id);
    const threadIds = new Set(
      owned.flatMap((task) => (task.ownerThreadId === null ? [] : [task.ownerThreadId])),
    );
    const stops = stopPrerequisites(threadIds);
    for (const task of owned)
      if (task.ownerThreadId === null && ["delegating", "running", "blocked"].includes(task.status))
        stops.push({ kind: "verify-assignment", taskId: task.id });
    const pauseState =
      initiative.status !== "paused" && initiative.status !== "cancelled"
        ? ("not-requested" as const)
        : stops.some((prerequisite) => prerequisite.kind === "retry-stop")
          ? ("failed" as const)
          : !current ||
              stops.some(
                (prerequisite) =>
                  prerequisite.kind === "verify-execution" ||
                  prerequisite.kind === "verify-assignment",
              )
            ? ("unknown" as const)
            : stops.length
              ? ("stopping" as const)
              : ("stopped" as const);
    const prerequisites: CrewPrerequisite[] = [...stops];
    if (!snapshot.coordinatorThreadId) prerequisites.push({ kind: "select-coordinator" });
    else if (!current || !coordinator || uncertain(coordinator.state))
      prerequisites.push({ kind: "verify-execution", threadId: snapshot.coordinatorThreadId });
    if (!initiative.approved)
      prerequisites.push({ kind: "approve-plan", initiativeId: initiative.id });
    if (initiative.status === "draft" && !initiative.approved)
      add({
        id: `initiative:${initiative.id}:approval`,
        initiativeId: initiative.id,
        taskId: null,
        kind: "plan-approval",
        label: "Plan needs your approval",
        responsibility: "human",
        actor: human,
        attention: true,
        action: { kind: "approve-plan", initiativeId: initiative.id },
      });
    if (initiative.status === "paused")
      add({
        id: `initiative:${initiative.id}:resume`,
        initiativeId: initiative.id,
        taskId: null,
        kind: "resume",
        label: "Paused; resume explicitly to continue",
        responsibility: "human",
        actor: human,
        attention: false,
        action: { kind: "resume", initiativeId: initiative.id },
      });
    return {
      initiativeId: initiative.id,
      title: initiative.title,
      goal: initiative.brief,
      status: initiative.status,
      progress: {
        total: owned.length,
        accepted: owned.filter((task) => task.status === "done").length,
        cancelled: owned.filter((task) => task.status === "cancelled").length,
        submitted: owned.filter((task) => task.submission != null).length,
        needingReview: owned.filter((task) => task.status === "review").length,
        running: current
          ? owned.filter(
              (task) => task.ownerThreadId !== null && active(observed.get(task.id)!.state),
            ).length
          : null,
        finished: current
          ? owned.filter((task) => observed.get(task.id)!.state === "finished").length
          : null,
        executionUnknown: owned.filter(
          (task) =>
            task.ownerThreadId !== null && (!current || uncertain(observed.get(task.id)!.state)),
        ).length,
        milestonesAccepted: initiative.milestones.filter((milestone) => milestone.accepted).length,
        milestonesTotal: initiative.milestones.length,
      },
      pause: { state: pauseState },
      resume: { requiresExplicitAction: initiative.status === "paused", prerequisites },
    };
  });
  const allItems = [...items.values()].sort(
    (left, right) =>
      Number(right.attention) - Number(left.attention) ||
      Number(right.responsibility === "human") - Number(left.responsibility === "human") ||
      left.id.localeCompare(right.id),
  );
  const attention = allItems.filter((item) => item.attention);
  const allThreads = new Set(
    snapshot.tasks.flatMap((task) => (task.ownerThreadId === null ? [] : [task.ownerThreadId])),
  );
  for (const delivery of deliveries)
    if (delivery.kind === "stop") allThreads.add(delivery.threadId);
  if (snapshot.coordinatorThreadId) allThreads.add(snapshot.coordinatorThreadId);
  return {
    freshness,
    items: allItems,
    attention,
    clear:
      current &&
      attention.length === 0 &&
      !allItems.some((item) => item.responsibility === "unknown"),
    initiatives: summaries.map((summary) => {
      const ownItems = allItems.filter((item) => item.initiativeId === summary.initiativeId);
      return {
        ...summary,
        items: ownItems,
        attention: ownItems.filter((item) => item.attention),
        next: ownItems[0] ?? null,
      };
    }),
    handover: {
      prerequisites: [
        ...snapshot.initiatives
          .filter((initiative) => initiative.status === "active")
          .map((initiative): CrewPrerequisite => ({
            kind: "pause-initiative",
            initiativeId: initiative.id,
          })),
        ...snapshot.tasks
          .filter(
            (task) =>
              task.ownerThreadId === null &&
              ["delegating", "running", "blocked"].includes(task.status),
          )
          .map((task): CrewPrerequisite => ({ kind: "verify-assignment", taskId: task.id })),
        ...stopPrerequisites(allThreads),
      ],
    },
  };
}
