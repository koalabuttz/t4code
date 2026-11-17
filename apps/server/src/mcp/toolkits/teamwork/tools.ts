import {
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpFailure,
  TeamworkMutateInput,
} from "@t3tools/contracts";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";
import {
  CrewConversationCommand,
  CrewConversationQuery,
  CrewConversationReceipt,
  CrewConversationPage,
} from "@t3tools/contracts/crewConversation";
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
    "Coordinator: start the worker for a ready team task. workstreamThreadId reuses an open, stopped, completed app-owned child of this coordinator with its existing provider/model/workspace; root or previous-coordinator conversations need explicit recovery. Omit it to create a durable workstream using the role's provider/model or inheriting yours. Worktree isolation by default for new workers. Check orchestrator_capabilities for model choices. Keep requestId and destination for retries; a reserved task must reuse them. Busy or uncertain ownership blocks reuse. Completion wakes the coordinator: end your turn, do not poll. Review evidence separately before marking done.",
  parameters: Teamwork.TeamworkDelegateInput,
  success: OrchestratorMcpDelegateTaskResult,
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, Invocation.hiddenFromOutsideClients);
const conversationRead = Tool.make("t3_crew_conversations", {
  ...shared,
  description:
    "Read this project's linked persistent workstreams, consultations, handoffs or coordinator attention. Use scope with the caller's environment/project and collection; follow nextCursor. Canonical source references preserve attribution; read their source conversation with its access checks. Queued delivery is not proof the provider considered it. Ordinary independent threads do not participate until explicitly linked.",
  parameters: CrewConversationQuery,
  success: CrewConversationPage,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, Invocation.hiddenFromOutsideClients);
const conversationCommand = Tool.make("t3_crew_conversation_command", {
  ...shared,
  description:
    "Coordinator: manage persistent workstreams, correlated specialist consultations and visible handoffs. Use current Crew revision and a unique commandId; reuse only an identical retry. Consult the existing linked thread with consultation.request using exact canonical origin/context references; its actual final answer returns to that origin. Follow-ups use replyTo consultationId/responseId. Do not use board.post for consultations or create a replacement specialist for a question. A handoff requires a visible explanation at the origin and reconciled implementation ownership; forwarding never authorizes a second owner. Link/status changes start no work and never resume paused implementation. Human-only questions, secrets and approvals remain human-only. Coordination is a behavioral role: delegate implementation and preserve the selected provider and user permissions. Missing a complete implementation-tool allowlist does not block otherwise supported coordination. Report hard-enforcement limits honestly; never claim instructions enforce tools, silently switch providers or implement yourself.",
  parameters: CrewConversationCommand,
  success: CrewConversationReceipt,
})
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, Invocation.hiddenFromOutsideClients);
export const TeamworkToolkit = Toolkit.make(
  read,
  update,
  delegate,
  conversationRead,
  conversationCommand,
);
