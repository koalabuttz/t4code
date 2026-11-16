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
import * as Result from "effect/Result";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Orchestration from "../mcp/OrchestratorMcpService.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Teamwork from "./TeamworkService.ts";
import * as Mcp from "./TeamworkMcpService.ts";

it.effect(
  "reserves one worker across retries and enforces owner reports and independent review",
  () => {
    const projectId = ProjectId.make("project");
    const coordinator = ThreadId.make("coordinator");
    const worker = ThreadId.make("worker");
    const taskId = NodeId.make("native-task");
    const calls: string[] = [];
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
      getThreadShell: (id) =>
        Effect.succeed({
          id,
          projectId,
          deletedAt: null,
          lineage: {
            parentThreadId: id === coordinator ? null : coordinator,
            relationshipToParent: id === coordinator ? null : "subagent",
            rootThreadId: coordinator,
          },
          runtimeMode: "full-access",
          interactionMode: "default",
        } as never),
      sendToThread: () => Effect.succeed({} as never),
      dispatch: () => Effect.succeed({} as never),
    });
    const result = { taskId, childThreadId: worker } as never;
    const orchestrationLayer = Layer.mock(Orchestration.OrchestratorMcpService)({
      delegateTask: (_scope, input) =>
        Effect.sync(() => {
          calls.push(input.task);
          return result;
        }),
      taskStatus: () => Effect.succeed(result),
    });
    const teamLayer = Teamwork.layer.pipe(
      Layer.provide(threadLayer),
      Layer.provide(
        Layer.mock(Projects.ProjectStoreV2)({
          get: () => Effect.succeedSome({ projectId } as never),
        }),
      ),
      Layer.provide(Sqlite.layerMemory),
    );
    return Effect.gen(function* () {
      const teams = yield* Teamwork.TeamworkService;
      const mcp = yield* Mcp.TeamworkMcpService;
      let revision = 0;
      const update = (action: TeamworkAction) =>
        teams.mutate({
          projectId,
          commandId: CommandId.make(`setup-${revision}`),
          expectedRevision: revision++,
          action,
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
      let state = (yield* mcp.read(workerScope, { taskId: "task" })).snapshot;
      assert.equal(state.tasks[0]?.ownerThreadId, worker);
      yield* mcp.update(workerScope, {
        commandId: CommandId.make("report"),
        expectedRevision: state.revision,
        action: {
          type: "task.report",
          id: "task",
          status: "review",
          evidence: "Focused expiration tests pass",
        },
      });
      state = (yield* mcp.read(workerScope, { taskId: "task" })).snapshot;
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
        },
      });
      assert.equal((yield* mcp.read(scope, { taskId: "task" })).snapshot.tasks[0]?.status, "done");
      yield* teams.drain;
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
