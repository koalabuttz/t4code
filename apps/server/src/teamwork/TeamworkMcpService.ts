import {
  CommandId,
  OrchestratorMcpFailure,
  type OrchestratorMcpDelegateTaskResult,
  type TeamworkAction,
  TeamworkReadResult,
  TeamworkTaskExecution,
  TeamworkHistoryResult,
  ThreadId,
  MessageId,
  isProviderNativeSubagentThread,
  type TeamworkSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { crewHistoryText } from "@t3tools/shared/crewHistory";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Orchestration from "../mcp/OrchestratorMcpService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Teamwork from "./TeamworkService.ts";
import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import {
  CrewConversationCommand,
  CrewConversationQuery,
  CrewProjectScope,
  type CrewConversationReceipt,
  type CrewConversationPage,
} from "@t3tools/contracts/crewConversation";

export const TeamworkConversationCommandInput = Schema.Struct({
  ...CrewConversationCommand.fields,
  scope: Schema.optional(CrewProjectScope),
});
export const TeamworkConversationQueryInput = Schema.Struct({
  ...CrewConversationQuery.fields,
  scope: Schema.optional(CrewProjectScope),
});

export const TeamworkDelegateInput = Schema.Struct({
  taskId: Schema.String,
  requestId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  isolation: Schema.optional(Schema.Literals(["worktree", "shared"])),
  workstreamThreadId: Schema.optional(ThreadId),
});
export const TeamworkAgentReadInput = Schema.Struct({
  initiativeId: Schema.optional(Schema.String),
  taskId: Schema.optional(Schema.String),
  knowledgeId: Schema.optional(Schema.String),
  roleId: Schema.optional(Schema.String),
  artifactTaskId: Schema.optional(Schema.String),
  artifactMilestoneId: Schema.optional(Schema.String),
  context: Schema.optional(Schema.Boolean),
  history: Schema.optional(Schema.Boolean),
  archived: Schema.optional(Schema.Boolean),
  beforeRevision: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
  atRevision: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  offset: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
});
export const TeamworkAgentReadResult = Schema.Struct({
  ...TeamworkReadResult.fields,
  nextOffset: Schema.NullOr(Schema.Number),
  execution: Schema.Array(TeamworkTaskExecution),
  artifact: TeamworkHistoryResult.fields.artifact,
  history: Schema.optional(
    Schema.Struct({
      events: Schema.Array(
        Schema.Struct({
          revision: Schema.Number,
          kind: Schema.String,
          text: Schema.String,
          sourceThreadId: Schema.NullOr(ThreadId),
          createdAt: Schema.String,
        }),
      ),
      nextBeforeRevision: Schema.NullOr(Schema.Number),
      archives: TeamworkHistoryResult.fields.archives,
    }),
  ),
});
export class TeamworkMcpService extends Context.Service<
  TeamworkMcpService,
  {
    readonly read: (
      scope: Invocation.McpInvocationScope,
      input: typeof TeamworkAgentReadInput.Type,
    ) => Effect.Effect<typeof TeamworkAgentReadResult.Type, OrchestratorMcpFailure>;
    readonly update: (
      scope: Invocation.McpInvocationScope,
      input: { commandId: CommandId; expectedRevision: number; action: TeamworkAction },
    ) => Effect.Effect<{ revision: number }, OrchestratorMcpFailure>;
    readonly delegate: (
      scope: Invocation.McpInvocationScope,
      input: typeof TeamworkDelegateInput.Type,
    ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure>;
    readonly conversationCommand: (
      scope: Invocation.McpInvocationScope,
      input: typeof TeamworkConversationCommandInput.Type,
    ) => Effect.Effect<CrewConversationReceipt, OrchestratorMcpFailure>;
    readonly conversationQuery: (
      scope: Invocation.McpInvocationScope,
      input: typeof TeamworkConversationQueryInput.Type,
    ) => Effect.Effect<CrewConversationPage, OrchestratorMcpFailure>;
  }
>()("t3/teamwork/TeamworkMcpService") {}

const failure = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
const make = Effect.gen(function* () {
  const teams = yield* Teamwork.TeamworkService;
  const threads = yield* Threads.ThreadManagementService;
  const orchestration = yield* Orchestration.OrchestratorMcpService;
  const locks = yield* KeyedLock.make<string>();
  const caller = Effect.fn("TeamworkMcpService.caller")(function* (
    scope: Invocation.McpInvocationScope,
  ) {
    const bound = yield* Invocation.requireThreadScope(scope, "t3_team_read");
    const thread = yield* threads
      .getThreadShell(bound.thread.threadId)
      .pipe(Effect.mapError(() => failure("Could not read the calling thread.")));
    if (!thread || thread.deletedAt !== null)
      return yield* failure("The calling thread no longer exists.");
    return { bound, thread };
  });
  const read = Effect.fn("TeamworkMcpService.read")(function* (
    scope: Invocation.McpInvocationScope,
    input: typeof TeamworkAgentReadInput.Type,
  ) {
    const { thread } = yield* caller(scope);
    const result = yield* teams
      .read(thread.projectId, thread.id)
      .pipe(Effect.mapError((e) => failure(e.message)));
    const history =
      input.history || input.archived || input.artifactTaskId || input.artifactMilestoneId
        ? yield* teams
            .history(
              {
                projectId: thread.projectId,
                artifactTaskId: input.artifactTaskId,
                artifactMilestoneId: input.artifactMilestoneId,
                ...(input.initiativeId === undefined ? {} : { initiativeId: input.initiativeId }),
                ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
                ...(input.query === undefined ? {} : { query: input.query }),
                ...(input.beforeRevision === undefined
                  ? {}
                  : { beforeRevision: input.beforeRevision }),
                ...(input.atRevision === undefined ? {} : { atRevision: input.atRevision }),
                ...(input.archived === undefined ? {} : { archived: input.archived }),
              },
              thread.id,
            )
            .pipe(Effect.mapError((e) => failure(e.message)))
        : undefined;
    const snapshot = input.archived
      ? {
          ...result.snapshot,
          initiatives: history?.archive ? [history.archive.initiative] : [],
          tasks: history?.archive?.tasks ?? [],
          board: [],
        }
      : result.snapshot;
    const roles = snapshot.roles.filter((r) => !input.roleId || r.id === input.roleId);
    const offset = input.offset ?? 0;
    const initiatives = snapshot.initiatives.filter(
      (i) => !input.initiativeId || i.id === input.initiativeId,
    );
    const tasks = snapshot.tasks.filter(
      (t) =>
        (!input.initiativeId || t.initiativeId === input.initiativeId) &&
        (!input.taskId || t.id === input.taskId),
    );
    const knowledge = snapshot.knowledge.filter(
      (k) => !input.knowledgeId || k.id === input.knowledgeId,
    );
    const board = snapshot.board.filter(
      (b) => !input.initiativeId || b.initiativeId === input.initiativeId,
    );
    return {
      ...result,
      context: input.context ? result.context : undefined,
      artifact: history?.artifact,
      ...(history
        ? {
            history: {
              events: history.events.slice(0, 12).map((event) => ({
                revision: event.revision,
                kind: event.action.type,
                text:
                  input.atRevision === undefined
                    ? crewHistoryText(event.action).slice(0, 1200)
                    : crewHistoryText(event.action),
                sourceThreadId: event.actorThreadId,
                createdAt: event.createdAt,
              })),
              nextBeforeRevision:
                history.events.length > 12
                  ? history.events[11]!.revision
                  : (history.nextBeforeRevision ?? null),
              ...(history.archives === undefined ? {} : { archives: history.archives }),
            },
          }
        : {}),
      execution: yield* teams
        .execution(
          thread.projectId,
          tasks.slice(offset, offset + 12).map((task) => task.id),
          thread.id,
        )
        .pipe(Effect.mapError((e) => failure(e.message))),
      deliveries: result.deliveries.filter((d) => d.status === "failed").slice(offset, offset + 12),
      nextOffset:
        Math.max(initiatives.length, tasks.length, knowledge.length, board.length, roles.length) >
        offset + 12
          ? offset + 12
          : null,
      snapshot: {
        ...snapshot,
        roles: roles
          .slice(offset, offset + 12)
          .map((r) => (input.roleId ? r : { ...r, instructions: r.instructions.slice(0, 240) })),
        initiatives: initiatives.slice(offset, offset + 12).map((i) =>
          input.initiativeId
            ? i
            : {
                ...i,
                brief: i.brief.slice(0, 240),
                milestones: i.milestones.map((m) => ({
                  ...m,
                  criteria: m.criteria.slice(0, 240),
                  verification: m.verification
                    ? { ...m.verification, evidence: m.verification.evidence.slice(0, 240) }
                    : m.verification,
                })),
              },
        ),
        tasks: tasks.slice(offset, offset + 12).map((t) =>
          input.taskId
            ? t
            : {
                ...t,
                brief: t.brief.slice(0, 240),
                criteria: t.criteria.slice(0, 240),
                evidence: t.evidence.slice(0, 240),
                submission: t.submission
                  ? { ...t.submission, evidence: t.submission.evidence.slice(0, 240) }
                  : t.submission,
                review: t.review
                  ? { ...t.review, evidence: t.review.evidence.slice(0, 240) }
                  : t.review,
              },
        ),
        knowledge: knowledge
          .slice(offset, offset + 12)
          .map((k) => (input.knowledgeId ? k : { ...k, text: k.text.slice(0, 240) })),
        board: board
          .slice()
          .reverse()
          .slice(offset, offset + 12)
          .map((b) => ({ ...b, text: b.text.slice(0, 1200) })),
      },
    };
  });
  const update = Effect.fn("TeamworkMcpService.update")(function* (
    scope: Invocation.McpInvocationScope,
    input: { commandId: CommandId; expectedRevision: number; action: TeamworkAction },
  ) {
    const { thread } = yield* caller(scope);
    if (["task.reserve", "task.assign"].includes(input.action.type))
      return yield* failure("Use t3_team_delegate to assign a task and create its worker.");
    const result = yield* teams
      .mutate({ ...input, projectId: thread.projectId }, thread.id)
      .pipe(Effect.mapError((e) => failure(e.message)));
    return { revision: result.snapshot.revision };
  });
  const delegate = Effect.fn("TeamworkMcpService.delegate")(function* (
    scope: Invocation.McpInvocationScope,
    input: typeof TeamworkDelegateInput.Type,
  ) {
    const { thread } = yield* caller(scope);
    return yield* locks.withLock(
      thread.projectId,
      Effect.gen(function* () {
        let state = (yield* teams
          .read(thread.projectId, thread.id)
          .pipe(Effect.mapError((e) => failure(e.message)))).snapshot;
        if (state.coordinatorThreadId !== thread.id)
          return yield* failure("Only the project coordinator delegates team tasks.");
        let task = state.tasks.find((t) => t.id === input.taskId);
        if (!task) return yield* failure("Create the task on the team board first.");
        if (task.delegatedTaskId !== null) {
          if (
            input.workstreamThreadId !== undefined &&
            task.ownerThreadId !== input.workstreamThreadId
          )
            return yield* failure(
              "This attempt already belongs to another workstream. Preserve its assignment.",
            );
          const owner = task.ownerThreadId
            ? yield* threads
                .getThreadShell(task.ownerThreadId)
                .pipe(Effect.mapError(() => failure("Could not read the assigned worker.")))
            : null;
          if (owner?.lineage?.parentThreadId !== thread.id)
            return yield* failure(
              "This task already has an assignment from the previous coordinator. Preserve it: read taskId for current state and send targeted board messages to ownerThreadId. Reset only when intentionally replacing the worker.",
            );
          return yield* orchestration.taskStatus(scope, task.delegatedTaskId);
        }
        if (task.delegationId !== null && task.delegationId !== input.requestId)
          return yield* failure(
            `Retry the reserved delegation with requestId ${task.delegationId}, or reset the task before assigning new work.`,
          );
        if (task.status === "ready") {
          state = (yield* teams
            .mutate(
              {
                projectId: thread.projectId,
                commandId: CommandId.make(`team-reserve:${task.id}:${input.requestId}`),
                expectedRevision: state.revision,
                action: { type: "task.reserve", id: task.id, delegationId: input.requestId },
              },
              thread.id,
            )
            .pipe(Effect.mapError((e) => failure(e.message)))).snapshot;
          task = state.tasks.find((t) => t.id === input.taskId)!;
        }
        const initiative = state.initiatives.find((i) => i.id === task.initiativeId)!;
        if (initiative.status !== "active" || task.status !== "delegating")
          return yield* failure(
            "This assignment is not active. Resume the initiative or reset the task first.",
          );
        const profile = state.roles.find((r) => r.id === task.roleId);
        yield* teams
          .bindImplementationDestination(
            thread.projectId,
            task.id,
            input.requestId,
            input.workstreamThreadId ?? null,
            thread.id,
          )
          .pipe(Effect.mapError((e) => failure(e.message)));
        const brief = workerBrief(state, task.id);
        const stableScope = {
          ...scope,
          requestNamespace: `teamwork:${thread.projectId}:${task.id}:${input.requestId}`,
        };
        const result =
          input.workstreamThreadId === undefined
            ? yield* orchestration.delegateTask(stableScope, {
                task: brief,
                title: profile ? `${profile.name}: ${task.title}` : task.title,
                clientRequestId: input.requestId,
                isolation: input.isolation ?? "worktree",
                mode: "async",
                ...(profile?.modelSelection == null
                  ? {}
                  : {
                      target: {
                        providerInstanceId: profile.modelSelection.instanceId,
                        model: profile.modelSelection.model,
                        ...(profile.modelSelection.options === undefined
                          ? {}
                          : { options: profile.modelSelection.options }),
                      },
                    }),
              })
            : yield* Effect.gen(function* () {
                const threadId = input.workstreamThreadId!;
                const page = yield* teams
                  .conversationQuery(
                    {
                      scope: { environmentId: scope.environmentId, projectId: thread.projectId },
                      collection: "workstreams",
                      threadId,
                      limit: 1,
                    },
                    thread.id,
                  )
                  .pipe(Effect.mapError((e) => failure(e.message)));
                if (page.workstreams[0]?.status !== "open")
                  return yield* failure(
                    "Explicitly link and reopen this workstream before assigning implementation.",
                  );
                const child = yield* threads
                  .getThreadShell(threadId)
                  .pipe(Effect.mapError(() => failure("Workstream unavailable.")));
                if (
                  !child ||
                  child.deletedAt !== null ||
                  child.projectId !== thread.projectId ||
                  isProviderNativeSubagentThread(child) ||
                  child.linkOrigin != null ||
                  child.lineage.parentThreadId !== thread.id ||
                  child.lineage.relationshipToParent !== "subagent" ||
                  child.forkedFrom?.type !== "node"
                )
                  return yield* failure(
                    "Reuse requires this coordinator's existing app-owned delegated child. Root conversations and previous-coordinator children need explicit recovery; lineage is never rewritten.",
                  );
                if (profile?.modelSelection != null)
                  return yield* failure(
                    "An explicit role provider/model override needs a new reviewed selection; reuse preserves the workstream's provider and model.",
                  );
                if (
                  input.isolation !== undefined &&
                  (input.isolation === "worktree") !== (child.worktreePath !== null)
                )
                  return yield* failure(
                    "Reuse preserves the workstream's existing workspace isolation.",
                  );
                if (
                  state.tasks.some(
                    (t) =>
                      t.id !== task.id &&
                      t.ownerThreadId === threadId &&
                      !["done", "cancelled"].includes(t.status),
                  )
                )
                  return yield* failure(
                    "This workstream already owns active implementation. Reconcile ownership before assigning another task.",
                  );
                const board = yield* teams
                  .read(thread.projectId, thread.id)
                  .pipe(Effect.mapError((e) => failure(e.message)));
                if (
                  board.deliveries.some(
                    (d) =>
                      d.threadId === threadId &&
                      d.kind === "stop" &&
                      ["pending", "failed"].includes(d.status),
                  )
                )
                  return yield* failure("Resolve the workstream's outstanding stop before reuse.");
                const commandId = CommandId.make(
                  `crew-implementation:${thread.projectId}:${task.id}:${input.requestId}`,
                );
                const replay = yield* threads
                  .hasReceipt(commandId)
                  .pipe(
                    Effect.mapError(() =>
                      failure("Could not check implementation delivery receipt."),
                    ),
                  );
                if (
                  !replay &&
                  (!(
                    [
                      "idle",
                      "completed",
                      "failed",
                      "interrupted",
                      "cancelled",
                      "rolled_back",
                    ] as ReadonlyArray<string>
                  ).includes(child.activityRunStatus ?? child.status ?? "") ||
                    child.pendingRuntimeRequest != null ||
                    (child.pendingBackgroundTasks?.length ?? 0) > 0)
                )
                  return yield* failure(
                    "The workstream is busy or its execution is uncertain. Wait for it to stop before reusing it; no replacement was started.",
                  );
                const original = yield* threads
                  .getThreadRecords(thread.id, ["subagents"], {
                    subagentIds: [child.forkedFrom.nodeId],
                  })
                  .pipe(
                    Effect.mapError(() =>
                      failure("Could not verify the workstream's original delegation."),
                    ),
                  );
                if (
                  !original.subagents.some(
                    (t) =>
                      t.origin === "app_owned" && t.childThreadId === threadId && t.result !== null,
                  )
                )
                  return yield* failure(
                    "The original delegated work must finish before a new implementation attempt can reuse its conversation.",
                  );
                const sent = yield* threads
                  .sendToThread({
                    projectId: thread.projectId,
                    threadId,
                    commandId,
                    messageId: MessageId.make(commandId),
                    senderThreadId: thread.id,
                    text: brief,
                    attachments: [],
                    mode: "queue",
                    createdBy: "agent",
                    creationSource: "mcp",
                  })
                  .pipe(
                    Effect.provideService(DispatchModeLimit, {
                      runtimeMode: thread.runtimeMode,
                      interactionMode: thread.interactionMode,
                    }),
                    Effect.mapError((e) => failure(e.message)),
                  );
                if (sent.run.delegatedTaskId === undefined)
                  return yield* failure(
                    "The implementation send did not produce a tracked follow-up assignment. Inspect and stop that exact run before retrying; no synthetic task id was created.",
                  );
                return yield* orchestration.taskStatus(scope, sent.run.delegatedTaskId);
              });
        if (result.childThreadId === null)
          return yield* failure("Team tasks require an environment-local worker thread.");
        for (let attempt = 0; attempt < 4; attempt++) {
          const current = yield* teams
            .read(thread.projectId, thread.id)
            .pipe(Effect.mapError((e) => failure(e.message)));
          const attached = yield* Effect.result(
            teams.mutate(
              {
                projectId: thread.projectId,
                commandId: CommandId.make(`team-assign:${task.id}:${input.requestId}`),
                expectedRevision: current.snapshot.revision,
                action: {
                  type: "task.assign",
                  id: task.id,
                  delegationId: input.requestId,
                  threadId: result.childThreadId,
                  delegatedTaskId: result.taskId,
                },
              },
              thread.id,
            ),
          );
          if (Result.isSuccess(attached)) return result;
          if (attached.failure.reason !== "conflict") break;
        }
        yield* orchestration.cancelTask(scope, {
          taskId: result.taskId,
          reason: "The team assignment changed before its worker could be attached.",
        });
        return yield* failure(
          "The assignment changed. Its new worker was stopped; read the team board before retrying.",
        );
      }),
    );
  });
  return TeamworkMcpService.of({
    read,
    update,
    delegate,
    conversationCommand: Effect.fn("TeamworkMcpService.conversationCommand")(
      function* (scope, input) {
        const { thread } = yield* caller(scope);
        if (
          input.scope &&
          (input.scope.projectId !== thread.projectId ||
            input.scope.environmentId !== scope.environmentId)
        )
          return yield* failure("Use the calling conversation's environment and project.");
        return yield* teams
          .conversationCommand(
            {
              ...input,
              scope: { projectId: thread.projectId, environmentId: scope.environmentId },
            },
            thread.id,
          )
          .pipe(Effect.mapError((e) => failure(e.message)));
      },
    ),
    conversationQuery: Effect.fn("TeamworkMcpService.conversationQuery")(function* (scope, input) {
      const { thread } = yield* caller(scope);
      if (
        input.scope &&
        (input.scope.projectId !== thread.projectId ||
          input.scope.environmentId !== scope.environmentId)
      )
        return yield* failure("Use the calling conversation's environment and project.");
      return yield* teams
        .conversationQuery(
          { ...input, scope: { projectId: thread.projectId, environmentId: scope.environmentId } },
          thread.id,
        )
        .pipe(Effect.mapError((e) => failure(e.message)));
    }),
  });
});

function workerBrief(state: TeamworkSnapshot, taskId: string): string {
  const task = state.tasks.find((t) => t.id === taskId)!;
  const initiative = state.initiatives.find((i) => i.id === task.initiativeId)!;
  const role = state.roles.find((r) => r.id === task.roleId);
  const knowledge = state.knowledge.filter((k) => task.knowledgeIds.includes(k.id) && !k.excluded);
  return [
    `You own team task ${task.id}, attemptId ${task.delegationId}, in initiative ${initiative.id}: ${initiative.title}. Include this attemptId in task.report.`,
    `Project brief:\n${initiative.brief}`,
    role ? `Role: ${role.name}\n${role.instructions}` : "",
    `Assignment:\n${task.brief}\nAcceptance criteria:\n${task.criteria}`,
    knowledge.length
      ? `Selected project knowledge: ${knowledge.map((k) => `${k.id} (${k.title})`).join(", ")}. Read their current contents with t3_team_read knowledgeId; notes can be corrected or forgotten.`
      : "",
    "Use t3_team_read with taskId to read current state. Report blockers or results with t3_team_update task.report and concrete evidence. For status review, include artifact {kind: commit, ref: full commit SHA}, or {kind: content, ref: SHA-256, path: file path} for non-code work. Each submission needs independent review of its exact submissionRevision; never self-approve. Requested changes require a new artifact and fresh review. Do not automatically merge or publish. Use board.post with explicit recipients for necessary questions; avoid acknowledgement loops. Your final answer also returns through T3's normal delegated completion. Do not start further agents unless the assignment explicitly authorizes them.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export const layer = Layer.effect(TeamworkMcpService, make);
