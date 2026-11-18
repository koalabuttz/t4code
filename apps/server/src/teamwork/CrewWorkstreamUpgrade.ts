import {
  TeamworkArchive,
  TeamworkError,
  TeamworkSnapshot,
  type TeamworkTask,
  type ThreadId,
} from "@t3tools/contracts";
import { CrewWorkstream, CrewWorkstreamTaskLink } from "@t3tools/contracts/crewConversation";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";

const decodeState = Schema.decodeEffect(Schema.fromJsonString(TeamworkSnapshot));
const decodeArchive = Schema.decodeEffect(Schema.fromJsonString(TeamworkArchive));
const decodeWorkstream = Schema.decodeEffect(Schema.fromJsonString(CrewWorkstream));
const encodeWorkstream = Schema.encodeEffect(Schema.fromJsonString(CrewWorkstream));
const encodeLink = Schema.encodeEffect(Schema.fromJsonString(CrewWorkstreamTaskLink));

export const reconcileLegacyCrewWorkstreams = Effect.fn("CrewWorkstreamUpgrade.reconcile")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const threads = yield* Threads.ThreadManagementService;
    const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
    const projects = yield* sql<{ project_id: string }>`SELECT project_id FROM project_teamwork`;
    for (const { project_id: projectId } of projects) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          // A deleted task link is an explicit choice; subsequent startups must not recreate it.
          const adopted =
            yield* sql`SELECT id FROM project_crew_conversations WHERE project_id = ${projectId}
          AND collection = 'upgrades' AND id = 'legacy-workstreams-v1'`;
          if (adopted.length) return;
          const rows = yield* sql<{
            payload_json: string;
          }>`SELECT payload_json FROM project_teamwork WHERE project_id = ${projectId}`;
          if (!rows[0]) return;
          const state = yield* decodeState(rows[0].payload_json);
          if (state.projectId !== projectId) return;
          const tasks: Array<TeamworkTask> = [...state.tasks];
          const archives = yield* sql<{
            payload_json: string;
          }>`SELECT payload_json FROM project_teamwork_archive WHERE project_id = ${projectId} ORDER BY initiative_id`;
          for (const archive of archives)
            tasks.push(...(yield* decodeArchive(archive.payload_json)).tasks);
          const detached = yield* sql<{
            task_id: string;
          }>`SELECT json_extract(json_extract(action_json, '$.command'), '$.action.taskId') AS task_id
          FROM project_teamwork_events WHERE project_id = ${projectId}
          AND json_extract(action_json, '$.type') = 'crew.conversation'
          AND json_extract(json_extract(action_json, '$.command'), '$.action.type') = 'workstream.task'
          AND json_type(json_extract(action_json, '$.command'), '$.action.threadId') = 'null'`;
          const detachedTasks = new Set(detached.map((row) => row.task_id));
          const existingLinks = yield* sql<{
            id: string;
          }>`SELECT id FROM project_crew_conversations WHERE project_id = ${projectId} AND collection = 'task-links'`;
          const linkedTasks = new Set(existingLinks.map((row) => row.id));
          const owners = new Map<ThreadId, Array<TeamworkTask>>();
          for (const task of tasks) {
            const owner = task.ownerThreadId;
            if (
              owner === null ||
              owner === state.coordinatorThreadId ||
              linkedTasks.has(task.id) ||
              detachedTasks.has(task.id)
            )
              continue;
            const owned = owners.get(owner) ?? [];
            owned.push(task);
            owners.set(owner, owned);
          }
          const now = DateTime.formatIso(yield* DateTime.now);
          for (const [owner, owned] of owners) {
            const first = owned[0]!;
            const thread = yield* threads.getThreadShell(owner);
            if (
              !thread ||
              thread.id !== owner ||
              thread.projectId !== projectId ||
              thread.deletedAt !== null ||
              thread.creationSource === "provider" ||
              thread.linkOrigin != null ||
              thread.delegatedFrom != null
            )
              continue;
            const existing = yield* sql<{
              payload_json: string;
            }>`SELECT payload_json FROM project_crew_conversations
            WHERE project_id = ${projectId} AND collection = 'workstreams' AND id = ${owner}`;
            const member = existing[0] ? yield* decodeWorkstream(existing[0].payload_json) : null;
            if (
              member &&
              (member.status === "unlinked" ||
                member.conversation.environmentId !== environmentId ||
                member.conversation.projectId !== projectId ||
                member.conversation.threadId !== owner)
            )
              continue;
            const conversation = { environmentId, projectId: state.projectId, threadId: owner };
            if (member === null) {
              const payload = yield* encodeWorkstream({
                conversation,
                title: first.title.slice(0, 160),
                status: owned.every((task) => task.status === "done" || task.status === "cancelled")
                  ? "resolved"
                  : "open",
                // Old cursor backlog must not turn historical worker messages into new coordinator attention.
                linkedAt: now,
                updatedAt: now,
              });
              yield* sql`INSERT INTO project_crew_conversations VALUES (${projectId}, 'workstreams', ${owner}, ${owner}, ${payload}) ON CONFLICT DO NOTHING`;
            }
            for (const task of owned) {
              const payload = yield* encodeLink({
                workstream: conversation,
                initiativeId: task.initiativeId,
                taskId: task.id,
              });
              yield* sql`INSERT INTO project_crew_conversations VALUES (${projectId}, 'task-links', ${task.id}, ${owner}, ${payload}) ON CONFLICT DO NOTHING`;
            }
          }
          yield* sql`INSERT INTO project_crew_conversations VALUES (${projectId}, 'upgrades', 'legacy-workstreams-v1', '', '{}') ON CONFLICT DO NOTHING`;
        }),
      );
    }
  },
  Effect.mapError(
    () =>
      new TeamworkError({
        reason: "storage",
        message: "Could not retain existing Crew workstreams.",
      }),
  ),
);
