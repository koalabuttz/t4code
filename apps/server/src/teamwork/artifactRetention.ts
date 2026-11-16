import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const encodeThreadIds = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

export const crewRetainsArtifacts = Effect.fn("Crew.retainsArtifacts")(function* (
  threadIds: readonly ThreadId[],
) {
  if (!threadIds.length) return false;
  const sql = yield* SqlClient.SqlClient;
  const ids = yield* encodeThreadIds(threadIds);
  const rows = yield* sql`SELECT 1 FROM project_teamwork p,
    json_each(p.payload_json, '$.tasks') task,
    json_each(p.payload_json, '$.initiatives') initiative
    WHERE json_extract(task.value, '$.ownerThreadId') IN (SELECT value FROM json_each(${ids}))
      AND json_extract(task.value, '$.initiativeId') = json_extract(initiative.value, '$.id')
      AND json_extract(initiative.value, '$.status') IN ('draft', 'active', 'paused')
      AND json_extract(task.value, '$.status') != 'cancelled'
    LIMIT 1`.pipe(NodeSqliteClient.readOnly);
  return rows.length > 0;
});
