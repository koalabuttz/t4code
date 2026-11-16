import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_teamwork (project_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE project_teamwork_events (
    project_id TEXT NOT NULL, revision INTEGER NOT NULL, command_id TEXT NOT NULL,
    actor_thread_id TEXT, action_json TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(project_id, revision), UNIQUE(project_id, command_id)
  )`;
  yield* sql`CREATE TABLE project_teamwork_outbox (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision INTEGER NOT NULL, thread_id TEXT NOT NULL,
    kind TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX project_teamwork_pending ON project_teamwork_outbox(status, project_id, revision)`;
});
