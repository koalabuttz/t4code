import {
  TeamworkError,
  type TeamworkAction,
  type TeamworkSnapshot,
  type TeamworkTask,
  type ThreadId,
  type ProjectId,
} from "@t3tools/contracts";
import * as Result from "effect/Result";

export const emptyTeamwork = (projectId: ProjectId): TeamworkSnapshot => ({
  projectId,
  revision: 0,
  coordinatorThreadId: null,
  roles: [],
  initiatives: [],
  tasks: [],
  knowledge: [],
  board: [],
});

export interface TeamworkIntent {
  readonly kind: "message" | "stop";
  readonly threadId: ThreadId;
  readonly initiativeId: string | null;
  readonly text: string;
  readonly planning?: boolean;
  readonly taskId?: string;
}

export function decideTeamwork(
  state: TeamworkSnapshot,
  action: TeamworkAction,
  actor: ThreadId | null,
  now: string,
  commandId: string,
): Result.Result<
  { snapshot: TeamworkSnapshot; intents: readonly TeamworkIntent[] },
  TeamworkError
> {
  const invalid = (message: string) =>
    Result.fail(new TeamworkError({ reason: "invalid-state", message }));
  const forbidden = () =>
    Result.fail(
      new TeamworkError({
        reason: "forbidden",
        message: "This action requires the project coordinator or the user.",
      }),
    );
  const operator = actor === null || actor === state.coordinatorThreadId;
  const participant =
    actor === null ||
    actor === state.coordinatorThreadId ||
    state.tasks.some((t) => t.ownerThreadId === actor);
  if (!participant) return forbidden();
  if (
    !operator &&
    !["task.report", "task.review", "board.post", "knowledge.save"].includes(action.type)
  )
    return forbidden();
  let next = state;
  const intents: TeamworkIntent[] = [];
  const tasks = (task: TeamworkTask) => {
    next = {
      ...next,
      tasks: next.tasks.map((t) => (t.id === task.id ? { ...task, updatedAt: now } : t)),
    };
  };
  const wake = (text: string, initiativeId: string | null, planning = false) => {
    if (state.coordinatorThreadId !== null && actor !== state.coordinatorThreadId)
      intents.push({
        kind: "message",
        threadId: state.coordinatorThreadId,
        initiativeId,
        text,
        planning,
      });
  };
  const stop = (task: TeamworkTask) => {
    if (task.ownerThreadId !== null)
      intents.push({
        kind: "stop",
        threadId: task.ownerThreadId,
        initiativeId: task.initiativeId,
        taskId: task.id,
        text: "Crew paused or cancelled this assignment.",
      });
  };
  switch (action.type) {
    case "coordinator.set":
      if (actor !== null) return forbidden();
      if (
        state.tasks.some((t) => ["delegating", "running", "blocked", "review"].includes(t.status))
      )
        return invalid(
          "Finish or cancel outstanding assignments before replacing the coordinator.",
        );
      if (state.tasks.some((t) => t.ownerThreadId === action.threadId))
        return invalid("A worker thread cannot also be the project coordinator.");
      next = { ...next, coordinatorThreadId: action.threadId };
      break;
    case "role.save":
      if (state.tasks.some((t) => t.roleId === action.role.id && t.status === "delegating"))
        return invalid("Wait for the reserved delegation to attach before editing its role.");
      next = {
        ...next,
        roles: [...next.roles.filter((r) => r.id !== action.role.id), action.role],
      };
      break;
    case "role.remove":
      if (
        state.tasks.some((t) => t.roleId === action.id && !["done", "cancelled"].includes(t.status))
      )
        return invalid("This role still has unfinished tasks.");
      next = { ...next, roles: next.roles.filter((r) => r.id !== action.id) };
      break;
    case "initiative.create": {
      if (state.coordinatorThreadId === null) return invalid("Choose a project coordinator first.");
      if (state.initiatives.some((i) => i.id === action.id))
        return invalid("This initiative already exists.");
      const status = action.mode === "swarm" ? "active" : "draft";
      next = {
        ...next,
        initiatives: [
          ...next.initiatives,
          {
            id: action.id,
            title: action.title,
            brief: action.brief,
            mode: action.mode,
            status,
            approved: action.mode === "swarm",
            milestones: [],
            createdAt: now,
            updatedAt: now,
          },
        ],
      };
      wake(
        `Initiative ${action.id}: ${action.title}\n${action.brief}\nMode: ${action.mode}. Read t3_team_read. ${status === "draft" ? "Scope the work and record milestones; wait for the user to approve the brief before delegation." : "Create owned tasks with acceptance criteria, delegate through t3_team_delegate, and require independent review before completion."}`,
        action.id,
        status === "draft",
      );
      break;
    }
    case "initiative.edit":
    case "initiative.approve":
    case "initiative.status":
    case "milestone.save":
    case "milestone.accept": {
      const id = "initiativeId" in action ? action.initiativeId : action.id;
      const initiative = state.initiatives.find((i) => i.id === id);
      if (!initiative) return invalid("Initiative not found.");
      const owned = state.tasks.filter((t) => t.initiativeId === id);
      let updated = initiative;
      if (action.type === "initiative.edit") {
        const changesBrief = action.brief !== initiative.brief || action.mode !== initiative.mode;
        updated = {
          ...initiative,
          title: action.title,
          brief: action.brief,
          mode: action.mode,
          ...(changesBrief
            ? {
                approved: action.mode === "swarm",
                status: action.mode === "teamwork" ? ("draft" as const) : ("paused" as const),
              }
            : {}),
        };
        if (changesBrief) owned.forEach(stop);
      } else if (action.type === "initiative.approve") {
        if (actor !== null) return forbidden();
        if (initiative.status !== "draft") return invalid("Only a draft brief can be approved.");
        updated = { ...initiative, approved: true, status: "active" };
        wake(
          `The user approved initiative ${id}. Read the current brief and task board, then proceed.`,
          id,
        );
      } else if (action.type === "initiative.status") {
        if (action.status === "active" && !initiative.approved)
          return invalid("The user must approve the brief before workers can start.");
        if (
          action.status === "completed" &&
          (initiative.status !== "active" ||
            owned.some((t) => !["done", "cancelled"].includes(t.status)) ||
            initiative.milestones.some((m) => !m.accepted))
        )
          return invalid(
            "Complete and independently review all tasks and accept all milestones first.",
          );
        if (action.status === "draft") return invalid("Edit the brief to return to planning.");
        updated = { ...initiative, status: action.status };
        if (action.status === "paused" || action.status === "cancelled") owned.forEach(stop);
        if (action.status === "active")
          wake(
            `Initiative ${id} is active again. Reconcile interrupted assignments and continue from the persisted board.`,
            id,
          );
      } else if (action.type === "milestone.save") {
        if (["completed", "cancelled"].includes(initiative.status))
          return invalid("Reopen the initiative before changing milestones.");
        updated = {
          ...initiative,
          milestones: [
            ...initiative.milestones.filter((m) => m.id !== action.milestone.id),
            { ...action.milestone, accepted: false },
          ],
        };
      } else {
        if (!initiative.milestones.some((m) => m.id === action.id))
          return invalid("Milestone not found.");
        if (
          action.accepted &&
          owned.some(
            (t) => t.milestoneId === action.id && !["done", "cancelled"].includes(t.status),
          )
        )
          return invalid("This milestone still has unreviewed work.");
        updated = {
          ...initiative,
          ...(initiative.status === "completed" && !action.accepted
            ? { status: "paused" as const }
            : {}),
          milestones: initiative.milestones.map((m) =>
            m.id === action.id ? { ...m, accepted: action.accepted } : m,
          ),
        };
      }
      next = {
        ...next,
        initiatives: next.initiatives.map((i) =>
          i.id === id ? { ...updated, updatedAt: now } : i,
        ),
      };
      break;
    }
    case "task.create":
    case "task.edit": {
      const existing = state.tasks.find((t) => t.id === action.id);
      if (action.type === "task.create" ? existing !== undefined : existing === undefined)
        return invalid("Task already exists or could not be found.");
      const initiativeId =
        action.type === "task.create" ? action.initiativeId : existing!.initiativeId;
      const initiative = state.initiatives.find((i) => i.id === initiativeId);
      if (!initiative || ["completed", "cancelled"].includes(initiative.status))
        return invalid("Reopen the initiative before changing tasks.");
      if (existing && ["delegating", "running"].includes(existing.status))
        return invalid("Stop and reset the assignment before editing it.");
      if (
        existing &&
        state.tasks.some(
          (t) => t.dependencies.includes(existing.id) && !["ready", "cancelled"].includes(t.status),
        )
      )
        return invalid("Reset dependent assignments before changing their prerequisite.");
      if (action.roleId !== null && !state.roles.some((r) => r.id === action.roleId))
        return invalid("Role not found.");
      if (
        action.milestoneId !== null &&
        !initiative.milestones.some((m) => m.id === action.milestoneId)
      )
        return invalid("Milestone not found.");
      if (action.knowledgeIds.some((id) => !state.knowledge.some((k) => k.id === id)))
        return invalid("Knowledge entry not found.");
      if (
        action.dependencies.some(
          (id) =>
            id === action.id ||
            !state.tasks.some((t) => t.id === id && t.initiativeId === initiativeId),
        )
      )
        return invalid("Dependencies must be other tasks in this initiative.");
      const visits = (id: string, seen: Set<string>): boolean =>
        id === action.id ||
        (!seen.has(id) &&
          (seen.add(id),
          state.tasks.find((t) => t.id === id)?.dependencies.some((d) => visits(d, seen)) ===
            true));
      if (action.dependencies.some((id) => visits(id, new Set())))
        return invalid("Task dependencies cannot contain a cycle.");
      const task: TeamworkTask = {
        id: action.id,
        initiativeId,
        title: action.title,
        brief: action.brief,
        criteria: action.criteria,
        roleId: action.roleId,
        milestoneId: action.milestoneId,
        dependencies: [...new Set(action.dependencies)],
        knowledgeIds: [...new Set(action.knowledgeIds)],
        status: "ready",
        ownerThreadId: null,
        delegatedTaskId: null,
        delegationId: null,
        evidence: "",
        review: null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      next = {
        ...next,
        tasks: [...next.tasks.filter((t) => t.id !== task.id), task],
        initiatives: next.initiatives.map((i) =>
          i.id === initiativeId
            ? {
                ...i,
                milestones: i.milestones.map((m) =>
                  m.id === action.milestoneId || m.id === existing?.milestoneId
                    ? { ...m, accepted: false }
                    : m,
                ),
              }
            : i,
        ),
      };
      if (existing) stop(existing);
      break;
    }
    case "task.reserve":
    case "task.assign":
    case "task.report":
    case "task.review":
    case "task.reset": {
      const task = state.tasks.find((t) => t.id === action.id);
      if (!task) return invalid("Task not found.");
      if (
        action.type === "task.reset" &&
        state.tasks.some(
          (t) => t.dependencies.includes(task.id) && !["ready", "cancelled"].includes(t.status),
        )
      )
        return invalid("Reset dependent assignments before changing their prerequisite.");
      const initiative = state.initiatives.find((i) => i.id === task.initiativeId)!;
      if (action.type === "task.reserve") {
        if (initiative.status !== "active" || !initiative.approved || task.status !== "ready")
          return invalid("Only a ready task in an active, approved initiative can be delegated.");
        if (task.dependencies.some((id) => state.tasks.find((t) => t.id === id)?.status !== "done"))
          return invalid("Complete the task's dependencies first.");
        tasks({ ...task, status: "delegating", delegationId: action.delegationId });
      } else if (action.type === "task.assign") {
        if (task.delegationId !== action.delegationId || task.status !== "delegating")
          return invalid("This delegation reservation is no longer current.");
        if (
          action.threadId === state.coordinatorThreadId ||
          state.tasks.some(
            (t) =>
              t.ownerThreadId === action.threadId &&
              t.id !== task.id &&
              !["done", "cancelled"].includes(t.status),
          )
        )
          return invalid("This thread already owns active work.");
        const assigned = {
          ...task,
          ownerThreadId: action.threadId,
          delegatedTaskId: action.delegatedTaskId,
          status: initiative.status === "active" ? ("running" as const) : ("blocked" as const),
        };
        tasks(assigned);
        if (initiative.status !== "active") stop(assigned);
      } else if (action.type === "task.report") {
        if (actor !== null && actor !== task.ownerThreadId)
          return invalid("Only the assigned worker or user can report this task's result.");
        if (!["running", "blocked", "review"].includes(task.status))
          return invalid("This task has no current assignment to report.");
        tasks({ ...task, status: action.status, evidence: action.evidence, review: null });
        if (initiative.status === "active" && action.status !== "running")
          wake(
            `Task ${task.id} is ${action.status}. Evidence: ${action.evidence}\nRead t3_team_read. A result needs an independent review before approval.`,
            task.initiativeId,
          );
      } else if (action.type === "task.review") {
        if (task.status !== "review" || !task.evidence.trim())
          return invalid("The task needs submitted evidence before review.");
        if (actor !== null && actor === task.ownerThreadId)
          return invalid("A worker cannot approve or review its own task.");
        if (
          actor !== null &&
          !operator &&
          !state.tasks.some(
            (t) => t.initiativeId === task.initiativeId && t.ownerThreadId === actor,
          )
        )
          return forbidden();
        tasks({
          ...task,
          status: action.decision === "approve" ? "done" : "blocked",
          review: { threadId: actor, decision: action.decision, evidence: action.evidence },
        });
        if (initiative.status === "active")
          wake(`Task ${task.id} review: ${action.decision}. ${action.evidence}`, task.initiativeId);
      } else {
        stop(task);
        tasks({
          ...task,
          status: action.status,
          ownerThreadId: null,
          delegatedTaskId: null,
          delegationId: null,
          review: null,
        });
        next = {
          ...next,
          initiatives: next.initiatives.map((i) =>
            i.id === task.initiativeId
              ? {
                  ...i,
                  status: i.status === "completed" ? "paused" : i.status,
                  milestones: i.milestones.map((m) =>
                    m.id === task.milestoneId ? { ...m, accepted: false } : m,
                  ),
                }
              : i,
          ),
        };
      }
      break;
    }
    case "board.post": {
      const initiative = state.initiatives.find((i) => i.id === action.initiativeId);
      if (action.initiativeId !== null && !initiative) return invalid("Initiative not found.");
      if (
        !operator &&
        !state.tasks.some(
          (t) => t.initiativeId === action.initiativeId && t.ownerThreadId === actor,
        )
      )
        return forbidden();
      const recipients = [...new Set(action.recipients)];
      if (
        recipients.some(
          (id) =>
            id === actor ||
            (id !== state.coordinatorThreadId &&
              !state.tasks.some(
                (t) => t.ownerThreadId === id && t.initiativeId === action.initiativeId,
              )),
        )
      )
        return invalid("Recipients must be other participants in this initiative.");
      if (recipients.length && initiative?.status !== "active")
        return invalid("Only active initiatives can wake participants.");
      next = {
        ...next,
        board: [
          ...next.board,
          {
            id: commandId,
            initiativeId: action.initiativeId,
            authorThreadId: actor,
            text: action.text,
            recipients,
            createdAt: now,
          },
        ].slice(-60),
      };
      for (const threadId of recipients)
        intents.push({
          kind: "message",
          threadId,
          initiativeId: action.initiativeId,
          text: `Team board message from ${actor ?? "the user"}:\n${action.text}\nRead t3_team_read for shared state. Reply on the board only when work or a question requires it.`,
        });
      break;
    }
    case "knowledge.save":
      if (
        !operator &&
        state.knowledge.some((k) => k.id === action.id && k.sourceThreadId !== actor)
      )
        return invalid("Only the coordinator or user can correct another author's knowledge.");
      if (
        action.sourceTaskId !== null &&
        !state.tasks.some(
          (t) => t.id === action.sourceTaskId && (operator || t.ownerThreadId === actor),
        )
      )
        return invalid("The source task must belong to you or be managed by the coordinator.");
      next = {
        ...next,
        knowledge: [
          ...next.knowledge.filter((k) => k.id !== action.id),
          {
            id: action.id,
            title: action.title,
            text: action.text,
            sourceThreadId: actor,
            sourceTaskId: action.sourceTaskId,
            updatedAt: now,
          },
        ],
      };
      break;
    case "knowledge.forget":
      next = { ...next, knowledge: next.knowledge.filter((k) => k.id !== action.id) };
      break;
    case "delivery.retry":
      break;
  }
  if (
    next.roles.length > 24 ||
    next.initiatives.length > 100 ||
    next.tasks.length > 400 ||
    next.knowledge.length > 128 ||
    next.initiatives.some((i) => i.milestones.length > 40)
  )
    return Result.fail(
      new TeamworkError({
        reason: "capacity",
        message: "This project has reached its Crew capacity.",
      }),
    );
  return Result.succeed({ snapshot: { ...next, revision: state.revision + 1 }, intents });
}
