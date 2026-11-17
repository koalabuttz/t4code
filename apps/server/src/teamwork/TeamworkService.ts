import {
  CommandId,
  MessageId,
  ProjectId,
  TeamworkAction,
  TeamworkError,
  TeamworkHistoryResult,
  TeamworkReadResult,
  TeamworkSnapshot,
  type TeamworkTaskExecution,
  ThreadId,
  isProviderNativeSubagentThread,
  isRuntimeModeAbove,
  type TeamworkMutateInput,
  type TeamworkHistoryInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { crewTaskExecution } from "@t3tools/shared/crewExecution";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import { RuntimeMode, ProviderInteractionMode } from "@t3tools/contracts";
import { decideTeamwork, emptyTeamwork } from "./decide.ts";

const DeliveryPayload = Schema.Struct({
  text: Schema.String,
  planning: Schema.Boolean,
  taskId: Schema.optional(Schema.String),
  stopCommandId: Schema.optional(CommandId),
  initiativeId: Schema.NullOr(Schema.String),
  actor: Schema.NullOr(ThreadId),
  limit: Schema.NullOr(
    Schema.Struct({ runtimeMode: RuntimeMode, interactionMode: ProviderInteractionMode }),
  ),
});
const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(TeamworkSnapshot));
const decodeDelivery = Schema.decodeUnknownEffect(Schema.fromJsonString(DeliveryPayload));
const decodeAction = Schema.decodeUnknownEffect(Schema.fromJsonString(TeamworkAction));
const decodeRead = Schema.decodeUnknownEffect(TeamworkReadResult);
const decodeHistory = Schema.decodeEffect(TeamworkHistoryResult);
const encodeAction = Schema.encodeEffect(Schema.fromJsonString(TeamworkAction));
const encodeState = Schema.encodeEffect(Schema.fromJsonString(TeamworkSnapshot));
const encodeDelivery = Schema.encodeEffect(Schema.fromJsonString(DeliveryPayload));
const isTeamworkError = Schema.is(TeamworkError);
const storageError = (cause: unknown) =>
  isTeamworkError(cause)
    ? cause
    : new TeamworkError({ reason: "storage", message: "Could not access project crew state." });

export class TeamworkService extends Context.Service<
  TeamworkService,
  {
    readonly read: (
      projectId: ProjectId,
      actor?: ThreadId | null,
    ) => Effect.Effect<TeamworkReadResult, TeamworkError>;
    readonly history: (
      input: typeof TeamworkHistoryInput.Type,
      actor?: ThreadId | null,
    ) => Effect.Effect<TeamworkHistoryResult, TeamworkError>;
    readonly execution: (
      projectId: ProjectId,
      taskIds: ReadonlyArray<string>,
      actor?: ThreadId | null,
    ) => Effect.Effect<ReadonlyArray<TeamworkTaskExecution>, TeamworkError>;
    readonly subscribe: (projectId: ProjectId) => Stream.Stream<TeamworkReadResult, TeamworkError>;
    readonly mutate: (
      input: TeamworkMutateInput,
      actor?: ThreadId | null,
    ) => Effect.Effect<TeamworkReadResult, TeamworkError>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/teamwork/TeamworkService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const locks = yield* KeyedLock.make<ProjectId>();
  const changes = yield* PubSub.unbounded<ProjectId>();

  const requireThread = Effect.fn("TeamworkService.requireThread")(function* (
    projectId: ProjectId,
    id: ThreadId,
  ) {
    const thread = yield* threads.getThreadShell(id).pipe(Effect.mapError(storageError));
    if (
      !thread ||
      thread.deletedAt !== null ||
      thread.projectId !== projectId ||
      isProviderNativeSubagentThread(thread)
    )
      return yield* new TeamworkError({
        reason: "not-found",
        message: "Choose an available app-owned thread in this project.",
      });
    return thread;
  });
  const authorize = Effect.fn("TeamworkService.authorize")(function* (
    projectId: ProjectId,
    actor: ThreadId | null,
  ) {
    const project = yield* projects.get(projectId).pipe(Effect.mapError(storageError));
    if (Option.isNone(project))
      return yield* new TeamworkError({ reason: "not-found", message: "Project not found." });
    if (actor !== null) {
      const thread = yield* requireThread(projectId, actor);
      if (
        thread.linkOrigin !== undefined &&
        thread.linkOrigin !== null &&
        thread.linkOrigin.access !== "full-access"
      )
        return yield* new TeamworkError({
          reason: "forbidden",
          message: "A restricted linked agent cannot access this project's crew.",
        });
      return { runtimeMode: thread.runtimeMode, interactionMode: thread.interactionMode };
    }
    return null;
  });
  const load = Effect.fn("TeamworkService.load")(function* (projectId: ProjectId) {
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM project_teamwork WHERE project_id = ${projectId}`;
    return rows[0] ? yield* decodeState(rows[0].payload_json) : emptyTeamwork(projectId);
  }, Effect.mapError(storageError));
  const read = Effect.fn("TeamworkService.read")(function* (
    projectId: ProjectId,
    actor: ThreadId | null = null,
  ) {
    yield* authorize(projectId, actor);
    const snapshot = yield* load(projectId);
    const rows =
      yield* sql`SELECT id, thread_id AS "threadId", kind, status FROM project_teamwork_outbox WHERE project_id = ${projectId} ORDER BY revision DESC, id DESC LIMIT 60`;
    return yield* decodeRead({ snapshot, deliveries: rows });
  }, Effect.mapError(storageError));
  const history = Effect.fn("TeamworkService.history")(function* (
    input: typeof TeamworkHistoryInput.Type,
    actor: ThreadId | null = null,
  ) {
    yield* authorize(input.projectId, actor);
    const rows = yield* sql<{
      revision: number;
      actor_thread_id: string | null;
      action_json: string;
      created_at: string;
    }>`SELECT revision, actor_thread_id, action_json, created_at FROM project_teamwork_events WHERE project_id = ${input.projectId} AND revision < ${input.beforeRevision ?? Number.MAX_SAFE_INTEGER} ORDER BY revision DESC LIMIT 40`;
    const events = yield* Effect.forEach(rows, (row) =>
      decodeAction(row.action_json).pipe(
        Effect.map((action) => ({
          revision: row.revision,
          actorThreadId: row.actor_thread_id,
          action,
          createdAt: row.created_at,
        })),
      ),
    );
    return yield* decodeHistory({ events });
  }, Effect.mapError(storageError));

  const execution = Effect.fn("TeamworkService.execution")(function* (
    projectId: ProjectId,
    taskIds: ReadonlyArray<string>,
    actor: ThreadId | null = null,
  ) {
    yield* authorize(projectId, actor);
    if (taskIds.length > 12)
      return yield* new TeamworkError({
        reason: "capacity",
        message: "Read at most 12 worker states at a time.",
      });
    const state = yield* load(projectId);
    const tasks = state.tasks.filter((task) => taskIds.includes(task.id));
    const threadIds = [
      ...new Set(tasks.flatMap((task) => (task.ownerThreadId ? [task.ownerThreadId] : []))),
    ];
    const shells = yield* Effect.forEach(threadIds, (id) => threads.getThreadShell(id), {
      concurrency: 4,
    });
    const byId = new Map(
      shells.flatMap((thread) =>
        thread && thread.projectId === projectId && thread.deletedAt === null
          ? [[thread.id, thread] as const]
          : [],
      ),
    );
    return tasks.map((task) => {
      const thread = task.ownerThreadId === null ? undefined : byId.get(task.ownerThreadId);
      const request = thread?.pendingRuntimeRequest;
      return crewTaskExecution(
        task,
        thread
          ? {
              status: thread.activityRunStatus ?? thread.status,
              hasPendingApprovals:
                request != null && request.kind !== "user_input" && request.kind !== "auth_refresh",
              hasPendingUserInput: request?.kind === "user_input",
              hasPendingBackgroundTasks: (thread.pendingBackgroundTasks?.length ?? 0) > 0,
              lastError: thread.lastError,
            }
          : "unavailable",
      );
    });
  }, Effect.mapError(storageError));

  const deliver = Effect.fn("TeamworkService.deliver")(function* (projectId: ProjectId) {
    const acceptedStops: Array<{
      readonly id: string;
      readonly threadId: ThreadId;
      readonly commandId: CommandId;
    }> = [];
    const pending = yield* sql<{
      id: string;
      thread_id: string;
      kind: string;
      payload_json: string;
    }>`SELECT id, thread_id, kind, payload_json FROM project_teamwork_outbox WHERE project_id = ${projectId} AND status = 'pending' ORDER BY revision, id`;
    for (const row of pending) {
      const payload = yield* decodeDelivery(row.payload_json);
      const commandId = CommandId.make(
        `teamwork:${row.id}${payload.stopCommandId === undefined ? "" : `:retry:${payload.stopCommandId}`}`,
      );
      const acceptedStop = yield* locks.withLock(
        projectId,
        Effect.gen(function* () {
          const current = yield* sql<{
            status: string;
          }>`SELECT status FROM project_teamwork_outbox WHERE id = ${row.id}`;
          if (current[0]?.status !== "pending") return false;
          const state = yield* load(projectId);
          if (
            row.kind === "message" &&
            payload.initiativeId !== null &&
            state.initiatives.find((i) => i.id === payload.initiativeId)?.status !== "active" &&
            !(
              payload.planning &&
              row.thread_id === state.coordinatorThreadId &&
              state.initiatives.some((i) => i.id === payload.initiativeId && i.status === "draft")
            )
          ) {
            yield* sql`UPDATE project_teamwork_outbox SET status = 'cancelled' WHERE id = ${row.id}`;
            return false;
          }
          const threadId = ThreadId.make(row.thread_id);
          const execution = Effect.gen(function* () {
            yield* requireThread(projectId, threadId);
            if (row.kind === "stop") {
              yield* threads.dispatch({
                type: "thread.stop",
                commandId,
                threadId,
                stopDelegatedTasks: true,
              });
            } else {
              const current = yield* authorize(projectId, payload.actor);
              const limit =
                current && payload.limit
                  ? {
                      runtimeMode: isRuntimeModeAbove(
                        current.runtimeMode,
                        payload.limit.runtimeMode,
                      )
                        ? payload.limit.runtimeMode
                        : current.runtimeMode,
                      interactionMode:
                        current.interactionMode === "plan" ||
                        payload.limit.interactionMode === "plan"
                          ? ("plan" as const)
                          : ("default" as const),
                    }
                  : payload.limit;
              if (
                threadId !== state.coordinatorThreadId &&
                !state.tasks.some(
                  (t) =>
                    t.ownerThreadId === threadId &&
                    t.initiativeId === payload.initiativeId &&
                    !["done", "cancelled"].includes(t.status),
                )
              )
                return yield* new TeamworkError({
                  reason: "invalid-state",
                  message: "This worker no longer owns an active team assignment.",
                });
              yield* threads
                .sendToThread({
                  projectId,
                  commandId,
                  threadId,
                  messageId: MessageId.make(`teamwork:${row.id}`),
                  ...(payload.actor === null ? {} : { senderThreadId: payload.actor }),
                  text: payload.text,
                  attachments: [],
                  mode: "queue",
                  createdBy: payload.actor === null ? "user" : "agent",
                  creationSource: "server",
                })
                .pipe(Effect.provideService(DispatchModeLimit, limit ?? undefined));
            }
          });
          const outcome = yield* Effect.result(execution);
          if (row.kind === "stop" && Result.isSuccess(outcome)) return true;
          yield* sql`UPDATE project_teamwork_outbox SET status = ${Result.isSuccess(outcome) ? "delivered" : "failed"} WHERE id = ${row.id}`;
          return false;
        }),
      );
      if (acceptedStop) {
        acceptedStops.push({ id: row.id, threadId: ThreadId.make(row.thread_id), commandId });
      }
    }
    yield* Effect.forEach(
      acceptedStops,
      Effect.fn("TeamworkService.confirmStop")(function* (stop) {
        const outcome = yield* Effect.result(threads.confirmStop(stop));
        yield* locks.withLock(
          projectId,
          sql`UPDATE project_teamwork_outbox SET status = ${Result.isSuccess(outcome) ? "delivered" : "failed"} WHERE id = ${stop.id} AND status = 'pending'`,
        );
        yield* PubSub.publish(changes, projectId);
      }),
      { concurrency: 4, discard: true },
    );
    if (pending.length) yield* PubSub.publish(changes, projectId);
  }, Effect.mapError(storageError));
  const worker = yield* makeDrainableWorker(deliver);

  const mutate = Effect.fn("TeamworkService.mutate")(function* (
    input: TeamworkMutateInput,
    actor: ThreadId | null = null,
  ) {
    const limit = yield* authorize(input.projectId, actor);
    if (limit?.interactionMode === "plan")
      return yield* new TeamworkError({
        reason: "forbidden",
        message: "Switch out of Plan mode before changing Crew state.",
      });
    if (input.action.type === "coordinator.set" || input.action.type === "task.assign")
      yield* requireThread(input.projectId, input.action.threadId);
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* locks.withLock(
      input.projectId,
      sql.withTransaction(
        Effect.gen(function* () {
          const previous = yield* sql<{
            actor_thread_id: string | null;
            action_json: string;
          }>`SELECT actor_thread_id, action_json FROM project_teamwork_events WHERE project_id = ${input.projectId} AND command_id = ${input.commandId}`;
          const actionJson = yield* encodeAction(input.action);
          if (previous[0]) {
            if (previous[0].actor_thread_id !== actor || previous[0].action_json !== actionJson)
              return yield* new TeamworkError({
                reason: "conflict",
                message: "This request id was already used for a different Crew action.",
              });
            return;
          }
          const state = yield* load(input.projectId);
          if (state.revision !== input.expectedRevision)
            return yield* new TeamworkError({
              reason: "conflict",
              message: "The team changed. Refresh its state and retry your action.",
            });
          if (input.action.type === "task.reserve" || input.action.type === "coordinator.set") {
            const action = input.action;
            const task =
              action.type === "task.reserve"
                ? state.tasks.find((candidate) => candidate.id === action.id)
                : undefined;
            const stops = yield* sql`SELECT id FROM project_teamwork_outbox
              WHERE project_id = ${input.projectId} AND kind = 'stop' AND status IN ('pending', 'failed')
              AND (${input.action.type === "coordinator.set" ? 1 : 0}
                OR json_extract(payload_json, '$.taskId') = ${task?.id ?? null}
                OR (json_extract(payload_json, '$.taskId') IS NULL
                  AND json_extract(payload_json, '$.initiativeId') = ${task?.initiativeId ?? null}))
              LIMIT 1`;
            if (stops.length)
              return yield* new TeamworkError({
                reason: "invalid-state",
                message:
                  "Finish or retry the previous worker's stop before replacing its assignment or coordinator.",
              });
          }
          if (
            input.action.type === "initiative.approve" ||
            (input.action.type === "initiative.status" && input.action.status === "active")
          ) {
            const pendingStops =
              yield* sql`SELECT id FROM project_teamwork_outbox WHERE project_id = ${input.projectId} AND kind = 'stop' AND status IN ('pending', 'failed') AND json_extract(payload_json, '$.initiativeId') = ${input.action.id} LIMIT 1`;
            if (pendingStops.length)
              return yield* new TeamworkError({
                reason: "invalid-state",
                message:
                  "Finish or retry the outstanding worker stops before resuming this initiative.",
              });
          }
          const decision = decideTeamwork(state, input.action, actor, now, input.commandId);
          if (input.action.type === "task.assign") {
            const child = yield* requireThread(input.projectId, input.action.threadId);
            if (
              child.lineage.parentThreadId !== state.coordinatorThreadId ||
              child.lineage.relationshipToParent !== "subagent"
            )
              return yield* new TeamworkError({
                reason: "invalid-state",
                message: "Assign only a child delegated by this project's coordinator.",
              });
          }
          if (Result.isFailure(decision)) return yield* decision.failure;
          const { snapshot, intents } = decision.success;
          const encoded = yield* encodeState(snapshot);
          if (Buffer.byteLength(encoded) > 750_000)
            return yield* new TeamworkError({
              reason: "capacity",
              message: "The team board is full. Shorten briefs or remove unused knowledge.",
            });
          yield* sql`INSERT INTO project_teamwork (project_id, revision, payload_json) VALUES (${input.projectId}, ${snapshot.revision}, ${encoded}) ON CONFLICT(project_id) DO UPDATE SET revision = excluded.revision, payload_json = excluded.payload_json`;
          yield* sql`INSERT INTO project_teamwork_events (project_id, revision, command_id, actor_thread_id, action_json, created_at) VALUES (${input.projectId}, ${snapshot.revision}, ${input.commandId}, ${actor}, ${actionJson}, ${now})`;
          if (
            input.action.type === "coordinator.set" &&
            state.coordinatorThreadId !== input.action.threadId
          )
            yield* sql`UPDATE project_teamwork_outbox SET status = 'cancelled' WHERE project_id = ${input.projectId} AND thread_id = ${state.coordinatorThreadId} AND kind = 'message' AND status IN ('pending', 'failed')`;
          for (const initiative of snapshot.initiatives) {
            if (
              initiative.status !== "active" &&
              state.initiatives.find((i) => i.id === initiative.id)?.status === "active"
            )
              yield* sql`UPDATE project_teamwork_outbox SET status = 'cancelled' WHERE project_id = ${input.projectId} AND kind = 'message' AND status IN ('pending', 'failed') AND json_extract(payload_json, '$.initiativeId') = ${initiative.id}`;
          }
          if (input.action.type === "task.reset" || input.action.type === "task.edit") {
            const taskId = input.action.id;
            const previousOwner = state.tasks.find((t) => t.id === taskId)?.ownerThreadId;
            if (previousOwner)
              yield* sql`UPDATE project_teamwork_outbox SET status = 'cancelled' WHERE project_id = ${input.projectId} AND thread_id = ${previousOwner} AND kind = 'message' AND status IN ('pending', 'failed')`;
          }
          if (input.action.type === "delivery.retry")
            yield* sql`UPDATE project_teamwork_outbox SET status = 'pending', payload_json = CASE WHEN kind = 'stop' THEN json_set(payload_json, '$.stopCommandId', ${input.commandId}) ELSE payload_json END WHERE id = ${input.action.id} AND project_id = ${input.projectId} AND status = 'failed'`;
          for (const [index, intent] of intents.entries()) {
            const id = `${input.projectId}:${snapshot.revision}:${index}`;
            const payload = yield* encodeDelivery({
              ...intent,
              planning: intent.planning ?? false,
              actor,
              limit,
            });
            yield* sql`INSERT INTO project_teamwork_outbox (id, project_id, revision, thread_id, kind, status, payload_json) VALUES (${id}, ${input.projectId}, ${snapshot.revision}, ${intent.threadId}, ${intent.kind}, 'pending', ${payload})`;
          }
        }),
      ),
    );
    yield* PubSub.publish(changes, input.projectId);
    yield* worker.enqueue(input.projectId);
    return yield* read(input.projectId, actor);
  }, Effect.mapError(storageError));

  const pending = yield* sql<{
    project_id: string;
  }>`SELECT DISTINCT project_id FROM project_teamwork_outbox WHERE status = 'pending'`;
  yield* Effect.forEach(pending, (row) => worker.enqueue(ProjectId.make(row.project_id)));
  return TeamworkService.of({
    read,
    history,
    execution,
    mutate,
    drain: worker.drain,
    subscribe: (projectId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.concat(
            Stream.fromEffect(read(projectId)),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((id) => id === projectId),
              Stream.mapEffect(() => read(projectId)),
            ),
          );
        }),
      ),
  });
});

export const layer = Layer.effect(TeamworkService, make);
