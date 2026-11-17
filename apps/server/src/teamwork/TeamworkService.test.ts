import { assert, it } from "@effect/vitest";
import {
  CommandId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type TeamworkAction,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Teamwork from "./TeamworkService.ts";
import * as CrewContext from "./CrewContextService.ts";
import { CrewArtifacts } from "./CrewArtifacts.ts";
import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";

const projectId = ProjectId.make("project-teamwork");
const coordinator = ThreadId.make("coordinator");
const dependencies = (
  deliver: (id: string) => Effect.Effect<void, Threads.ThreadManagementError>,
  mode: () => "full-access" | "approval-required" = () => "full-access",
  stop: () => Effect.Effect<void, Threads.ThreadManagementProviderInstanceDisabledError> = () =>
    Effect.void,
  status: () => "running" | "completed" = () => "completed",
  deleted: (id: ThreadId) => boolean = () => false,
) =>
  Layer.mergeAll(
    Layer.mock(CrewArtifacts)({
      inspect: () => Effect.succeed({ status: "available", detail: "Fixture artifact" }),
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () => Effect.succeedSome({ projectId } as never),
    }),
    Layer.mock(Threads.ThreadManagementService)({
      getShellSnapshot: () => Effect.succeed({ threads: [] } as never),
      getThreadShell: (id) =>
        deleted(id)
          ? Effect.succeed(null)
          : Effect.succeed({
              id,
              projectId: id === "other-project" ? ProjectId.make("other") : projectId,
              deletedAt: null,
              status: status(),
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
      dispatch: () => stop().pipe(Effect.as({} as never)),
    }),
  );

it.effect(
  "persists idempotent commands, rejects stale writers and keeps correction provenance",
  () =>
    Effect.gen(function* () {
      const teams = yield* Teamwork.TeamworkService;
      const contexts = yield* CrewContext.CrewContextService;
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
      const originalContext = yield* contexts.prepare({
        projectId,
        threadId: coordinator,
        query: "expiry",
        allowance: 8000,
      });
      assert.include(originalContext!.text, "24 hours");
      yield* contexts.record(projectId, RunId.make("first-run"), originalContext!);
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
      const corrected = yield* contexts.prepare({
        projectId,
        threadId: coordinator,
        query: "expiry",
        allowance: 8000,
      });
      assert.include(corrected!.text, "48 hours");
      assert.notInclude(corrected!.text, "24 hours");
      yield* update(3, "forget", { type: "knowledge.forget", id: "expiry" });
      assert.deepEqual((yield* teams.read(projectId)).snapshot.knowledge, []);
      assert.notInclude(
        (yield* contexts.prepare({
          projectId,
          threadId: coordinator,
          query: "expiry",
          allowance: 8000,
        }))!.text,
        "hours",
      );
      const delivered = yield* teams.history({ projectId, contextThreadId: coordinator });
      assert.equal(delivered.context?.runId, RunId.make("first-run"));
      assert.include(delivered.context!.packet.text, "24 hours");
      const events = (yield* teams.history({ projectId })).events;
      assert.equal(events.length, 4);
      assert.equal(events.filter((e) => e.action.type === "knowledge.save").length, 2);
      const wrongProject = yield* Effect.result(
        teams.read(projectId, ThreadId.make("other-project")),
      );
      assert.isTrue(Result.isFailure(wrongProject));
      yield* update(4, "decision", {
        type: "board.post",
        initiativeId: null,
        text: "The expiry endpoint uses server time.",
        recipients: [],
      });
      for (let i = 0; i < 61; i++)
        yield* update(5 + i, `discussion-${i}`, {
          type: "board.post",
          initiativeId: null,
          text: `Unrelated discussion ${i}`,
          recipients: [],
        });
      assert.isFalse(
        (yield* teams.read(projectId)).snapshot.board.some((b) => b.id === "decision"),
      );
      const recalled = yield* contexts.prepare({
        projectId,
        threadId: coordinator,
        query: "expiry",
        allowance: 8000,
      });
      assert.include(recalled!.text, "uses server time");
      assert.equal(recalled!.sources.find((s) => s.id === "decision")?.revision, 5);
    }).pipe(
      Effect.provide(
        Teamwork.layer.pipe(
          Layer.provide(dependencies(() => Effect.void)),
          Layer.provideMerge(CrewContext.layer),
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
    let stillRunning = false;
    let workerDeleted = false;
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
      yield* update({ type: "delivery.retry", id: stop.id });
      yield* teams.drain;
      stillRunning = true;
      assert.isTrue(
        Result.isFailure(
          yield* Effect.result(
            update({ type: "task.reserve", id: "task", delegationId: "too-early" }),
          ),
        ),
      );
      assert.isTrue(
        Result.isFailure(
          yield* Effect.result(
            update({ type: "coordinator.set", threadId: ThreadId.make("replacement-coordinator") }),
          ),
        ),
      );
      stillRunning = false;
      yield* update({ type: "task.reserve", id: "task", delegationId: "deleted-worker" });
      yield* update({
        type: "task.assign",
        id: "task",
        delegationId: "deleted-worker",
        threadId: ThreadId.make("worker"),
        delegatedTaskId: NodeId.make("deleted-worker"),
      });
      workerDeleted = true;
      yield* update({
        type: "board.post",
        initiativeId: "initiative",
        text: "A stale client still targets the deleted worker.",
        recipients: [ThreadId.make("worker")],
      });
      yield* teams.drain;
      assert.equal((yield* teams.read(projectId)).deliveries[0]?.status, "failed");
      yield* update({ type: "task.reset", id: "task", status: "ready" });
      yield* teams.drain;
      assert.equal((yield* teams.read(projectId)).deliveries[0]?.status, "delivered");
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
                  : Effect.void,
              () => (stillRunning ? "running" : "completed"),
              (id) => id === "worker" && workerDeleted,
            ),
          ),
          Layer.provideMerge(Sqlite.layerMemory),
        ),
      ),
    );
  },
);

it.effect(
  "archives beyond lifetime caps and restores paused work without losing evidence or cursors",
  () =>
    Effect.gen(function* () {
      const teams = yield* Teamwork.TeamworkService;
      const sql = yield* SqlClient.SqlClient;
      let revision = 0;
      const update = Effect.fn("test.archiveUpdate")(function* (action: TeamworkAction) {
        const result = yield* teams.mutate(
          {
            projectId,
            expectedRevision: revision,
            commandId: CommandId.make(`archive-${revision}`),
            action,
          },
          action.type === "coordinator.set" ? null : coordinator,
        );
        revision = result.snapshot.revision;
        return result;
      });
      yield* update({ type: "coordinator.set", threadId: coordinator });
      for (let i = 0; i < 101; i++) {
        const id = `initiative-${i}`;
        yield* update({
          type: "initiative.create",
          id,
          title: `Project ${i}`,
          brief: "Retain the reviewed work",
          mode: "swarm",
        });
        for (let j = 0; j < 4; j++) {
          yield* update({
            type: "task.create",
            id: `task-${i}-${j}`,
            initiativeId: id,
            title: "Preserved task",
            brief: "Historical task evidence",
            criteria: "Verified",
            roleId: null,
            milestoneId: null,
            dependencies: [],
            knowledgeIds: [],
          });
          yield* update({ type: "task.reset", id: `task-${i}-${j}`, status: "cancelled" });
        }
        if (i === 0)
          yield* update({
            type: "knowledge.save",
            id: "lesson",
            title: "Retained lesson",
            text: "Keep the evidence",
            sourceTaskId: "task-0-0",
          });
        yield* update({
          type: "board.post",
          initiativeId: id,
          text: "Historical decision",
          recipients: [],
        });
        yield* update({ type: "initiative.status", id, status: "cancelled" });
        yield* update({ type: "initiative.archive", id });
      }
      const current = yield* teams.read(projectId);
      assert.equal(current.snapshot.initiatives.length, 0);
      assert.equal(current.snapshot.tasks.length, 0);
      assert.equal(current.snapshot.board.length, 0);
      assert.equal(current.snapshot.knowledge[0]?.sourceTaskId, "task-0-0");
      const count = yield* sql<{
        count: number;
      }>`SELECT count(*) AS count FROM project_teamwork_task_ids WHERE project_id = ${projectId}`;
      assert.equal(count[0]?.count, 404);
      const first = yield* teams.history({ projectId, archived: true });
      assert.equal(first.archives?.length, 20);
      assert.isNotNull(first.nextBeforeRevision);
      yield* update({ type: "initiative.restore", id: "initiative-100" });
      yield* update({ type: "initiative.status", id: "initiative-100", status: "cancelled" });
      yield* update({ type: "initiative.archive", id: "initiative-100" });
      const second = yield* teams.history({
        projectId,
        archived: true,
        beforeRevision: first.nextBeforeRevision!,
      });
      assert.equal(second.archives?.length, 20);
      assert.isFalse(second.archives!.some((a) => first.archives!.some((b) => a.id === b.id)));
      const archiveIds = [...first.archives!, ...second.archives!].map((a) => a.id);
      let archiveCursor = second.nextBeforeRevision;
      while (archiveCursor != null) {
        const page = yield* teams.history({
          projectId,
          archived: true,
          beforeRevision: archiveCursor,
        });
        archiveIds.push(...page.archives!.map((a) => a.id));
        archiveCursor = page.nextBeforeRevision;
      }
      assert.equal(archiveIds.length, 101);
      assert.equal(new Set(archiveIds).size, 101);
      const discussionRevisions: number[] = [];
      let discussionCursor: number | undefined;
      do {
        const page = yield* teams.history({
          projectId,
          query: "Historical decision",
          ...(discussionCursor === undefined ? {} : { beforeRevision: discussionCursor }),
        });
        discussionRevisions.push(...page.events.map((e) => e.revision));
        discussionCursor = page.nextBeforeRevision ?? undefined;
      } while (discussionCursor !== undefined);
      assert.equal(discussionRevisions.length, 101);
      assert.equal(new Set(discussionRevisions).size, 101);
      const detail = yield* teams.history({
        projectId,
        archived: true,
        initiativeId: "initiative-0",
      });
      assert.equal(detail.archive?.tasks[0]?.brief, "Historical task evidence");
      const taskHistory = yield* teams.history({ projectId, taskId: "task-0-0" });
      assert.deepEqual(
        taskHistory.events.map((e) => e.action.type),
        ["task.reset", "task.create"],
      );
      const activity = yield* teams.history({
        projectId,
        initiativeId: "initiative-0",
        query: "Historical decision",
      });
      assert.equal(activity.events.length, 1);
      assert.equal(activity.events[0]?.action.type, "board.post");
      assert.isTrue(
        Result.isFailure(
          yield* Effect.result(
            update({
              type: "initiative.create",
              id: "initiative-0",
              title: "Duplicate",
              brief: "Invalid",
              mode: "swarm",
            }),
          ),
        ),
      );
      const restored = yield* update({ type: "initiative.restore", id: "initiative-0" });
      assert.equal(restored.snapshot.initiatives[0]?.status, "paused");
      assert.equal(restored.snapshot.tasks.length, 4);
      assert.isTrue(
        Result.isFailure(
          yield* Effect.result(
            update({
              type: "task.create",
              id: "task-1-0",
              initiativeId: "initiative-0",
              title: "Duplicate",
              brief: "Invalid",
              criteria: "Invalid",
              roleId: null,
              milestoneId: null,
              dependencies: [],
              knowledgeIds: [],
            }),
          ),
        ),
      );
      for (let i = 0; i < 99; i++)
        yield* update({
          type: "initiative.create",
          id: `active-${i}`,
          title: "Active",
          brief: "Work",
          mode: "swarm",
        });
      const full = yield* Effect.result(update({ type: "initiative.restore", id: "initiative-1" }));
      assert.isTrue(Result.isFailure(full));
      if (Result.isFailure(full)) assert.equal(full.failure.reason, "capacity");
      assert.isNotNull(
        (yield* teams.history({ projectId, archived: true, initiativeId: "initiative-1" })).archive,
      );
      yield* teams.drain;
      assert.equal((yield* teams.read(projectId)).deliveries.length, 0);
    }).pipe(
      Effect.provide(
        Teamwork.layer.pipe(
          Layer.provide(dependencies(() => Effect.void)),
          Layer.provideMerge(Sqlite.layerMemory),
        ),
      ),
    ),
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
