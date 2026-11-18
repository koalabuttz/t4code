import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  RunId,
  TeamworkSnapshot,
  ThreadId,
  type TeamworkTask,
  type TeamworkInitiative,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { CrewArtifacts } from "./CrewArtifacts.ts";
import * as Teamwork from "./TeamworkService.ts";
import { emptyTeamwork } from "./decide.ts";

const projectId = ProjectId.make("upgrade-project");
const otherProject = ProjectId.make("other-project");
const environmentId = EnvironmentId.make("canonical-server-environment");
const coordinator = ThreadId.make("original-coordinator");
const scope = { projectId, environmentId };
const oldTime = "1969-12-31T00:00:00.000Z";
const encodeState = Schema.encodeEffect(Schema.fromJsonString(TeamworkSnapshot));
const initiative = (id: string, status: TeamworkInitiative["status"]): TeamworkInitiative => ({
  id,
  title: id,
  brief: id,
  status,
  mode: "swarm",
  approved: true,
  milestones: [],
  createdAt: oldTime,
  updatedAt: oldTime,
});
const task = (
  id: string,
  initiativeId = "active",
  status: TeamworkTask["status"] = "running",
): TeamworkTask => ({
  id,
  initiativeId,
  title: id,
  brief: id,
  criteria: id,
  status,
  ownerThreadId: ThreadId.make(id),
  delegatedTaskId: NodeId.make(`delegated-${id}`),
  delegationId: `attempt-${id}`,
  roleId: null,
  milestoneId: null,
  dependencies: [],
  knowledgeIds: [],
  evidence: "",
  review: null,
  createdAt: oldTime,
  updatedAt: oldTime,
});

it.effect("adopts legacy task owners once without resuming work or replaying history", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const done = {
      ...task("done", "completed", "done"),
      submission: {
        revision: 12,
        attemptId: "attempt-done",
        artifact: { kind: "commit" as const, ref: "a".repeat(40) },
        evidence: "Exact historical artifact",
        threadId: ThreadId.make("done"),
        createdAt: oldTime,
      },
      review: {
        decision: "approve" as const,
        submissionRevision: 12,
        evidence: "Independent review",
        threadId: coordinator,
      },
    };
    const state: TeamworkSnapshot = {
      ...emptyTeamwork(projectId),
      revision: 42,
      coordinatorThreadId: coordinator,
      initiatives: [
        initiative("active", "active"),
        initiative("paused", "paused"),
        initiative("completed", "completed"),
      ],
      tasks: [
        task("active-worker"),
        task("paused-worker", "paused"),
        done,
        task("unlinked"),
        task("resolved-member"),
        task("manually-detached"),
        task("regrouped"),
        task("provider"),
        task("native"),
        task("linked"),
        task("remote-delegated"),
        task("missing"),
        task("deleted"),
        task("cross-project"),
        task("identity-mismatch"),
        task(coordinator),
        {
          ...task("shared-completed", "completed", "done"),
          ownerThreadId: ThreadId.make("active-worker"),
        },
      ],
    };
    const encoded = yield* encodeState(state);
    yield* sql`INSERT INTO project_teamwork VALUES (${projectId}, 42, ${encoded})`;
    const other = yield* encodeState({
      ...emptyTeamwork(otherProject),
      revision: 1,
      tasks: [task("active-worker")],
      initiatives: [initiative("active", "active")],
    });
    yield* sql`INSERT INTO project_teamwork VALUES (${otherProject}, 1, ${other})`;
    const archived = JSON.stringify({
      initiative: initiative("archived", "completed"),
      tasks: [task("archived-worker", "archived", "done")],
    });
    yield* sql`INSERT INTO project_teamwork_archive VALUES (${projectId}, 'archived', 40, ${oldTime}, 'Archived', 'completed', 1, ${archived})`;
    const unlinked = JSON.stringify({
      conversation: { ...scope, threadId: "unlinked" },
      title: "Explicitly unlinked",
      status: "unlinked",
      linkedAt: oldTime,
      updatedAt: oldTime,
    });
    yield* sql`INSERT INTO project_crew_conversations VALUES (${projectId}, 'workstreams', 'unlinked', 'unlinked', ${unlinked})`;
    const resolved = JSON.stringify({
      conversation: { ...scope, threadId: "resolved-member" },
      title: "Manually resolved",
      status: "resolved",
      linkedAt: oldTime,
      updatedAt: oldTime,
    });
    yield* sql`INSERT INTO project_crew_conversations VALUES (${projectId}, 'workstreams', 'resolved-member', 'resolved-member', ${resolved})`;
    const regrouped = JSON.stringify({
      workstream: { ...scope, threadId: "stable-workstream" },
      initiativeId: "active",
      taskId: "regrouped",
    });
    yield* sql`INSERT INTO project_crew_conversations VALUES (${projectId}, 'task-links', 'regrouped', 'stable-workstream', ${regrouped})`;
    const removal = JSON.stringify({
      type: "crew.conversation",
      command: JSON.stringify({
        action: { type: "workstream.task", taskId: "manually-detached", threadId: null },
      }),
    });
    yield* sql`INSERT INTO project_teamwork_events VALUES (${projectId}, 42, 'explicit-detach', NULL, ${removal}, ${oldTime})`;
    const historyBefore = yield* sql`SELECT * FROM project_teamwork_events`;
    const archiveBefore = yield* sql`SELECT * FROM project_teamwork_archive`;
    const cursorBefore = yield* sql`SELECT * FROM project_crew_event_cursor`;
    let sends = 0;
    const external = Layer.mergeAll(
      Layer.succeed(ServerEnvironmentIdentity, { getEnvironmentId: Effect.succeed(environmentId) }),
      Layer.mock(CrewArtifacts)({
        inspect: () => Effect.succeed({ status: "available", detail: "Fixture" }),
      }),
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: () => Effect.succeedSome({ projectId } as never),
      }),
      Layer.mock(Threads.ThreadManagementService)({
        streamStoredEventsFrom: () => Stream.empty,
        getThreadShell: (id) =>
          Effect.succeed(
            id === "missing"
              ? null
              : ({
                  id: id === "identity-mismatch" ? ThreadId.make("different-identity") : id,
                  projectId: id === "cross-project" ? otherProject : projectId,
                  title: `Original ${id}`,
                  deletedAt: id === "deleted" ? DateTime.makeUnsafe(0) : null,
                  status: id === coordinator || id === "active-worker" ? "running" : "completed",
                  creationSource: id === "provider" || id === "native" ? "provider" : "mcp",
                  lineage: {
                    parentThreadId: coordinator,
                    relationshipToParent: id === "provider" ? null : "subagent",
                    rootThreadId: coordinator,
                  },
                  linkOrigin: id === "linked" ? { access: "full-access" } : null,
                  delegatedFrom: id === "remote-delegated" ? { environmentId: "remote" } : null,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                } as never),
          ),
        sendToThread: () =>
          Effect.sync(() => {
            sends++;
            return {} as never;
          }),
      }),
    );
    const start = () => Teamwork.layer.pipe(Layer.provide(external));
    yield* Effect.scoped(
      Effect.gen(function* () {
        const teams = yield* Teamwork.TeamworkService;
        const page = yield* teams.conversationQuery({ scope, collection: "workstreams" });
        assert.deepEqual(
          page.workstreams.map((w) => [w.conversation.threadId, w.status]),
          [
            ["active-worker", "open"],
            ["archived-worker", "resolved"],
            ["done", "resolved"],
            ["paused-worker", "open"],
            ["resolved-member", "resolved"],
            ["unlinked", "unlinked"],
          ],
        );
        assert.isTrue(
          page.workstreams.every((w) => w.conversation.environmentId === environmentId),
        );
        const links = yield* teams.conversationQuery({ scope, collection: "task-links" });
        assert.deepEqual(
          links.taskLinks.map((link) => link.taskId),
          [
            "active-worker",
            "archived-worker",
            "done",
            "paused-worker",
            "regrouped",
            "resolved-member",
            "shared-completed",
          ],
        );
        assert.deepEqual(yield* sql`SELECT * FROM project_teamwork_events`, historyBefore);
        assert.deepEqual(yield* sql`SELECT * FROM project_teamwork_archive`, archiveBefore);
        assert.deepEqual(yield* sql`SELECT * FROM project_crew_event_cursor`, cursorBefore);
        assert.equal(
          (yield* sql<{
            payload_json: string;
          }>`SELECT payload_json FROM project_teamwork WHERE project_id = ${projectId}`)[0]
            ?.payload_json,
          encoded,
        );
        assert.equal(
          (yield* sql<{
            payload_json: string;
          }>`SELECT payload_json FROM project_crew_conversations WHERE collection = 'workstreams' AND id = 'unlinked'`)[0]
            ?.payload_json,
          unlinked,
        );
        assert.equal(
          (yield* sql<{
            payload_json: string;
          }>`SELECT payload_json FROM project_crew_conversations WHERE collection = 'task-links' AND id = 'regrouped'`)[0]
            ?.payload_json,
          regrouped,
        );
        assert.equal(
          (yield* sql<{
            payload_json: string;
          }>`SELECT payload_json FROM project_crew_conversations WHERE collection = 'workstreams' AND id = 'resolved-member'`)[0]
            ?.payload_json,
          resolved,
        );
        assert.isEmpty(
          yield* sql`SELECT * FROM project_crew_conversations WHERE project_id = ${otherProject} AND collection IN ('workstreams', 'task-links')`,
        );
        assert.isEmpty(yield* sql`SELECT * FROM project_teamwork_outbox`);
        yield* teams.drain;
        assert.equal(sends, 0);
      }).pipe(Effect.provide(start())),
    );
    const firstRows =
      yield* sql`SELECT * FROM project_crew_conversations ORDER BY project_id, collection, id`;
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Teamwork.TeamworkService;
        assert.deepEqual(
          yield* sql`SELECT * FROM project_crew_conversations ORDER BY project_id, collection, id`,
          firstRows,
        );
      }).pipe(Effect.provide(start())),
    );
    yield* sql`DELETE FROM project_crew_conversations WHERE project_id = ${projectId} AND collection = 'task-links' AND id = 'active-worker'`;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const teams = yield* Teamwork.TeamworkService;
        assert.isEmpty(
          (yield* teams.conversationQuery({ scope, collection: "task-links", id: "active-worker" }))
            .taskLinks,
        );
        const now = yield* DateTime.now;
        const event = (sequence: number, occurredAt: DateTime.Utc): OrchestrationV2StoredEvent => ({
          sequence,
          commandId: null,
          event: {
            id: EventId.make(`direct-event-${sequence}`),
            type: "message.updated",
            threadId: ThreadId.make("active-worker"),
            runId: RunId.make("direct-run"),
            occurredAt,
            payload: {
              id: MessageId.make(`direct-${sequence}`),
              threadId: ThreadId.make("active-worker"),
              runId: RunId.make("direct-run"),
              role: "user",
              createdBy: "user",
              creationSource: "web",
              text: "A new direct request",
              streaming: false,
              attachments: [],
              nodeId: null,
              createdAt: occurredAt,
              updatedAt: occurredAt,
            },
          },
        });
        yield* teams.observeConversationEvent(event(1, DateTime.makeUnsafe(oldTime)));
        assert.isEmpty(
          (yield* teams.conversationQuery({ scope, collection: "attention" })).attention,
        );
        yield* teams.observeConversationEvent(event(2, now));
        yield* teams.observeConversationEvent(event(2, now));
        const attention = (yield* teams.conversationQuery({ scope, collection: "attention" }))
          .attention;
        assert.equal(attention.length, 1);
        assert.equal(attention[0]?.source.conversation.threadId, "active-worker");
        assert.equal(attention[0]?.coordinator.threadId, coordinator);
        assert.equal(attention[0]?.source.conversation.environmentId, environmentId);
      }).pipe(Effect.provide(start())),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);
