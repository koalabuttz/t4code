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
    "Read this project's Crew board and revision, 12 entries per collection. Follow nextOffset to page. Summaries are shortened; initiativeId, taskId or knowledgeId returns that item's full text. Ordinary chat needs no team tools.",
  parameters: Teamwork.TeamworkAgentReadInput,
  success: Teamwork.TeamworkAgentReadResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, Invocation.hiddenFromOutsideClients);
const update = Tool.make("t3_team_update", {
  ...shared,
  description:
    "Change this project's Crew board using its latest revision and a unique commandId; reuse that id only for identical retries. Coordinator manages initiatives/tasks. Worker reports its own evidence for independent review; never self-approve. Mode swarm starts now; teamwork requires user-only brief approval. Board recipients get queued messages; omit recipients for a quiet update. Delegate with t3_team_delegate, not task.reserve/assign.",
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
