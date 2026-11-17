import {
  CommandId,
  MessageId,
  ProjectId,
  TeamworkAction,
  TeamworkArchive,
  TeamworkError,
  TeamworkHistoryResult,
  TeamworkReadResult,
  TeamworkSnapshot,
  TeamworkContext,
  type TeamworkTaskExecution,
  type OrchestrationV2ThreadShell,
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
import { crewContext } from "./context.ts";
import { CrewArtifacts } from "./CrewArtifacts.ts";
import { makeCrewConversations } from "./CrewConversations.ts";
import {
  CrewWorkstream,
  CrewWorkstreamTaskLink,
  type CrewConversationCommand,
  type CrewConversationQuery,
  type CrewConversationPage,
  type CrewConversationReceipt,
} from "@t3tools/contracts/crewConversation";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";

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
const decodeHistory = Schema.decodeUnknownEffect(TeamworkHistoryResult);
const encodeAction = Schema.encodeEffect(Schema.fromJsonString(TeamworkAction));
const encodeState = Schema.encodeEffect(Schema.fromJsonString(TeamworkSnapshot));
const decodeArchive = Schema.decodeUnknownEffect(Schema.fromJsonString(TeamworkArchive));
const decodeContext = Schema.decodeUnknownEffect(Schema.fromJsonString(TeamworkContext));
const encodeArchive = Schema.encodeEffect(Schema.fromJsonString(TeamworkArchive));
const encodeDelivery = Schema.encodeEffect(Schema.fromJsonString(DeliveryPayload));
const encodeWorkstream = Schema.encodeEffect(Schema.fromJsonString(CrewWorkstream));
const encodeTaskLink = Schema.encodeEffect(Schema.fromJsonString(CrewWorkstreamTaskLink));
const encodeDestinationKey = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const isTeamworkError = Schema.is(TeamworkError);
const storageError = (cause: unknown) =>
  isTeamworkError(cause)
    ? cause
    : new TeamworkError({ reason: "storage", message: "Could not access project crew state." });
const workerBusy = (thread: OrchestrationV2ThreadShell) =>
  thread.deletedAt === null &&
  (!["idle", "completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(
    thread.activityRunStatus ?? thread.status ?? "",
  ) ||
    thread.pendingRuntimeRequest != null ||
    (thread.pendingBackgroundTasks?.length ?? 0) > 0);

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
    readonly conversationCommand: (
      input: CrewConversationCommand,
      actor?: ThreadId | null,
    ) => Effect.Effect<CrewConversationReceipt, TeamworkError>;
    readonly conversationQuery: (
      input: CrewConversationQuery,
      actor?: ThreadId | null,
    ) => Effect.Effect<CrewConversationPage, TeamworkError>;
    readonly observeConversationEvent: (
      event: import("@t3tools/contracts").OrchestrationV2StoredEvent,
    ) => Effect.Effect<void, TeamworkError>;
    readonly bindImplementationDestination: (
      projectId: ProjectId,
      taskId: string,
      attemptId: string,
      destination: ThreadId | null,
      actor: ThreadId,
    ) => Effect.Effect<void, TeamworkError>;
  }
>()("t3/teamwork/TeamworkService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const artifacts = yield* CrewArtifacts;
  const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
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

  const requireStopped = Effect.fn("TeamworkService.requireStopped")(function* (
    threadIds: ReadonlyArray<ThreadId>,
  ) {
    for (const id of new Set(threadIds)) {
      const thread = yield* threads.getThreadShell(id).pipe(Effect.mapError(storageError));
      if (!thread || thread.deletedAt !== null) continue;
      if (workerBusy(thread))
        return yield* new TeamworkError({
          reason: "invalid-state",
          message:
            "Wait for the previous coordinator and workers to stop before resuming or replacing work. A delivered stop request is not yet a stopped worker.",
        });
    }
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
    // Stop obligations survive assignment resets and the recent discussion window.
    const rows = yield* sql`WITH recent AS (
        SELECT id FROM project_teamwork_outbox WHERE project_id = ${projectId}
        ORDER BY revision DESC, id DESC LIMIT 60
      ), stops AS (
        SELECT id, status, ROW_NUMBER() OVER (
          PARTITION BY thread_id, json_extract(payload_json, '$.initiativeId'), json_extract(payload_json, '$.taskId')
          ORDER BY revision DESC, id DESC
        ) AS stop_rank FROM project_teamwork_outbox
        WHERE project_id = ${projectId} AND kind = 'stop' AND status != 'cancelled'
      ) SELECT id, thread_id AS "threadId", CASE WHEN kind LIKE 'crew-%' THEN 'message' ELSE kind END AS kind, status,
        json_extract(payload_json, '$.initiativeId') AS "initiativeId",
        json_extract(payload_json, '$.taskId') AS "taskId"
        FROM project_teamwork_outbox WHERE project_id = ${projectId}
          AND (id IN (SELECT id FROM recent)
            OR status IN ('pending', 'failed')
            OR id IN (SELECT id FROM stops WHERE stop_rank = 1))
        ORDER BY revision DESC, id DESC`;
    return yield* decodeRead({
      snapshot,
      deliveries: rows,
      capabilities: ["archive", "submissions", "context", "artifacts"],
      context:
        snapshot.coordinatorThreadId === null
          ? null
          : crewContext(snapshot, actor ?? snapshot.coordinatorThreadId),
    });
  }, Effect.mapError(storageError));
  const history = Effect.fn("TeamworkService.history")(function* (
    input: typeof TeamworkHistoryInput.Type,
    actor: ThreadId | null = null,
  ) {
    yield* authorize(input.projectId, actor);
    if (input.artifactTaskId !== undefined || input.artifactMilestoneId !== undefined) {
      const state = yield* load(input.projectId);
      const taskSource =
        input.artifactTaskId === undefined
          ? []
          : yield* sql<{
              initiative_id: string;
            }>`SELECT initiative_id FROM project_teamwork_task_ids WHERE project_id = ${input.projectId} AND task_id = ${input.artifactTaskId}`;
      const initiativeId = taskSource[0]?.initiative_id ?? input.initiativeId;
      const archived = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM project_teamwork_archive WHERE project_id = ${input.projectId} AND initiative_id = ${initiativeId ?? null}`;
      const archive = archived[0] ? yield* decodeArchive(archived[0].payload_json) : null;
      const task = [...state.tasks, ...(archive?.tasks ?? [])].find(
        (t) => t.id === input.artifactTaskId,
      );
      const initiative =
        state.initiatives.find((i) => i.id === initiativeId) ?? archive?.initiative;
      const verification = initiative?.milestones.find(
        (m) => m.id === input.artifactMilestoneId,
      )?.verification;
      const artifact =
        input.artifactTaskId === undefined ? verification?.artifact : task?.submission?.artifact;
      if (!artifact)
        return yield* decodeHistory({
          events: [],
          artifact: {
            status: "unavailable",
            detail: "No immutable artifact was recorded for this submission.",
          },
        });
      const project = yield* projects.get(input.projectId);
      const sourceThreadId =
        input.artifactTaskId === undefined ? verification?.threadId : task?.ownerThreadId;
      const thread = sourceThreadId ? yield* threads.getThreadShell(sourceThreadId) : null;
      const roots = [
        ...(Option.isSome(project) ? [project.value.workspaceRoot] : []),
        ...(thread?.projectId === input.projectId && thread.worktreePath
          ? [thread.worktreePath]
          : []),
      ];
      return yield* decodeHistory({
        events: [],
        artifact: yield* artifacts.inspect(artifact, roots),
      });
    }
    if (input.contextThreadId !== undefined) {
      yield* requireThread(input.projectId, input.contextThreadId);
      const rows = yield* sql<{
        payload_json: string;
        run_id: string;
        delivered_at: string;
      }>`SELECT payload_json, run_id, delivered_at FROM project_teamwork_context WHERE project_id = ${input.projectId} AND thread_id = ${input.contextThreadId}`;
      const row = rows[0];
      return yield* decodeHistory({
        events: [],
        context: row
          ? {
              packet: yield* decodeContext(row.payload_json),
              runId: row.run_id,
              deliveredAt: row.delivered_at,
            }
          : null,
      });
    }
    if (input.archived) {
      const source =
        input.taskId === undefined
          ? []
          : yield* sql<{
              initiative_id: string;
            }>`SELECT initiative_id FROM project_teamwork_task_ids WHERE project_id = ${input.projectId} AND task_id = ${input.taskId}`;
      const initiativeId = input.initiativeId ?? source[0]?.initiative_id;
      const rows = yield* sql<{
        id: string;
        title: string;
        status: string;
        revision: number;
        archivedAt: string;
        taskCount: number;
      }>`SELECT initiative_id AS id, title, status, revision, archived_at AS "archivedAt", task_count AS "taskCount"
        FROM project_teamwork_archive WHERE project_id = ${input.projectId}
        AND revision < ${input.beforeRevision ?? Number.MAX_SAFE_INTEGER}
        AND (${initiativeId ?? null} IS NULL OR initiative_id = ${initiativeId ?? null})
        AND (${input.taskId ?? null} IS NULL OR initiative_id = ${source[0]?.initiative_id ?? null})
        AND instr(lower(payload_json), lower(${input.query?.trim() ?? ""})) > 0
        ORDER BY revision DESC LIMIT 21`;
      const detail =
        initiativeId === undefined
          ? []
          : yield* sql<{ payload_json: string }>`
      SELECT payload_json FROM project_teamwork_archive
        WHERE project_id = ${input.projectId} AND initiative_id = ${initiativeId}`;
      return yield* decodeHistory({
        events: [],
        archives: rows.slice(0, 20),
        archive: detail[0] ? yield* decodeArchive(detail[0].payload_json) : null,
        nextBeforeRevision: rows.length > 20 ? rows[19]!.revision : null,
      });
    }
    const rows = yield* sql<{
      revision: number;
      actor_thread_id: string | null;
      action_json: string;
      created_at: string;
    }>`SELECT revision, actor_thread_id, action_json, created_at FROM project_teamwork_events
      WHERE project_id = ${input.projectId} AND revision < ${input.beforeRevision ?? Number.MAX_SAFE_INTEGER}
      AND json_extract(action_json, '$.type') != 'crew.conversation'
      AND (${input.atRevision ?? null} IS NULL OR revision = ${input.atRevision ?? null})
      AND (${input.taskId ?? null} IS NULL OR (json_extract(action_json, '$.id') = ${input.taskId ?? null}
        AND json_extract(action_json, '$.type') LIKE 'task.%'))
      AND (${input.initiativeId ?? null} IS NULL
        OR json_extract(action_json, '$.initiativeId') = ${input.initiativeId ?? null}
        OR (json_extract(action_json, '$.type') LIKE 'initiative.%' AND json_extract(action_json, '$.id') = ${input.initiativeId ?? null})
        OR (json_extract(action_json, '$.type') LIKE 'task.%' AND json_extract(action_json, '$.id') IN
          (SELECT task_id FROM project_teamwork_task_ids WHERE project_id = ${input.projectId} AND initiative_id = ${input.initiativeId ?? null})))
      AND instr(lower(action_json), lower(${input.query?.trim() ?? ""})) > 0
      ORDER BY revision DESC LIMIT 41`;
    const events = yield* Effect.forEach(rows.slice(0, 40), (row) =>
      decodeAction(row.action_json).pipe(
        Effect.map((action) => ({
          revision: row.revision,
          actorThreadId: row.actor_thread_id,
          action,
          createdAt: row.created_at,
        })),
      ),
    );
    return yield* decodeHistory({
      events,
      nextBeforeRevision: rows.length > 40 ? rows[39]!.revision : null,
    });
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

  const conversations = yield* makeCrewConversations({
    environmentId,
    threads,
    locks,
    load,
    authorize,
    requireThread,
    requireStopped,
    changed: (projectId) => PubSub.publish(changes, projectId),
  });
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
      if (row.kind.startsWith("crew-")) {
        yield* conversations.deliver({
          ...row,
          project_id: projectId,
          thread_id: ThreadId.make(row.thread_id),
        });
        continue;
      }
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
            if (row.kind === "stop") {
              const thread = yield* threads
                .getThreadShell(threadId)
                .pipe(Effect.mapError(storageError));
              if (!thread || thread.deletedAt !== null) return;
            }
            yield* requireThread(projectId, threadId);
            if (row.kind === "stop") {
              yield* threads.dispatch({
                type: "thread.stop",
                commandId,
                threadId,
                stopDelegatedTasks: true,
              });
              return true;
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
          if (Result.isSuccess(outcome) && outcome.success === true) return true;
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

  const cursor = yield* sql<{
    sequence: number;
  }>`SELECT sequence FROM project_crew_event_cursor WHERE id = 1`;
  let observedSequence = cursor[0]?.sequence ?? 0;
  const meaningful = (stored: import("@t3tools/contracts").OrchestrationV2StoredEvent) =>
    stored.event.type === "run.updated" ||
    stored.event.type === "runtime-request.updated" ||
    (stored.event.type === "message.updated" &&
      stored.event.payload.role === "user" &&
      !stored.event.payload.streaming);
  const observe = Effect.fn("TeamworkService.observeConversation")(function* (
    stored: import("@t3tools/contracts").OrchestrationV2StoredEvent,
  ) {
    if (stored.sequence <= observedSequence) return;
    const projectId = yield* conversations.observe(stored);
    yield* sql`UPDATE project_crew_event_cursor SET sequence = max(sequence, ${stored.sequence}) WHERE id = 1`;
    observedSequence = stored.sequence;
    if (projectId !== null) yield* worker.enqueue(projectId);
  }, Effect.mapError(storageError));
  yield* threads.streamStoredEventsFrom({ afterSequence: observedSequence }).pipe(
    Stream.filter(meaningful),
    Stream.runForEach(observe),
    Effect.catch((error) => Effect.logError("Crew conversation observation stopped", error)),
    Effect.forkScoped,
  );

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
          if (input.action.type === "task.reserve") {
            const taskId = input.action.id;
            const task = state.tasks.find((t) => t.id === taskId);
            const initiative = state.initiatives.find((i) => i.id === task?.initiativeId);
            if (initiative) {
              const assignments = state.tasks.filter((t) => t.initiativeId === initiative.id);
              const occupied = assignments.filter((t) =>
                ["delegating", "running", "blocked", "review"].includes(t.status),
              );
              const assignedWorkers = new Set(
                occupied.flatMap((t) => (t.ownerThreadId ? [t.ownerThreadId] : [])),
              );
              const stops = yield* sql<{
                thread_id: string;
              }>`SELECT DISTINCT thread_id FROM project_teamwork_outbox WHERE project_id = ${input.projectId} AND kind = 'stop' AND json_extract(payload_json, '$.initiativeId') = ${initiative.id}`;
              const previousWorkers = new Set([
                ...assignments.flatMap((t) => (t.ownerThreadId ? [t.ownerThreadId] : [])),
                ...stops.map((s) => s.thread_id),
              ]);
              const shell = yield* threads
                .getShellSnapshot({ projectId: input.projectId, unsettledOnly: true })
                .pipe(Effect.mapError(storageError));
              const finishing = shell.threads.filter(
                (t) => previousWorkers.has(t.id) && !assignedWorkers.has(t.id) && workerBusy(t),
              );
              if (occupied.length + finishing.length >= (initiative.policy?.maxConcurrent ?? 4))
                return yield* new TeamworkError({
                  reason: "invalid-state",
                  message:
                    "The concurrency limit includes accepted or replaced workers that have not stopped yet. Wait for execution to finish before assigning more work.",
                });
            }
          }
          if (
            input.action.type === "coordinator.set" &&
            state.coordinatorThreadId !== null &&
            state.coordinatorThreadId !== input.action.threadId
          )
            yield* requireStopped([
              state.coordinatorThreadId,
              ...state.tasks.flatMap((task) =>
                task.ownerThreadId && !["done", "cancelled"].includes(task.status)
                  ? [task.ownerThreadId]
                  : [],
              ),
            ]);
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
            const deliveredStops = yield* sql<{
              thread_id: string;
            }>`SELECT DISTINCT thread_id FROM project_teamwork_outbox
              WHERE project_id = ${input.projectId} AND kind = 'stop' AND status = 'delivered'
              AND (${action.type === "coordinator.set"} OR json_extract(payload_json, '$.taskId') = ${task?.id ?? null}
                OR (json_extract(payload_json, '$.taskId') IS NULL AND json_extract(payload_json, '$.initiativeId') = ${task?.initiativeId ?? null}))`;
            yield* requireStopped(deliveredStops.map((row) => ThreadId.make(row.thread_id)));
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
            const stopped = yield* sql<{
              thread_id: string;
            }>`SELECT DISTINCT thread_id FROM project_teamwork_outbox WHERE project_id = ${input.projectId} AND kind = 'stop' AND status = 'delivered' AND json_extract(payload_json, '$.initiativeId') = ${input.action.id}`;
            yield* requireStopped(stopped.map((row) => ThreadId.make(row.thread_id)));
          }
          let archive: TeamworkArchive | undefined;
          if (input.action.type === "initiative.create") {
            const existing =
              yield* sql`SELECT initiative_id FROM project_teamwork_archive WHERE project_id = ${input.projectId} AND initiative_id = ${input.action.id}`;
            if (existing.length)
              return yield* new TeamworkError({
                reason: "conflict",
                message: "Restore the archived initiative instead of reusing its identity.",
              });
          }
          if (input.action.type === "task.create") {
            const existing =
              yield* sql`SELECT task_id FROM project_teamwork_task_ids WHERE project_id = ${input.projectId} AND task_id = ${input.action.id}`;
            if (existing.length)
              return yield* new TeamworkError({
                reason: "conflict",
                message: "This task identity already belongs to active or archived work.",
              });
          }
          if (input.action.type === "initiative.archive") {
            const pending =
              yield* sql`SELECT id FROM project_teamwork_outbox WHERE project_id = ${input.projectId}
              AND status IN ('pending', 'failed') AND json_extract(payload_json, '$.initiativeId') = ${input.action.id} LIMIT 1`;
            if (pending.length)
              return yield* new TeamworkError({
                reason: "invalid-state",
                message: "Finish or retry outstanding deliveries before archiving this initiative.",
              });
          }
          if (input.action.type === "initiative.restore") {
            const rows = yield* sql<{
              payload_json: string;
            }>`SELECT payload_json FROM project_teamwork_archive WHERE project_id = ${input.projectId} AND initiative_id = ${input.action.id}`;
            if (rows[0]) archive = yield* decodeArchive(rows[0].payload_json);
          }
          const decision = decideTeamwork(
            state,
            input.action,
            actor,
            now,
            input.commandId,
            archive,
          );
          if (input.action.type === "task.assign") {
            const action = input.action;
            const child = yield* requireThread(input.projectId, input.action.threadId);
            if (
              child.lineage.parentThreadId !== state.coordinatorThreadId ||
              child.lineage.relationshipToParent !== "subagent"
            )
              return yield* new TeamworkError({
                reason: "invalid-state",
                message: "Assign only a child delegated by this project's coordinator.",
              });
            const task = state.tasks.find((t) => t.id === action.id);
            if (task && Result.isSuccess(decision)) {
              const conversation = {
                environmentId,
                projectId: input.projectId,
                threadId: child.id,
              };
              const member = yield* encodeWorkstream({
                conversation,
                title: task.title.slice(0, 160),
                status: "open",
                linkedAt: now,
                updatedAt: now,
              });
              const link = yield* encodeTaskLink({
                workstream: conversation,
                initiativeId: task.initiativeId,
                taskId: task.id,
              });
              yield* sql`INSERT INTO project_crew_conversations VALUES (${input.projectId}, 'workstreams', ${child.id}, ${child.id}, ${member}) ON CONFLICT DO NOTHING`;
              yield* sql`INSERT INTO project_crew_conversations VALUES (${input.projectId}, 'task-links', ${task.id}, ${child.id}, ${link}) ON CONFLICT DO NOTHING`;
            }
          }
          if (Result.isFailure(decision)) return yield* decision.failure;
          const { snapshot, intents } = decision.success;
          if (input.action.type === "coordinator.pause")
            yield* sql`UPDATE project_teamwork_outbox SET status = 'cancelled' WHERE project_id = ${input.projectId} AND kind = 'message' AND status IN ('pending', 'failed')`;
          const encoded = yield* encodeState(snapshot);
          if (Buffer.byteLength(encoded) > 750_000)
            return yield* new TeamworkError({
              reason: "capacity",
              message: "The team board is full. Shorten briefs or remove unused knowledge.",
            });
          yield* sql`INSERT INTO project_teamwork (project_id, revision, payload_json) VALUES (${input.projectId}, ${snapshot.revision}, ${encoded}) ON CONFLICT(project_id) DO UPDATE SET revision = excluded.revision, payload_json = excluded.payload_json`;
          yield* sql`INSERT INTO project_teamwork_events (project_id, revision, command_id, actor_thread_id, action_json, created_at) VALUES (${input.projectId}, ${snapshot.revision}, ${input.commandId}, ${actor}, ${actionJson}, ${now})`;
          if (input.action.type === "task.create")
            yield* sql`INSERT INTO project_teamwork_task_ids (project_id, task_id, initiative_id) VALUES (${input.projectId}, ${input.action.id}, ${input.action.initiativeId})`;
          if (input.action.type === "initiative.archive") {
            const id = input.action.id;
            const initiative = state.initiatives.find((i) => i.id === id)!;
            const tasks = state.tasks.filter((t) => t.initiativeId === id);
            const payload = yield* encodeArchive({ initiative, tasks });
            yield* sql`INSERT INTO project_teamwork_archive (project_id, initiative_id, revision, archived_at, title, status, task_count, payload_json)
              VALUES (${input.projectId}, ${id}, ${snapshot.revision}, ${now}, ${initiative.title}, ${initiative.status}, ${tasks.length}, ${payload})`;
          }
          if (input.action.type === "initiative.restore")
            yield* sql`DELETE FROM project_teamwork_archive WHERE project_id = ${input.projectId} AND initiative_id = ${input.action.id}`;
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
    conversationQuery: conversations.query,
    observeConversationEvent: observe,
    bindImplementationDestination: Effect.fn("TeamworkService.bindImplementationDestination")(
      function* (projectId, taskId, attemptId, destination, actor) {
        yield* authorize(projectId, actor);
        yield* locks.withLock(
          projectId,
          sql.withTransaction(
            Effect.gen(function* () {
              const state = yield* load(projectId);
              const task = state.tasks.find((t) => t.id === taskId && t.delegationId === attemptId);
              if (state.coordinatorThreadId !== actor || task?.status !== "delegating")
                return yield* new TeamworkError({
                  reason: "invalid-state",
                  message: "Only the coordinator can bind the current implementation reservation.",
                });
              const id = yield* encodeDestinationKey([taskId, attemptId]);
              const value = destination ?? "";
              const rows = yield* sql<{
                thread_id: string;
              }>`SELECT thread_id FROM project_crew_conversations WHERE project_id = ${projectId} AND collection = 'implementation-destinations' AND id = ${id}`;
              if (rows[0] && rows[0].thread_id !== value)
                return yield* new TeamworkError({
                  reason: "conflict",
                  message:
                    "This reserved attempt already selected a different implementation destination. Preserve the destination when retrying.",
                });
              yield* sql`INSERT INTO project_crew_conversations VALUES (${projectId}, 'implementation-destinations', ${id}, ${value}, '{}') ON CONFLICT DO NOTHING`;
            }),
          ),
        );
      },
      Effect.mapError(storageError),
    ),
    conversationCommand: Effect.fn("TeamworkService.conversationCommand")((input, actor) =>
      conversations
        .command(input, actor)
        .pipe(Effect.tap(() => worker.enqueue(input.scope.projectId))),
    ),
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
