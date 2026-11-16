import * as Schema from "effect/Schema";
import {
  CommandId,
  IsoDateTime,
  NodeId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(120));
const Title = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
const Text = TrimmedNonEmptyString.check(Schema.isMaxLength(12000));
export const TeamworkMode = Schema.Literals(["swarm", "teamwork"]);
export const TeamworkStatus = Schema.Literals([
  "draft",
  "active",
  "paused",
  "completed",
  "cancelled",
]);
export const TeamworkRole = Schema.Struct({
  id: Id,
  name: Title,
  instructions: Text,
  modelSelection: Schema.NullOr(ModelSelection),
});
export type TeamworkRole = typeof TeamworkRole.Type;
export const TeamworkMilestone = Schema.Struct({
  id: Id,
  title: Title,
  criteria: Text,
  accepted: Schema.Boolean,
});
export const TeamworkInitiative = Schema.Struct({
  id: Id,
  title: Title,
  brief: Text,
  mode: TeamworkMode,
  status: TeamworkStatus,
  approved: Schema.Boolean,
  milestones: Schema.Array(TeamworkMilestone),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TeamworkInitiative = typeof TeamworkInitiative.Type;
export const TeamworkTask = Schema.Struct({
  id: Id,
  initiativeId: Id,
  title: Title,
  brief: Text,
  criteria: Text,
  roleId: Schema.NullOr(Id),
  milestoneId: Schema.NullOr(Id),
  dependencies: Schema.Array(Id),
  knowledgeIds: Schema.Array(Id),
  status: Schema.Literals([
    "ready",
    "delegating",
    "running",
    "blocked",
    "review",
    "done",
    "cancelled",
  ]),
  ownerThreadId: Schema.NullOr(ThreadId),
  delegatedTaskId: Schema.NullOr(NodeId),
  delegationId: Schema.NullOr(Id),
  evidence: Schema.String,
  review: Schema.NullOr(
    Schema.Struct({
      threadId: Schema.NullOr(ThreadId),
      decision: Schema.Literals(["approve", "changes"]),
      evidence: Text,
    }),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TeamworkTask = typeof TeamworkTask.Type;
export const TeamworkExecutionState = Schema.Literals([
  "unassigned",
  "starting",
  "working",
  "approval",
  "input",
  "waiting",
  "finished",
  "stopped",
  "failed",
  "unavailable",
  "unknown",
  "disconnected",
]);
export type TeamworkExecutionState = typeof TeamworkExecutionState.Type;
export const TeamworkTaskExecution = Schema.Struct({
  taskId: Id,
  threadId: Schema.NullOr(ThreadId),
  state: TeamworkExecutionState,
  detail: Schema.NullOr(Schema.String),
  needsAttention: Schema.Boolean,
});
export type TeamworkTaskExecution = typeof TeamworkTaskExecution.Type;
export const TeamworkKnowledge = Schema.Struct({
  id: Id,
  title: Title,
  text: Text,
  sourceThreadId: Schema.NullOr(ThreadId),
  sourceTaskId: Schema.NullOr(Id),
  updatedAt: IsoDateTime,
});
export const TeamworkBoardEntry = Schema.Struct({
  id: Schema.String,
  initiativeId: Schema.NullOr(Id),
  authorThreadId: Schema.NullOr(ThreadId),
  text: Text,
  recipients: Schema.Array(ThreadId),
  createdAt: IsoDateTime,
});
export const TeamworkSnapshot = Schema.Struct({
  projectId: ProjectId,
  revision: NonNegativeInt,
  coordinatorThreadId: Schema.NullOr(ThreadId),
  roles: Schema.Array(TeamworkRole),
  initiatives: Schema.Array(TeamworkInitiative),
  tasks: Schema.Array(TeamworkTask),
  knowledge: Schema.Array(TeamworkKnowledge),
  board: Schema.Array(TeamworkBoardEntry),
});
export type TeamworkSnapshot = typeof TeamworkSnapshot.Type;

const TaskDefinition = {
  title: Title,
  brief: Text,
  criteria: Text,
  roleId: Schema.NullOr(Id),
  milestoneId: Schema.NullOr(Id),
  dependencies: Schema.Array(Id).check(Schema.isMaxLength(30)),
  knowledgeIds: Schema.Array(Id).check(Schema.isMaxLength(12)),
};
export const TeamworkAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("coordinator.set"), threadId: ThreadId }),
  Schema.Struct({ type: Schema.Literal("role.save"), role: TeamworkRole }),
  Schema.Struct({ type: Schema.Literal("role.remove"), id: Id }),
  Schema.Struct({
    type: Schema.Literal("initiative.create"),
    id: Id,
    title: Title,
    brief: Text,
    mode: TeamworkMode,
  }),
  Schema.Struct({
    type: Schema.Literal("initiative.edit"),
    id: Id,
    title: Title,
    brief: Text,
    mode: TeamworkMode,
  }),
  Schema.Struct({ type: Schema.Literal("initiative.approve"), id: Id }),
  Schema.Struct({ type: Schema.Literal("initiative.status"), id: Id, status: TeamworkStatus }),
  Schema.Struct({
    type: Schema.Literal("milestone.save"),
    initiativeId: Id,
    milestone: TeamworkMilestone,
  }),
  Schema.Struct({
    type: Schema.Literal("milestone.accept"),
    initiativeId: Id,
    id: Id,
    accepted: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("task.create"),
    id: Id,
    initiativeId: Id,
    ...TaskDefinition,
  }),
  Schema.Struct({ type: Schema.Literal("task.edit"), id: Id, ...TaskDefinition }),
  Schema.Struct({ type: Schema.Literal("task.reserve"), id: Id, delegationId: Id }),
  Schema.Struct({
    type: Schema.Literal("task.assign"),
    id: Id,
    delegationId: Id,
    threadId: ThreadId,
    delegatedTaskId: NodeId,
  }),
  Schema.Struct({
    type: Schema.Literal("task.report"),
    id: Id,
    status: Schema.Literals(["running", "blocked", "review"]),
    evidence: Text,
  }),
  Schema.Struct({
    type: Schema.Literal("task.review"),
    id: Id,
    decision: Schema.Literals(["approve", "changes"]),
    evidence: Text,
  }),
  Schema.Struct({
    type: Schema.Literal("task.reset"),
    id: Id,
    status: Schema.Literals(["ready", "cancelled"]),
  }),
  Schema.Struct({
    type: Schema.Literal("board.post"),
    initiativeId: Schema.NullOr(Id),
    text: Text,
    recipients: Schema.Array(ThreadId).check(Schema.isMaxLength(8)),
  }),
  Schema.Struct({
    type: Schema.Literal("knowledge.save"),
    id: Id,
    title: Title,
    text: Text,
    sourceTaskId: Schema.NullOr(Id),
  }),
  Schema.Struct({ type: Schema.Literal("knowledge.forget"), id: Id }),
  Schema.Struct({ type: Schema.Literal("delivery.retry"), id: Schema.String }),
]);
export type TeamworkAction = typeof TeamworkAction.Type;
export const TeamworkReadInput = Schema.Struct({ projectId: ProjectId });
export const TeamworkMutateInput = Schema.Struct({
  projectId: ProjectId,
  commandId: CommandId,
  expectedRevision: NonNegativeInt,
  action: TeamworkAction,
});
export type TeamworkMutateInput = typeof TeamworkMutateInput.Type;
export const TeamworkDelivery = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  status: Schema.Literals(["pending", "delivered", "failed", "cancelled"]),
  kind: Schema.Literals(["message", "stop"]),
});
export const TeamworkReadResult = Schema.Struct({
  snapshot: TeamworkSnapshot,
  deliveries: Schema.Array(TeamworkDelivery),
});
export type TeamworkReadResult = typeof TeamworkReadResult.Type;
export const TeamworkHistoryInput = Schema.Struct({
  projectId: ProjectId,
  beforeRevision: Schema.optional(NonNegativeInt),
});
export const TeamworkHistoryResult = Schema.Struct({
  events: Schema.Array(
    Schema.Struct({
      revision: NonNegativeInt,
      actorThreadId: Schema.NullOr(ThreadId),
      action: TeamworkAction,
      createdAt: IsoDateTime,
    }),
  ),
});
export type TeamworkHistoryResult = typeof TeamworkHistoryResult.Type;
export class TeamworkError extends Schema.TaggedError<TeamworkError>()("TeamworkError", {
  reason: Schema.Literals([
    "conflict",
    "not-found",
    "forbidden",
    "invalid-state",
    "capacity",
    "storage",
    "execution",
  ]),
  message: Schema.String,
}) {}
