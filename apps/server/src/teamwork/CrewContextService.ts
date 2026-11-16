import {
  ProjectId,
  RunId,
  TeamworkContext,
  TeamworkAction,
  TeamworkBoardEntry,
  TeamworkError,
  TeamworkSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { crewContext } from "./context.ts";

export class CrewContextService extends Context.Service<
  CrewContextService,
  {
    readonly prepare: (input: {
      projectId: ProjectId;
      threadId: ThreadId;
      query: string;
      allowance: number;
    }) => Effect.Effect<TeamworkContext | null, TeamworkError>;
    readonly record: (
      projectId: ProjectId,
      runId: RunId,
      packet: TeamworkContext,
    ) => Effect.Effect<void, TeamworkError>;
  }
>()("t3/teamwork/CrewContextService") {}

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(TeamworkSnapshot));
const encode = Schema.encodeEffect(Schema.fromJsonString(TeamworkContext));
const encodeWords = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeAction = Schema.decodeUnknownEffect(Schema.fromJsonString(TeamworkAction));
const decodeBoard = Schema.decodeUnknownEffect(TeamworkBoardEntry);
const failed = () =>
  new TeamworkError({
    reason: "storage",
    message: "Could not prepare or record current Crew context.",
  });

export const layer = Layer.effect(
  CrewContextService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const prepare = Effect.fn("CrewContextService.prepare")(function* (input: {
      projectId: ProjectId;
      threadId: ThreadId;
      query: string;
      allowance: number;
    }) {
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM project_teamwork WHERE project_id = ${input.projectId}`;
      if (!rows[0]) return null;
      const state = yield* decode(rows[0].payload_json);
      if (
        state.coordinatorThreadId !== input.threadId &&
        !state.tasks.some((t) => t.ownerThreadId === input.threadId)
      )
        return null;
      const words = [...new Set(input.query.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])].slice(
        0,
        8,
      );
      const terms = yield* encodeWords(words);
      const history = yield* sql<{
        command_id: string;
        revision: number;
        action_json: string;
        actor_thread_id: string | null;
        created_at: string;
      }>`
        SELECT command_id, revision, action_json, actor_thread_id, created_at FROM project_teamwork_events
        WHERE project_id = ${input.projectId} AND json_extract(action_json, '$.type') = 'board.post'
          AND (json_extract(action_json, '$.initiativeId') IS NULL OR json_extract(action_json, '$.initiativeId') IN
            (SELECT json_extract(value, '$.id') FROM json_each(${rows[0].payload_json}, '$.initiatives') WHERE json_extract(value, '$.status') IN ('draft', 'active', 'paused')))
          AND (${words.length} = 0 OR EXISTS (SELECT 1 FROM json_each(${terms}) term WHERE instr(lower(json_extract(action_json, '$.text')), term.value) > 0))
        ORDER BY revision DESC LIMIT 12`;
      const discussions = yield* Effect.forEach(
        history,
        Effect.fn("CrewContextService.discussion")(function* (row) {
          const action = yield* decodeAction(row.action_json);
          if (action.type !== "board.post") return [];
          return [
            yield* decodeBoard({
              id: row.command_id,
              revision: row.revision,
              initiativeId: action.initiativeId,
              authorThreadId: row.actor_thread_id,
              text: action.text,
              recipients: action.recipients,
              createdAt: row.created_at,
            }),
          ];
        }),
      );
      const board = [
        ...state.board,
        ...discussions.flat().filter((entry) => !state.board.some((b) => b.id === entry.id)),
      ].sort((a, b) => (a.revision ?? 0) - (b.revision ?? 0));
      return crewContext({ ...state, board }, input.threadId, input.query, input.allowance);
    }, Effect.mapError(failed));
    const record = Effect.fn("CrewContextService.record")(function* (
      projectId: ProjectId,
      runId: RunId,
      packet: TeamworkContext,
    ) {
      const payload = yield* encode(packet);
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`INSERT INTO project_teamwork_context (project_id, thread_id, run_id, delivered_at, payload_json)
      VALUES (${projectId}, ${packet.threadId}, ${runId}, ${now}, ${payload})
      ON CONFLICT(thread_id) DO UPDATE SET run_id = excluded.run_id, delivered_at = excluded.delivered_at, payload_json = excluded.payload_json`;
    }, Effect.mapError(failed));
    return CrewContextService.of({ prepare, record });
  }),
);
