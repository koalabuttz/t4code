import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type TeamworkAction,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as Result from "effect/Result";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Orchestration from "../mcp/OrchestratorMcpService.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Teamwork from "./TeamworkService.ts";
import * as Mcp from "./TeamworkMcpService.ts";
import { crewRetainsArtifacts } from "./artifactRetention.ts";
import { CrewArtifacts } from "./CrewArtifacts.ts";

it.effect(
  "reserves one worker across retries and enforces owner reports and independent review",
  () => {
    const projectId = ProjectId.make("project");
    const coordinator = ThreadId.make("coordinator");
    const worker = ThreadId.make(
      "thread:delegated-task:command%3Amcp%3Ateamwork%253A00000000-0000-4000-8000-000000000000%253Aandroid-doc%253Aandroid-doc-assign%3Adelegate-task%3Aandroid-doc-assign",
    );
    const taskId = NodeId.make("native-task");
    const calls: string[] = [];
    const reused: string[] = [];
    let workerStatus: "running" | "completed" = "running";
    const scope: McpInvocationScope = {
      environmentId: EnvironmentId.make("environment"),
      capabilities: new Set(["orchestration"]),
      issuedAt: 0,
      requestNamespace: "turn-1",
      thread: {
        threadId: coordinator,
        providerSessionId: "session",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
    };
    const threadLayer = Layer.mock(Threads.ThreadManagementService)({
      streamStoredEvents: Stream.empty,
      streamStoredEventsFrom: () => Stream.empty,
      getShellSnapshot: () =>
        Effect.succeed({
          threads: [{ id: worker, status: workerStatus, deletedAt: null }],
        } as never),
      getThreadShell: (id) =>
        Effect.succeed({
          id,
          projectId,
          deletedAt: null,
          status: workerStatus,
          creationSource: "mcp",
          worktreePath: null,
          forkedFrom: { type: "node", nodeId: taskId },
          pendingRuntimeRequest: null,
          lineage: {
            parentThreadId: id === coordinator ? null : coordinator,
            relationshipToParent: id === coordinator ? null : "subagent",
            rootThreadId: coordinator,
          },
          runtimeMode: "full-access",
          interactionMode: "default",
        } as never),
      hasReceipt: () => Effect.succeed(false),
      getThreadRecords: () =>
        Effect.succeed({
          subagents: [{ origin: "app_owned", childThreadId: worker, result: "Finished" }],
        } as never),
      sendToThread: (input) => {
        if (input.creationSource === "mcp") reused.push(input.commandId);
        return Effect.succeed({ run: { delegatedTaskId: NodeId.make("real-follow-up") } } as never);
      },
      dispatch: () => Effect.succeed({} as never),
      confirmStop: () => Effect.void,
    });
    const result = { taskId, childThreadId: worker } as never;
    const orchestrationLayer = Layer.mock(Orchestration.OrchestratorMcpService)({
      delegateTask: (_scope, input) =>
        Effect.sync(() => {
          calls.push(input.task);
          return result;
        }),
      taskStatus: (_scope, id) => Effect.succeed({ taskId: id, childThreadId: worker } as never),
    });
    const teamLayer = Teamwork.layer.pipe(
      Layer.provide(
        Layer.succeed(ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
        }),
      ),
      Layer.provide(
        Layer.mock(CrewArtifacts)({
          inspect: () => Effect.succeed({ status: "available", detail: "Fixture artifact" }),
        }),
      ),
      Layer.provide(threadLayer),
      Layer.provide(
        Layer.mock(Projects.ProjectStoreV2)({
          get: () => Effect.succeedSome({ projectId } as never),
        }),
      ),
      Layer.provideMerge(Sqlite.layerMemory),
    );
    return Effect.gen(function* () {
      const teams = yield* Teamwork.TeamworkService;
      const mcp = yield* Mcp.TeamworkMcpService;
      const update = (action: TeamworkAction) =>
        Effect.gen(function* () {
          const revision = (yield* teams.read(projectId)).snapshot.revision;
          return yield* teams.mutate({
            projectId,
            commandId: CommandId.make(`setup-${revision}`),
            expectedRevision: revision,
            action,
          });
        });
      yield* update({ type: "coordinator.set", threadId: coordinator });
      yield* update({
        type: "initiative.create",
        id: "initiative",
        title: "Invite",
        brief: "Build expiring invitations",
        mode: "teamwork",
      });
      yield* update({
        type: "task.create",
        id: "task",
        initiativeId: "initiative",
        title: "API",
        brief: "Build API",
        criteria: "Expired invitations rejected",
        roleId: null,
        milestoneId: null,
        dependencies: [],
        knowledgeIds: [],
      });
      assert.isTrue(
        Result.isFailure(
          yield* Effect.result(mcp.delegate(scope, { taskId: "task", requestId: "one" })),
        ),
      );
      yield* update({ type: "initiative.approve", id: "initiative" });
      const first = yield* mcp.delegate(scope, { taskId: "task", requestId: "one" });
      const second = yield* mcp.delegate(
        { ...scope, requestNamespace: "turn-2" },
        { taskId: "task", requestId: "one" },
      );
      assert.equal(first.childThreadId, second.childThreadId);
      assert.equal(calls.length, 1);
      assert.include(calls[0]!, "Expired invitations rejected");
      const workerScope = { ...scope, thread: { ...scope.thread!, threadId: worker } };
      const running = yield* mcp.read(workerScope, { taskId: "task" });
      assert.equal(running.execution[0]?.state, "working");
      let state = running.snapshot;
      assert.equal(state.tasks[0]?.ownerThreadId, worker);
      yield* mcp.update(workerScope, {
        commandId: CommandId.make("report"),
        expectedRevision: state.revision,
        action: {
          type: "task.report",
          id: "task",
          status: "review",
          evidence: "Focused expiration tests pass",
          attemptId: "one",
          artifact: { kind: "commit", ref: "a".repeat(40) },
        },
      });
      workerStatus = "completed";
      const submitted = yield* mcp.read(workerScope, { taskId: "task" });
      assert.equal(submitted.execution[0]?.state, "finished");
      assert.equal(submitted.snapshot.tasks[0]?.status, "review");
      state = submitted.snapshot;
      assert.isTrue(
        Result.isFailure(
          yield* Effect.result(
            mcp.update(workerScope, {
              commandId: CommandId.make("self-review"),
              expectedRevision: state.revision,
              action: {
                type: "task.review",
                id: "task",
                decision: "approve",
                evidence: "I approve",
              },
            }),
          ),
        ),
      );
      yield* mcp.update(scope, {
        commandId: CommandId.make("review"),
        expectedRevision: state.revision,
        action: {
          type: "task.review",
          id: "task",
          decision: "approve",
          evidence: "Independently checked expiry and replay prevention",
          submissionRevision: state.tasks[0]!.submission!.revision,
        },
      });
      assert.equal((yield* mcp.read(scope, { taskId: "task" })).snapshot.tasks[0]?.status, "done");
      yield* update({
        type: "initiative.policy",
        id: "initiative",
        policy: { maxConcurrent: 1, maxAttempts: 3, maxSubmissions: 4 },
      });
      yield* update({
        type: "task.create",
        id: "next-task",
        initiativeId: "initiative",
        title: "Next",
        brief: "Next assignment",
        criteria: "Tested",
        roleId: null,
        milestoneId: null,
        dependencies: [],
        knowledgeIds: [],
      });
      workerStatus = "running";
      assert.isTrue(
        Result.isFailure(
          yield* Effect.result(
            update({ type: "task.reserve", id: "next-task", delegationId: "next" }),
          ),
        ),
      );
      workerStatus = "completed";
      yield* update({ type: "task.reserve", id: "next-task", delegationId: "next" });
      yield* teams.bindImplementationDestination(
        projectId,
        "next-task",
        "next",
        worker,
        coordinator,
      );
      assert.isTrue(
        Result.isFailure(
          yield* Effect.result(
            teams.bindImplementationDestination(projectId, "next-task", "next", null, coordinator),
          ),
        ),
      );
      const reusedWorker = yield* mcp.delegate(scope, {
        taskId: "next-task",
        requestId: "next",
        workstreamThreadId: worker,
      });
      assert.equal(reusedWorker.taskId, "real-follow-up");
      assert.equal(reusedWorker.childThreadId, worker);
      assert.equal(
        (yield* teams.read(projectId)).snapshot.tasks.find((t) => t.id === "next-task")
          ?.delegatedTaskId,
        "real-follow-up",
      );
      yield* mcp.delegate(
        { ...scope, requestNamespace: "later-turn" },
        { taskId: "next-task", requestId: "next", workstreamThreadId: worker },
      );
      assert.equal(reused.length, 1);
      assert.equal(calls.length, 1);
      yield* update({ type: "initiative.status", id: "initiative", status: "paused" });
      yield* teams.drain;
      yield* update({ type: "task.reset", id: "next-task", status: "cancelled" });
      assert.isTrue(yield* crewRetainsArtifacts([worker]));
      assert.isFalse(yield* crewRetainsArtifacts([coordinator]));
      yield* teams.drain;
      yield* update({ type: "initiative.status", id: "initiative", status: "active" });
      yield* teams.drain;
      yield* update({ type: "initiative.status", id: "initiative", status: "completed" });
      assert.isFalse(yield* crewRetainsArtifacts([worker]));
      yield* teams.drain;
      yield* update({ type: "initiative.archive", id: "initiative" });
      const archived = yield* mcp.read(scope, { archived: true, taskId: "task" });
      assert.equal(archived.snapshot.tasks[0]?.evidence, "Focused expiration tests pass");
      assert.equal(archived.snapshot.initiatives[0]?.status, "completed");
      assert.equal(archived.history?.archives?.[0]?.taskCount, 2);
      assert.equal(
        (yield* mcp.read(scope, { artifactTaskId: "task" })).artifact?.status,
        "available",
      );
      assert.equal((yield* mcp.read(scope, {})).snapshot.tasks.length, 0);
      const history = yield* mcp.read(scope, {
        history: true,
        taskId: "task",
        query: "expiration",
      });
      assert.equal(history.history?.events[0]?.kind, "task.report");
      assert.equal(history.history?.events[0]?.text, "Focused expiration tests pass");
    }).pipe(
      Effect.provide(
        Mcp.layer.pipe(
          Layer.provide(threadLayer),
          Layer.provide(orchestrationLayer),
          Layer.provideMerge(teamLayer),
        ),
      ),
    );
  },
);
