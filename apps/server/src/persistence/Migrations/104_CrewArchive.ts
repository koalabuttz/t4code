import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX project_teamwork_discussions ON project_teamwork_events(project_id, revision DESC) WHERE json_extract(action_json, '$.type') = 'board.post'`;
  yield* sql`CREATE TABLE project_teamwork_archive (
    project_id TEXT NOT NULL, initiative_id TEXT NOT NULL, revision INTEGER NOT NULL,
    archived_at TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
    task_count INTEGER NOT NULL, payload_json TEXT NOT NULL,
    PRIMARY KEY (project_id, initiative_id)
  )`;
  yield* sql`CREATE INDEX project_teamwork_archive_page ON project_teamwork_archive(project_id, revision DESC)`;
  yield* sql`CREATE TABLE project_teamwork_context (
    project_id TEXT NOT NULL, thread_id TEXT PRIMARY KEY, run_id TEXT NOT NULL,
    delivered_at TEXT NOT NULL, payload_json TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE project_teamwork_task_ids (
    project_id TEXT NOT NULL, task_id TEXT NOT NULL, initiative_id TEXT NOT NULL,
    PRIMARY KEY (project_id, task_id)
  )`;
  yield* sql`INSERT INTO project_teamwork_task_ids (project_id, task_id, initiative_id)
    SELECT p.project_id, json_extract(t.value, '$.id'), json_extract(t.value, '$.initiativeId')
    FROM project_teamwork p, json_each(p.payload_json, '$.tasks') t`;
});
