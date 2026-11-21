import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX project_crew_conversations_origin_message ON project_crew_conversations(
    project_id, collection, json_extract(payload_json, '$.origin.conversation.threadId'),
    json_extract(payload_json, '$.origin.messageId'), id
  )`;
  yield* sql`CREATE INDEX project_crew_conversations_explanation_message ON project_crew_conversations(
    project_id, collection, json_extract(payload_json, '$.explanation.conversation.threadId'),
    json_extract(payload_json, '$.explanation.messageId'), id
  )`;
});
