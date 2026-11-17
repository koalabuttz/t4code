import { assert, it } from "@effect/vitest";
import {
  CommandId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type TeamworkAction,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Teamwork from "./TeamworkService.ts";
import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import { StopConfirmationError } from "../orchestration-v2/StopConfirmation.ts";

const projectId = ProjectId.make("project-teamwork");
const coordinator = ThreadId.make("coordinator");
const dependencies = (
  deliver: (id: string) => Effect.Effect<void, Threads.ThreadManagementError>,
  mode: () => "full-access" | "approval-required" = () => "full-access",
  stop: () => Effect.Effect<void, Threads.ThreadManagementProviderInstanceDisabledError> = () =>
    Effect.void,
) =>
  Layer.mergeAll(
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () => Effect.succeedSome({ projectId } as never),
    }),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed({
          id,
          projectId: id === "other-project" ? ProjectId.make("other") : projectId,
          deletedAt: null,
          creationSource: "mcp",
          lineage: {
            parentThreadId: id === coordinator ? null : coordinator,
            relationshipToParent: id === coordinator ? null : "subagent",
            rootThreadId: coordinator,
          },
          runtimeMode: mode(),
          interactionMode: "default",
        } as never),
      sendToThread: (input) => deliver(input.commandId).pipe(Effect.as({} as never)),
      dispatch: () => Effect.succeed({} as never),
      confirmStop: () =>
        stop().pipe(
          Effect.mapError(
            (cause) =>
              new StopConfirmationError({
                threadId: coordinator,
                reason: "fixture work still running",
                cause,
              }),
          ),
        ),
    }),
  );

it.effect(
  "persists idempotent commands, rejects stale writers and keeps correction provenance",
  () =>
    Effect.gen(function* () {
      const teams = yield* Teamwork.TeamworkService;
      const update = (revision: number, command: string, action: TeamworkAction) =>
        teams.mutate({
          projectId,
          expectedRevision: revision,
          commandId: CommandId.make(command),
          action,
        });
      yield* update(0, "adopt", { type: "coordinator.set", threadId: coordinator });
      yield* update(1, "remember", {
        type: "knowledge.save",
        id: "expiry",
        title: "Expiry",
        text: "Invitations expire after 24 hours",
        sourceTaskId: null,
      });
      const replay = yield* update(1, "remember", {
        type: "knowledge.save",
        id: "expiry",
        title: "Expiry",
        text: "Invitations expire after 24 hours",
        sourceTaskId: null,
      });
      assert.equal(replay.snapshot.revision, 2);
      const stale = yield* Effect.result(
        update(1, "stale", { type: "knowledge.forget", id: "expiry" }),
      );
      assert.isTrue(Result.isFailure(stale));
      if (Result.isFailure(stale)) assert.equal(stale.failure.reason, "conflict");
      yield* update(2, "correct", {
        type: "knowledge.save",
        id: "expiry",
        title: "Expiry",
        text: "Invitations expire after 48 hours",
        sourceTaskId: null,
      });
      yield* update(3, "forget", { type: "knowledge.forget", id: "expiry" });
      assert.deepEqual((yield* teams.read(projectId)).snapshot.knowledge, []);
      const events = (yield* teams.history({ projectId })).events;
      assert.equal(events.length, 4);
      assert.equal(events.filter((e) => e.action.type === "knowledge.save").length, 2);
      const wrongProject = yield* Effect.result(
        teams.read(projectId, ThreadId.make("other-project")),
      );
      assert.isTrue(Result.isFailure(wrongProject));
    }).pipe(
      Effect.provide(
        Teamwork.layer.pipe(
          Layer.provide(dependencies(() => Effect.void)),
          Layer.provide(Sqlite.layerMemory),
        ),
      ),
    ),
);

it.effect("recovers pending work on service restart with the same dispatch id", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const delivered: string[] = [];
    const first = Teamwork.layer.pipe(
      Layer.provide(
        dependencies((id) =>
          Effect.sync(() => {
            delivered.push(id);
          }),
        ),
      ),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const teams = yield* Teamwork.TeamworkService;
        yield* teams.mutate({
          projectId,
          commandId: CommandId.make("adopt"),
          expectedRevision: 0,
          action: { type: "coordinator.set", threadId: coordinator },
        });
        yield* teams.mutate({
          projectId,
          commandId: CommandId.make("start"),
          expectedRevision: 1,
          action: {
            type: "initiative.create",
            id: "initiative",
            title: "Invite",
            brief: "Build invitations",
            mode: "swarm",
          },
        });
        yield* teams.drain;
        assert.equal(delivered.length, 1);
      }).pipe(Effect.provide(first)),
    );
    // Simulate a crash after dispatch committed but before the outbox acknowledgement.
    yield* sql`UPDATE project_teamwork_outbox SET status = 'pending'`;
    const second = Teamwork.layer.pipe(
      Layer.provide(
        dependencies((id) =>
          Effect.sync(() => {
            delivered.push(id);
          }),
        ),
      ),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const teams = yield* Teamwork.TeamworkService;
        yield* teams.drain;
        assert.equal((yield* teams.read(projectId)).snapshot.initiatives[0]?.title, "Invite");
        assert.equal(delivered.length, 2);
        assert.equal(delivered[0], delivered[1]);
        assert.equal((yield* teams.read(projectId)).deliveries[0]?.status, "delivered");
      }).pipe(Effect.provide(second)),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect(
  "waits for the previous worker's stop before reserving a replacement or changing coordinator",
  () => {
    let stopFails = true;
    let confirmation = Effect.void;
    return Effect.gen(function* () {
      const teams = yield* Teamwork.TeamworkService;
      const sql = yield* SqlClient.SqlClient;
      const update = Effect.fn("test.updateCrew")(function* (action: TeamworkAction) {
        const { snapshot } = yield* teams.read(projectId);
        return yield* teams.mutate({
          projectId,
          commandId: CommandId.make(`change-${snapshot.revision}`),
          expectedRevision: snapshot.revision,
          action,
        });
      });
      yield* update({ type: "coordinator.set", threadId: coordinator });
      yield* update({
        type: "initiative.create",
        id: "initiative",
        title: "Build",
        brief: "Build the API",
        mode: "swarm",
      });
      yield* update({
        type: "task.create",
        id: "task",
        initiativeId: "initiative",
        title: "API",
        brief: "Build API",
        criteria: "Tests pass",
        roleId: null,
        milestoneId: null,
        dependencies: [],
        knowledgeIds: [],
      });
      yield* update({ type: "task.reserve", id: "task", delegationId: "first" });
      yield* update({
        type: "task.assign",
        id: "task",
        delegationId: "first",
        threadId: ThreadId.make("worker"),
        delegatedTaskId: NodeId.make("first"),
      });
      yield* update({ type: "task.reset", id: "task", status: "ready" });
      yield* teams.drain;
      const stop = (yield* teams.read(projectId)).deliveries.find(
        (delivery) => delivery.kind === "stop",
      )!;
      assert.equal(stop.status, "failed");
      yield* update({
        type: "task.create",
        id: "parallel",
        initiativeId: "initiative",
        title: "Independent work",
        brief: "Build another endpoint",
        criteria: "Tests pass",
        roleId: null,
        milestoneId: null,
        dependencies: [],
        knowledgeIds: [],
      });
      yield* update({ type: "task.reserve", id: "parallel", delegationId: "parallel" });
      yield* update({ type: "task.reset", id: "parallel", status: "cancelled" });
      for (const status of ["failed", "pending"] as const) {
        yield* sql`UPDATE project_teamwork_outbox SET status = ${status} WHERE id = ${stop.id}`;
        for (const action of [
          { type: "task.reserve", id: "task", delegationId: "replacement" },
          { type: "coordinator.set", threadId: ThreadId.make("replacement-coordinator") },
        ] as const) {
          const result = yield* Effect.result(update(action));
          assert.isTrue(Result.isFailure(result));
          if (Result.isFailure(result)) assert.equal(result.failure.reason, "invalid-state");
        }
      }
      yield* sql`UPDATE project_teamwork_outbox SET payload_json = json_remove(payload_json, '$.taskId') WHERE id = ${stop.id}`;
      assert.isTrue(
        Result.isFailure(
          yield* Effect.result(
            update({ type: "task.reserve", id: "task", delegationId: "legacy-stop" }),
          ),
        ),
      );
      yield* sql`UPDATE project_teamwork_outbox SET status = 'failed' WHERE id = ${stop.id}`;
      stopFails = false;
      const awaitingStop = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      confirmation = Deferred.succeed(awaitingStop, undefined).pipe(
        Effect.andThen(Deferred.await(stopped)),
      );
      yield* update({ type: "delivery.retry", id: stop.id });
      yield* Deferred.await(awaitingStop);
      assert.equal(
        (yield* teams.read(projectId)).deliveries.find((row) => row.id === stop.id)?.status,
        "pending",
      );
      assert.isTrue(
        Result.isFailure(
          yield* Effect.result(
            update({ type: "task.reserve", id: "task", delegationId: "too-early" }),
          ),
        ),
      );
      yield* update({
        type: "knowledge.save",
        id: "during-stop",
        title: "Keep UI responsive",
        text: "Unrelated changes are allowed while a provider stops.",
        sourceTaskId: null,
      });
      yield* Deferred.succeed(stopped, undefined);
      yield* teams.drain;
      yield* update({
        type: "coordinator.set",
        threadId: ThreadId.make("replacement-coordinator"),
      });
      assert.isFalse(
        (yield* teams.read(projectId)).deliveries.some(
          (delivery) =>
            delivery.kind === "message" &&
            delivery.threadId === coordinator &&
            ["pending", "failed"].includes(delivery.status),
        ),
      );
      const result = yield* update({
        type: "task.reserve",
        id: "task",
        delegationId: "replacement",
      });
      assert.equal(result.snapshot.tasks[0]?.delegationId, "replacement");
    }).pipe(
      Effect.provide(
        Teamwork.layer.pipe(
          Layer.provide(
            dependencies(
              () =>
                Effect.fail(
                  new Threads.ThreadManagementThreadNotFoundError({
                    projectId,
                    threadId: coordinator,
                  }),
                ),
              () => "full-access",
              () =>
                stopFails
                  ? Effect.fail(
                      new Threads.ThreadManagementProviderInstanceDisabledError({
                        projectId,
                        instanceId: ProviderInstanceId.make("codex"),
                      }),
                    )
                  : confirmation,
            ),
          ),
          Layer.provideMerge(Sqlite.layerMemory),
        ),
      ),
    );
  },
);

it.effect(
  "rechecks the sender's ceiling on retry and cancels failed notifications when paused",
  () => {
    let runtimeMode: "full-access" | "approval-required" = "full-access";
    let fail = true;
    const limits: (string | undefined)[] = [];
    return Effect.gen(function* () {
      const teams = yield* Teamwork.TeamworkService;
      let revision = 0;
      const update = (action: TeamworkAction, actor: ThreadId | null = null) =>
        teams.mutate(
          {
            projectId,
            commandId: CommandId.make(`action-${revision}`),
            expectedRevision: revision++,
            action,
          },
          actor,
        );
      yield* update({ type: "coordinator.set", threadId: coordinator });
      yield* update({
        type: "initiative.create",
        id: "initiative",
        title: "Plan",
        brief: "Plan an invitation system",
        mode: "teamwork",
      });
      yield* teams.drain;
      assert.equal((yield* teams.read(projectId)).deliveries[0]?.status, "failed");
      fail = false;
      yield* update({ type: "initiative.approve", id: "initiative" });
      yield* teams.drain;
      const worker = ThreadId.make("worker");
      yield* update({
        type: "task.create",
        id: "task",
        initiativeId: "initiative",
        title: "Build",
        brief: "Build invitations",
        criteria: "Expired tokens rejected",
        roleId: null,
        milestoneId: null,
        knowledgeIds: [],
        dependencies: [],
      });
      yield* update({ type: "task.reserve", id: "task", delegationId: "reservation" }, coordinator);
      yield* update(
        {
          type: "task.assign",
          id: "task",
          delegationId: "reservation",
          threadId: worker,
          delegatedTaskId: NodeId.make("delegation"),
        },
        coordinator,
      );
      fail = true;
      yield* update(
        {
          type: "board.post",
          initiativeId: "initiative",
          text: "Review the plan",
          recipients: [coordinator],
        },
        worker,
      );
      yield* teams.drain;
      const failedId = (yield* teams.read(projectId)).deliveries.find(
        (d) => d.status === "failed",
      )!.id;
      runtimeMode = "approval-required";
      fail = false;
      yield* update({ type: "delivery.retry", id: failedId });
      yield* teams.drain;
      assert.equal(limits.at(-1), "approval-required");
      fail = true;
      yield* update({
        type: "board.post",
        initiativeId: "initiative",
        text: "Pending question",
        recipients: [coordinator],
      });
      yield* teams.drain;
      fail = false;
      yield* update({ type: "initiative.status", id: "initiative", status: "paused" });
      yield* teams.drain;
      assert.isFalse((yield* teams.read(projectId)).deliveries.some((d) => d.status === "failed"));
      assert.isTrue(
        (yield* teams.read(projectId)).deliveries.some((d) => d.status === "cancelled"),
      );
    }).pipe(
      Effect.provide(
        Teamwork.layer.pipe(
          Layer.provide(
            dependencies(
              () =>
                Effect.gen(function* () {
                  limits.push((yield* DispatchModeLimit)?.runtimeMode);
                  if (fail)
                    return yield* new Threads.ThreadManagementThreadNotFoundError({
                      projectId,
                      threadId: coordinator,
                    });
                }),
              () => runtimeMode,
            ),
          ),
          Layer.provideMerge(Sqlite.layerMemory),
        ),
      ),
    );
  },
);
