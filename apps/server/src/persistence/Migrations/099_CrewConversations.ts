import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_crew_conversations (
    project_id TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL,
    thread_id TEXT NOT NULL, payload_json TEXT NOT NULL,
    PRIMARY KEY (project_id, collection, id)
  )`;
  yield* sql`CREATE INDEX project_crew_conversations_thread ON project_crew_conversations(thread_id, collection)`;
  yield* sql`CREATE INDEX project_crew_conversations_progress ON project_crew_conversations(project_id, collection, thread_id, json_extract(payload_json, '$.progress.state'))`;
  yield* sql`CREATE INDEX project_crew_conversations_source ON project_crew_conversations(project_id, collection, thread_id, json_extract(payload_json, '$.source.messageId'), json_extract(payload_json, '$.reason'))`;
  yield* sql`CREATE INDEX project_crew_conversations_request ON project_crew_conversations(project_id, collection, thread_id, json_extract(payload_json, '$.pendingRequest.requestId'))`;
  yield* sql`CREATE INDEX project_crew_conversations_delivery ON project_crew_conversations(project_id, collection, json_extract(payload_json, '$.progress.deliveryId'))`;
  yield* sql`CREATE INDEX project_teamwork_coordinator ON project_teamwork(json_extract(payload_json, '$.coordinatorThreadId'))`;
  yield* sql`CREATE TABLE project_crew_event_cursor (id INTEGER PRIMARY KEY CHECK (id = 1), sequence INTEGER NOT NULL)`;
  yield* sql`INSERT INTO project_crew_event_cursor VALUES (1, (SELECT coalesce(max(sequence), 0) FROM orchestration_v2_events))`;
});
