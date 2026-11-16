import {
  TeamworkError,
  type TeamworkAction,
  type TeamworkSnapshot,
  type TeamworkTask,
  type ThreadId,
  type ProjectId,
  type TeamworkArchive,
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

const defaultPolicy = { maxConcurrent: 4, maxAttempts: 3, maxSubmissions: 4 };

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
  archive?: TeamworkArchive,
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
  const milestoneHasStartedDependents = (initiativeId: string, milestoneId: string | null) =>
    milestoneId !== null &&
    state.initiatives
      .find((i) => i.id === initiativeId)
      ?.milestones.some(
        (m) =>
          m.dependencies?.includes(milestoneId) &&
          (m.accepted ||
            state.tasks.some(
              (t) =>
                t.initiativeId === initiativeId &&
                t.milestoneId === m.id &&
                !["ready", "cancelled"].includes(t.status),
            )),
      );
  switch (action.type) {
    case "coordinator.pause": {
      if (actor !== null) return forbidden();
      if (state.coordinatorThreadId === null) return invalid("Choose a coordinator first.");
      next = {
        ...next,
        initiatives: state.initiatives.map((i) =>
          i.status === "active" ? { ...i, status: "paused", updatedAt: now } : i,
        ),
      };
      state.tasks.filter((t) => !["done", "cancelled"].includes(t.status)).forEach(stop);
      intents.push({
        kind: "stop",
        threadId: state.coordinatorThreadId,
        initiativeId: null,
        text: "Pause the coordinator and its delegated work for a Crew handover.",
      });
      break;
    }
    case "initiative.archive": {
      const initiative = state.initiatives.find((i) => i.id === action.id);
      if (!initiative || !["completed", "cancelled"].includes(initiative.status))
        return invalid("Complete or cancel the initiative before archiving it.");
      next = {
        ...next,
        initiatives: state.initiatives.filter((i) => i.id !== action.id),
        tasks: state.tasks.filter((t) => t.initiativeId !== action.id),
        board: state.board.filter((entry) => entry.initiativeId !== action.id),
      };
      break;
    }
    case "initiative.restore": {
      if (!archive || archive.initiative.id !== action.id)
        return invalid("Archived initiative not found.");
      if (state.initiatives.some((i) => i.id === action.id))
        return invalid("This initiative is already active in the workspace.");
      next = {
        ...next,
        initiatives: [
          ...state.initiatives,
          { ...archive.initiative, status: "paused", updatedAt: now },
        ],
        tasks: [...state.tasks, ...archive.tasks],
      };
      break;
    }
    case "coordinator.set":
      if (actor !== null) return forbidden();
      if (
        state.tasks.some(
          (t) =>
            t.status === "delegating" ||
            (["running", "blocked", "review"].includes(t.status) &&
              state.initiatives.find((i) => i.id === t.initiativeId)?.status === "active"),
        )
      )
        return invalid(
          "Pause active initiatives and finish attaching reserved workers before replacing the coordinator.",
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
            policy: defaultPolicy,
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
    case "initiative.policy":
    case "milestone.save":
    case "milestone.accept": {
      const id = "initiativeId" in action ? action.initiativeId : action.id;
      const initiative = state.initiatives.find((i) => i.id === id);
      if (!initiative) return invalid("Initiative not found.");
      const owned = state.tasks.filter((t) => t.initiativeId === id);
      let updated = initiative;
      if (action.type === "initiative.policy") {
        updated = { ...initiative, policy: action.policy };
      } else if (action.type === "initiative.edit") {
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
        const dependencies = action.milestone.dependencies ?? [];
        const reachesMilestone = (id: string, visited: Set<string>): boolean =>
          id === action.milestone.id ||
          (!visited.has(id) &&
            (visited.add(id),
            initiative.milestones
              .find((m) => m.id === id)
              ?.dependencies?.some((parent) => reachesMilestone(parent, visited)) === true));
        if (
          dependencies.some(
            (id) =>
              !initiative.milestones.some((m) => m.id === id) || reachesMilestone(id, new Set()),
          )
        )
          return invalid(
            "Milestone prerequisites must exist in this initiative and cannot form a cycle.",
          );
        if (
          initiative.milestones.some(
            (m) =>
              m.dependencies?.includes(action.milestone.id) &&
              (m.accepted ||
                owned.some(
                  (t) => t.milestoneId === m.id && !["ready", "cancelled"].includes(t.status),
                )),
          )
        )
          return invalid(
            "Reset dependent milestone work before changing its verification prerequisite.",
          );
        updated = {
          ...initiative,
          milestones: [
            ...initiative.milestones.filter((m) => m.id !== action.milestone.id),
            { ...action.milestone, accepted: false, verification: null },
          ],
        };
      } else {
        if (!initiative.milestones.some((m) => m.id === action.id))
          return invalid("Milestone not found.");
        if (
          !action.accepted &&
          initiative.milestones.some(
            (m) =>
              m.dependencies?.includes(action.id) &&
              (m.accepted ||
                owned.some(
                  (t) => t.milestoneId === m.id && !["ready", "cancelled"].includes(t.status),
                )),
          )
        )
          return invalid("Reset dependent milestone work before reopening its prerequisite.");
        if (
          action.accepted &&
          initiative.milestones
            .find((m) => m.id === action.id)
            ?.dependencies?.some((id) => !initiative.milestones.find((m) => m.id === id)?.accepted)
        )
          return invalid("Verify and accept the prerequisite milestones first.");
        if (
          action.accepted &&
          (initiative.status !== "active" || !action.artifact || !action.evidence)
        )
          return invalid(
            "Verify the integrated result in an active initiative and provide its immutable artifact and verification evidence.",
          );
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
            m.id === action.id
              ? {
                  ...m,
                  accepted: action.accepted,
                  verification:
                    action.accepted && action.artifact && action.evidence
                      ? {
                          artifact: action.artifact,
                          evidence: action.evidence,
                          submissions: owned
                            .filter((t) => t.milestoneId === m.id && t.status === "done")
                            .map((t) => ({ taskId: t.id, revision: t.submission?.revision ?? 0 })),
                          threadId: actor,
                          createdAt: now,
                        }
                      : null,
                }
              : m,
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
        milestoneHasStartedDependents(initiativeId, action.milestoneId) ||
        (existing && milestoneHasStartedDependents(initiativeId, existing.milestoneId))
      )
        return invalid(
          "Reset dependent milestone work before changing its verification prerequisite.",
        );
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
        attemptCount: existing?.attemptCount ?? (existing?.delegationId ? 1 : 0),
        submissionCount: existing?.submissionCount ?? 0,
        submission: null,
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
                    ? { ...m, accepted: false, verification: null }
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
      if (
        action.type === "task.reset" &&
        milestoneHasStartedDependents(initiative.id, task.milestoneId)
      )
        return invalid(
          "Reset dependent milestone work before changing its verification prerequisite.",
        );
      const policy = initiative.policy ?? defaultPolicy;
      if (action.type === "task.reserve") {
        if (initiative.status !== "active" || !initiative.approved || task.status !== "ready")
          return invalid("Only a ready task in an active, approved initiative can be delegated.");
        if (
          initiative.milestones
            .find((m) => m.id === task.milestoneId)
            ?.dependencies?.some((id) => !initiative.milestones.find((m) => m.id === id)?.accepted)
        )
          return invalid(
            "Verify and accept this task's prerequisite milestones before starting it.",
          );
        if (task.dependencies.some((id) => state.tasks.find((t) => t.id === id)?.status !== "done"))
          return invalid("Complete the task's dependencies first.");
        if (
          state.tasks.filter(
            (t) =>
              t.initiativeId === initiative.id &&
              ["delegating", "running", "blocked", "review"].includes(t.status),
          ).length >= policy.maxConcurrent
        )
          return invalid(
            "This initiative has reached its concurrent assignment limit. Finish or reset an assignment first.",
          );
        const attemptCount = task.attemptCount ?? (task.delegationId ? 1 : 0);
        if (attemptCount >= policy.maxAttempts)
          return invalid(
            "This task has reached its attempt limit. Review the failure and explicitly raise the initiative limit to retry.",
          );
        tasks({
          ...task,
          status: "delegating",
          delegationId: action.delegationId,
          attemptCount: attemptCount + 1,
          submission: null,
        });
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
        if (initiative.status !== "active")
          return invalid("Resume the initiative before reporting further work.");
        if (actor !== null && actor !== task.ownerThreadId)
          return invalid("Only the assigned worker or user can report this task's result.");
        if (!["running", "blocked", "review"].includes(task.status))
          return invalid("This task has no current assignment to report.");
        if (
          task.delegationId === null ||
          (actor !== null && action.attemptId !== task.delegationId) ||
          (action.attemptId !== undefined && action.attemptId !== task.delegationId)
        )
          return invalid(
            "Report the current assignment's attemptId. This update belongs to a missing or replaced assignment.",
          );
        if (action.status === "review" && !action.artifact)
          return invalid(
            "Submit an immutable commit SHA or content digest with the evidence for review.",
          );
        if (action.status === "review" && (task.submissionCount ?? 0) >= policy.maxSubmissions)
          return invalid(
            "This task has reached its submission limit. Review the remaining problems before raising the initiative limit.",
          );
        tasks({
          ...task,
          status: action.status,
          evidence: action.evidence,
          review: null,
          submissionCount: (task.submissionCount ?? 0) + (action.status === "review" ? 1 : 0),
          submission:
            action.status === "review" && action.artifact
              ? {
                  revision: state.revision + 1,
                  attemptId: task.delegationId,
                  artifact: action.artifact,
                  evidence: action.evidence,
                  threadId: actor,
                  createdAt: now,
                }
              : null,
        });
        if (initiative.status === "active" && action.status !== "running")
          wake(
            `Task ${task.id} is ${action.status}. Evidence: ${action.evidence}\nRead t3_team_read. A result needs an independent review before approval.`,
            task.initiativeId,
          );
      } else if (action.type === "task.review") {
        if (initiative.status !== "active")
          return invalid("Resume the initiative before reviewing work.");
        if (task.status !== "review" || !task.evidence.trim())
          return invalid("The task needs submitted evidence before review.");
        if (actor !== null && actor === task.ownerThreadId)
          return invalid("A worker cannot approve or review its own task.");
        if (
          !task.submission ||
          action.submissionRevision !== task.submission.revision ||
          task.submission.attemptId !== task.delegationId
        )
          return invalid(
            "Review the exact current submissionRevision. An older approval cannot accept newer work.",
          );
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
          review: {
            threadId: actor,
            decision: action.decision,
            evidence: action.evidence,
            submissionRevision: task.submission.revision,
          },
        });
        if (
          action.decision === "changes" &&
          task.ownerThreadId !== null &&
          (task.submissionCount ?? 0) < policy.maxSubmissions
        )
          intents.push({
            kind: "message",
            threadId: task.ownerThreadId,
            initiativeId: task.initiativeId,
            taskId: task.id,
            text: `Changes requested for task ${task.id}, submission ${task.submission.revision}:\n${action.evidence}\nRead the current assignment before revising. Report a new immutable artifact for independent review using attemptId ${task.delegationId}.`,
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
          submission: null,
        });
        next = {
          ...next,
          initiatives: next.initiatives.map((i) =>
            i.id === task.initiativeId
              ? {
                  ...i,
                  status: i.status === "completed" ? "paused" : i.status,
                  milestones: i.milestones.map((m) =>
                    m.id === task.milestoneId ? { ...m, accepted: false, verification: null } : m,
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
            revision: state.revision + 1,
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
    case "knowledge.save": {
      const existing = state.knowledge.find((k) => k.id === action.id);
      const initiativeId =
        action.initiativeId === undefined ? (existing?.initiativeId ?? null) : action.initiativeId;
      if (initiativeId !== null && !state.initiatives.some((i) => i.id === initiativeId))
        return invalid("Knowledge scope must name an active workspace initiative.");
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
            sourceRevision: state.revision + 1,
            initiativeId,
            pinned: action.pinned ?? existing?.pinned ?? false,
            excluded: action.excluded ?? existing?.excluded ?? false,
            updatedAt: now,
          },
        ],
      };
      break;
    }
    case "knowledge.forget":
      next = {
        ...next,
        knowledge: next.knowledge.filter((k) => k.id !== action.id),
        tasks: next.tasks.map((t) => ({
          ...t,
          knowledgeIds: t.knowledgeIds.filter((id) => id !== action.id),
        })),
      };
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
