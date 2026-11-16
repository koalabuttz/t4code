import {
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpFailure,
  TeamworkMutateInput,
} from "@t3tools/contracts";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Teamwork from "../../../teamwork/TeamworkMcpService.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    Invocation.McpInvocationContext,
    Threads.ThreadManagementService,
    Teamwork.TeamworkMcpService,
  ],
};
const read = Tool.make("t3_team_read", {
  ...shared,
  description:
    "Read this project's Crew board and revision, 12 entries per collection. Follow nextOffset to page. Summaries are shortened; initiativeId, taskId, knowledgeId or roleId returns full text. context=true includes current sourced context. history=true searches activity with query and optional initiativeId/taskId; page with history.nextBeforeRevision as beforeRevision, and use atRevision for full event text. archived=true lists archives; initiativeId or taskId reads archived work. artifactTaskId, or artifactMilestoneId with initiativeId, checks evidence availability. Restore leaves work paused. Ordinary chat needs no team tools.",
  parameters: Teamwork.TeamworkAgentReadInput,
  success: Teamwork.TeamworkAgentReadResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, Invocation.hiddenFromOutsideClients);
const update = Tool.make("t3_team_update", {
  ...shared,
  description:
    "Change Crew using its latest revision and unique commandId; reuse only for identical retries. Worker task.report uses {id, attemptId, status, evidence, artifact}: id is the task id, attemptId is its current assignment, and evidence describes the result. Status review requires an immutable artifact (full commit SHA or content SHA-256 and path). task.review uses {id, submissionRevision, decision, evidence} for that exact submission; never self-approve. Record new requirements in the changes review's evidence, not task.edit or task.reset: changes preserve the assignment and wake its worker for revision and fresh review. task.edit is only for ready/cancelled tasks. milestone.accept requires integrated artifact and verification evidence. initiative.policy bounds concurrent assignments, attempts and submissions. Swarm starts now; teamwork needs user brief approval. Board recipients get queued messages; omit for a quiet update. Use t3_team_delegate, not task.reserve/assign.",
  parameters: Schema.Struct({
    commandId: TeamworkMutateInput.fields.commandId,
    expectedRevision: TeamworkMutateInput.fields.expectedRevision,
    action: TeamworkMutateInput.fields.action,
  }),
  success: Schema.Struct({ revision: Schema.Number }),
})
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, Invocation.hiddenFromOutsideClients);
const delegate = Tool.make("t3_team_delegate", {
  ...shared,
  description:
    "Coordinator: start the worker for a ready team task. Uses its role's provider/model or inherits yours. Worktree isolation by default; shared only when explicitly suitable. Check orchestrator_capabilities for model choices. Keep requestId for retries; a reserved task must reuse it. Completion wakes the coordinator: end your turn, do not poll. Review evidence separately before marking done.",
  parameters: Teamwork.TeamworkDelegateInput,
  success: OrchestratorMcpDelegateTaskResult,
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, Invocation.hiddenFromOutsideClients);
export const TeamworkToolkit = Toolkit.make(read, update, delegate);
