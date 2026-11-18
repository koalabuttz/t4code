import {
  CommandId,
  MessageId,
  TeamworkError,
  isRuntimeModeAbove,
  type EnvironmentId,
  type IsoDateTime,
  type ProjectId,
  type RunId,
  type ThreadId,
  type TeamworkSnapshot,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import {
  CrewWorkstream,
  CrewWorkstreamTaskLink,
  CrewConsultation,
  CrewHandoff,
  CrewAttention,
  CrewConversationCommand,
  CrewConversationQuery,
  CrewConversationPage,
  type CrewMessageRef,
  type CrewConversationContext,
  type CrewConversationRef,
  type CrewTaskAssignmentRef,
} from "@t3tools/contracts/crewConversation";
import {
  crewConsultationRequestProblem,
  observeCrewConsultation,
  retryCrewConsultation,
  shouldRecordCrewAttention,
  sameCrewProject,
  sameCrewConversation,
} from "@t3tools/shared/crewConversation";
import type { KeyedLock } from "@t3tools/shared/KeyedLock";
import { latestExecutedRun } from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { DispatchModeLimit, type DispatchModes } from "../orchestration-v2/DispatchModeLimit.ts";
import * as Result from "effect/Result";

const fail = (message: string, reason: TeamworkError["reason"] = "invalid-state") =>
  new TeamworkError({ reason, message });
export const teamworkDeliveryCommandId = (deliveryId: string, retryId?: string | null) =>
  CommandId.make(`teamwork:${deliveryId}${retryId == null ? "" : `:retry:${retryId}`}`);
const isTeamworkError = Schema.is(TeamworkError);
const storageError = (cause: unknown) =>
  isTeamworkError(cause) ? cause : fail("Could not access Crew conversations.", "storage");
const Entry = Schema.Union([
  CrewWorkstream,
  CrewWorkstreamTaskLink,
  CrewConsultation,
  CrewHandoff,
  CrewAttention,
]);
const encodeEntry = Schema.encodeEffect(Schema.fromJsonString(Entry));
const decodeCommand = Schema.decodeUnknownEffect(CrewConversationCommand);
const decodeQuery = Schema.decodeUnknownEffect(CrewConversationQuery);
const encodeCommand = Schema.encodeEffect(Schema.fromJsonString(CrewConversationCommand));
const encodeState = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodePage = Schema.decodeUnknownEffect(CrewConversationPage);

export const makeCrewConversations = Effect.fn("CrewConversations.make")(function* (deps: {
  readonly environmentId: EnvironmentId;
  readonly threads: Threads.ThreadManagementService["Service"];
  readonly locks: KeyedLock<ProjectId>;
  readonly load: (projectId: ProjectId) => Effect.Effect<TeamworkSnapshot, TeamworkError>;
  readonly authorize: (
    projectId: ProjectId,
    actor: ThreadId | null,
  ) => Effect.Effect<DispatchModes | null, TeamworkError>;
  readonly requireThread: (
    projectId: ProjectId,
    id: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadShell, TeamworkError>;
  readonly requireStopped: (ids: ReadonlyArray<ThreadId>) => Effect.Effect<void, TeamworkError>;
  readonly changed: (projectId: ProjectId) => Effect.Effect<unknown>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const scope = (projectId: ProjectId) => ({ environmentId: deps.environmentId, projectId });
  const ref = (projectId: ProjectId, threadId: ThreadId): CrewConversationRef => ({
    ...scope(projectId),
    threadId,
  });
  const messageRef = (
    projectId: ProjectId,
    message: OrchestrationV2ConversationMessage,
  ): CrewMessageRef => ({
    conversation: ref(projectId, message.threadId),
    messageId: message.id,
    runId: message.runId,
    actor:
      message.role === "assistant" || message.createdBy === "agent"
        ? "agent"
        : message.role === "system"
          ? "system"
          : "user",
    sender: message.senderThreadId === undefined ? null : ref(projectId, message.senderThreadId),
  });
  const get = Effect.fn("CrewConversations.get")(function* <A, I>(
    projectId: ProjectId,
    collection: string,
    id: string,
    schema: Schema.Codec<A, I>,
  ) {
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM project_crew_conversations WHERE project_id = ${projectId} AND collection = ${collection} AND id = ${id}`;
    return rows[0]
      ? yield* Schema.decodeEffect(Schema.fromJsonString(schema))(rows[0].payload_json)
      : null;
  });
  const put = Effect.fn("CrewConversations.put")(function* (
    projectId: ProjectId,
    collection: string,
    id: string,
    threadId: ThreadId,
    entry: typeof Entry.Type,
  ) {
    const payload = yield* encodeEntry(entry);
    yield* sql`INSERT INTO project_crew_conversations (project_id, collection, id, thread_id, payload_json)
      VALUES (${projectId}, ${collection}, ${id}, ${threadId}, ${payload})
      ON CONFLICT (project_id, collection, id) DO UPDATE SET thread_id = excluded.thread_id, payload_json = excluded.payload_json`;
  });
  const canonical = Effect.fn("CrewConversations.canonical")(function* (
    projectId: ProjectId,
    source: CrewMessageRef,
  ) {
    if (
      !sameCrewProject(scope(projectId), source.conversation) ||
      (source.sender !== null && !sameCrewProject(scope(projectId), source.sender))
    )
      return yield* fail(
        "Conversation sources must belong to this environment and project.",
        "forbidden",
      );
    const thread = yield* deps.requireThread(projectId, source.conversation.threadId);
    if (thread.linkOrigin != null)
      return yield* fail(
        "Linked environment sources require their authoritative source access.",
        "forbidden",
      );
    const messages = yield* deps.threads.getMessagesById(thread.id, [source.messageId]);
    const message = messages.get(source.messageId);
    if (
      !message ||
      message.streaming ||
      (yield* encodeState(messageRef(projectId, message))) !== (yield* encodeState(source))
    )
      return yield* fail(
        "The canonical source message or its attribution does not match.",
        "forbidden",
      );
    return message;
  });
  const context = Effect.fn("CrewConversations.context")(function* (
    projectId: ProjectId,
    value: CrewConversationContext,
  ) {
    for (const source of [...value.sources, ...(value.replyTo === null ? [] : [value.replyTo])])
      yield* canonical(projectId, source);
    for (const attachment of value.attachments) {
      const message = yield* canonical(projectId, attachment.message);
      if (!message.attachments.some((item) => item.id === attachment.attachmentId))
        return yield* fail(
          "The attachment is not part of its authorized source message.",
          "forbidden",
        );
    }
  });
  const participating = Effect.fn("CrewConversations.participating")(function* (
    state: TeamworkSnapshot,
    threadId: ThreadId,
  ) {
    if (state.coordinatorThreadId === threadId) return;
    const member = yield* get(state.projectId, "workstreams", threadId, CrewWorkstream);
    if (!member || member.status === "unlinked")
      return yield* fail(
        "Explicitly link this conversation before using Crew consultations.",
        "forbidden",
      );
  });
  const ownershipGuard = Effect.fn("CrewConversations.ownershipGuard")(function* (
    state: TeamworkSnapshot,
    threadId: ThreadId,
  ) {
    if (
      state.tasks.some(
        (task) => task.ownerThreadId === threadId && !["done", "cancelled"].includes(task.status),
      )
    )
      return yield* fail("Reconcile the active assignment before changing workstream membership.");
    const stops =
      yield* sql`SELECT id FROM project_teamwork_outbox WHERE project_id = ${state.projectId}
      AND thread_id = ${threadId} AND kind = 'stop' AND status IN ('pending', 'failed') LIMIT 1`;
    if (stops.length)
      return yield* fail("Resolve the outstanding stop before changing workstream membership.");
    yield* deps.requireStopped([threadId]);
  });
  const findConfirmedHandoffStop = Effect.fn("CrewConversations.findConfirmedHandoffStop")(
    function* (projectId: ProjectId, handoffId: string, assignment: CrewTaskAssignmentRef) {
      const proposals = yield* sql<{ revision: number }>`
        SELECT revision FROM project_teamwork_events WHERE project_id = ${projectId}
        AND json_extract(action_json, '$.type') = 'crew.conversation'
        AND json_extract(json_extract(action_json, '$.command'), '$.action.type')
          IN ('handoff.propose', 'handoff.propose-from-attention')
        AND json_extract(json_extract(action_json, '$.command'), '$.action.id') = ${handoffId}
        ORDER BY revision DESC LIMIT 1`;
      const proposalRevision = proposals[0]?.revision;
      if (proposalRevision === undefined) return;
      // The proposal validates the exact attempt. A later assignment can reuse its thread.
      const replacements = yield* sql<{ revision: number }>`
        SELECT revision FROM project_teamwork_events WHERE project_id = ${projectId}
        AND revision > ${proposalRevision}
        AND json_extract(action_json, '$.type') = 'task.assign'
        AND json_extract(action_json, '$.id') = ${assignment.taskId}
        ORDER BY revision LIMIT 1`;
      const attemptEnd = replacements[0]?.revision ?? Number.MAX_SAFE_INTEGER;
      const stops = yield* sql<{ id: string; revision: number; retry_id: string | null }>`
        SELECT id, revision, json_extract(payload_json, '$.stopCommandId') AS retry_id
        FROM project_teamwork_outbox WHERE project_id = ${projectId}
        AND thread_id = ${assignment.owner.threadId} AND kind = 'stop' AND status = 'delivered'
        AND json_extract(payload_json, '$.initiativeId') = ${assignment.initiativeId}
        AND json_extract(payload_json, '$.taskId') = ${assignment.taskId}
        AND revision >= ${proposalRevision} AND revision < ${attemptEnd}
        ORDER BY revision, id`;
      if (stops.length === 0) return;
      const { runs } = yield* deps.threads.getThreadRecords(assignment.owner.threadId, ["runs"]);
      if (runs.some((run) => run.status === "queued" && !run.queueHeld)) return;

      // An older delivery can be retried after a newer Stop has already reached the worker.
      let firstStop:
        | { stopDeliveryId: CommandId; firstSequence: number; runIds: ReadonlyArray<RunId> }
        | undefined;
      for (const stop of stops) {
        // A retry may confirm that a run stopped after an earlier dispatch's confirmation failed.
        const retries =
          stop.retry_id === null
            ? []
            : yield* sql<{ command_id: string }>`
              SELECT command_id FROM project_teamwork_events WHERE project_id = ${projectId}
              AND revision > ${stop.revision} AND revision < ${attemptEnd}
              AND revision <= (SELECT revision FROM project_teamwork_events
                WHERE project_id = ${projectId} AND command_id = ${stop.retry_id})
              AND json_extract(action_json, '$.type') = 'delivery.retry'
              AND json_extract(action_json, '$.id') = ${stop.id}
              ORDER BY revision`;
        for (const retryId of [null, ...retries.map((retry) => retry.command_id)]) {
          const evidence = yield* deps.threads.getStopRunEvidence({
            threadId: assignment.owner.threadId,
            commandId: teamworkDeliveryCommandId(stop.id, retryId),
          });
          if (evidence && (!firstStop || evidence.firstSequence < firstStop.firstSequence))
            firstStop = { ...evidence, stopDeliveryId: CommandId.make(stop.id) };
        }
      }
      if (!firstStop) return;
      const { runIds, stopDeliveryId } = firstStop;
      const run = latestExecutedRun(runs.filter((candidate) => runIds.includes(candidate.id)));
      if (
        run &&
        ["completed", "cancelled", "interrupted", "failed", "rolled_back"].includes(run.status)
      )
        return { stopDeliveryId, stoppedRunId: run.id };
    },
  );
  const outbox = Effect.fn("CrewConversations.outbox")(function* (
    projectId: ProjectId,
    revision: number,
    id: CommandId,
    threadId: ThreadId,
    kind: string,
    payload: unknown,
  ) {
    yield* sql`INSERT INTO project_teamwork_outbox (id, project_id, revision, thread_id, kind, status, payload_json)
      VALUES (${id}, ${projectId}, ${revision}, ${threadId}, ${kind}, 'pending', ${yield* encodeState(payload)})`;
  });
  const commit = Effect.fn("CrewConversations.commit")(function* (
    state: TeamworkSnapshot,
    commandId: CommandId,
    actor: ThreadId | null,
    actionJson: string,
    now: IsoDateTime,
  ) {
    const revision = state.revision + 1;
    const payload = yield* encodeState({ ...state, revision });
    yield* sql`INSERT INTO project_teamwork (project_id, revision, payload_json) VALUES (${state.projectId}, ${revision}, ${payload})
      ON CONFLICT(project_id) DO UPDATE SET revision = excluded.revision, payload_json = excluded.payload_json`;
    yield* sql`INSERT INTO project_teamwork_events (project_id, revision, command_id, actor_thread_id, action_json, created_at)
      VALUES (${state.projectId}, ${revision}, ${commandId}, ${actor}, ${actionJson}, ${now})`;
    return { commandId, revision };
  });
  const command = Effect.fn("CrewConversations.command")(function* (
    raw: CrewConversationCommand,
    actor: ThreadId | null = null,
  ) {
    const input = yield* decodeCommand(raw);
    const projectId = input.scope.projectId;
    if (!sameCrewProject(input.scope, scope(projectId)))
      return yield* fail("Choose this environment's project.", "forbidden");
    const limit = yield* deps.authorize(projectId, actor);
    if (limit?.interactionMode === "plan")
      return yield* fail(
        "Switch out of Plan mode before changing Crew conversations.",
        "forbidden",
      );
    const receipt = yield* deps.locks.withLock(
      projectId,
      sql.withTransaction(
        Effect.gen(function* () {
          const actionJson = yield* encodeState({
            type: "crew.conversation",
            command: yield* encodeCommand(input),
          });
          const previous = yield* sql<{
            revision: number;
            actor_thread_id: string | null;
            action_json: string;
          }>`SELECT revision, actor_thread_id, action_json FROM project_teamwork_events WHERE project_id = ${projectId} AND command_id = ${input.commandId}`;
          if (previous[0]) {
            if (previous[0].actor_thread_id !== actor || previous[0].action_json !== actionJson)
              return yield* fail("Command id already belongs to a different request.", "conflict");
            return { commandId: input.commandId, revision: previous[0].revision };
          }
          const state = yield* deps.load(projectId);
          if (state.revision !== input.expectedRevision)
            return yield* fail("Crew changed. Refresh and retry.", "conflict");
          if (state.coordinatorThreadId === null)
            return yield* fail("Establish the project coordinator explicitly first.");
          if (actor !== null && actor !== state.coordinatorThreadId)
            return yield* fail(
              "Only the coordinator or user manages Crew conversations.",
              "forbidden",
            );
          const now = DateTime.formatIso(yield* DateTime.now);
          let action: Exclude<
            CrewConversationCommand["action"],
            { type: "handoff.propose-from-attention" | "consultation.request-from-message" }
          >;
          if (input.action.type === "consultation.request-from-message") {
            const request = input.action;
            const originThreadId = request.originThreadId ?? actor;
            if (originThreadId === null)
              return yield* fail("Choose the conversation where the question was asked.");
            const conversation = yield* deps.requireThread(projectId, originThreadId);
            if (conversation.linkOrigin != null)
              return yield* fail(
                "Linked environment sources require their authoritative source access.",
                "forbidden",
              );
            const isQuestion = (message: OrchestrationV2ConversationMessage) =>
              message.threadId === conversation.id &&
              message.role === "user" &&
              message.createdBy === "user" &&
              message.senderThreadId === undefined &&
              !message.streaming;
            let message: OrchestrationV2ConversationMessage | undefined;
            if (request.originMessageId !== undefined) {
              message = (yield* deps.threads.getMessagesById(conversation.id, [
                request.originMessageId,
              ])).get(request.originMessageId);
            } else if (actor === conversation.id && conversation.activeRunId) {
              // Only an unambiguous question in the caller's current run can supply the origin.
              const { messages } = yield* deps.threads.getThreadRecords(
                conversation.id,
                ["messages"],
                {
                  messageRunIds: [conversation.activeRunId],
                  messageRoles: ["user"],
                },
              );
              const questions = messages.filter(isQuestion);
              if (questions.length === 1) message = questions[0];
            }
            if (!message || !isQuestion(message))
              return yield* fail(
                "Choose the exact user message that asks the question.",
                "forbidden",
              );
            const origin = messageRef(projectId, message);
            action = {
              type: "consultation.request",
              request: {
                id: request.id,
                origin,
                destination: ref(projectId, request.destinationThreadId),
                context: {
                  replyTo: null,
                  sources: [],
                  attachments: message.attachments.map(({ id }) => ({
                    message: origin,
                    attachmentId: id,
                  })),
                },
                replyTo: request.replyTo ?? null,
              },
            };
          } else if (input.action.type === "handoff.propose-from-attention") {
            const proposal = input.action;
            const attention = yield* get(
              projectId,
              "attention",
              proposal.attentionId,
              CrewAttention,
            );
            if (
              !attention ||
              attention.reason !== "user-message" ||
              !sameCrewConversation(
                attention.coordinator,
                ref(projectId, state.coordinatorThreadId),
              )
            )
              return yield* fail("Choose a direct message recorded for the current coordinator.");
            const origin = attention.source;
            yield* canonical(projectId, origin);
            const sourceThreadId = origin.conversation.threadId;
            const explanation = (yield* deps.threads.getMessagesById(sourceThreadId, [
              proposal.explanationMessageId,
            ])).get(proposal.explanationMessageId);
            if (!explanation || explanation.senderThreadId !== state.coordinatorThreadId)
              return yield* fail("Send a visible explanation to the source thread first.");
            const task =
              proposal.taskId === undefined
                ? null
                : state.tasks.find((candidate) => candidate.id === proposal.taskId);
            if (
              proposal.taskId !== undefined &&
              (!task ||
                task.ownerThreadId !== sourceThreadId ||
                task.delegationId === null ||
                ["done", "cancelled"].includes(task.status))
            )
              return yield* fail("Choose the current assignment in the source work thread.");
            action = {
              type: "handoff.propose",
              id: proposal.id,
              origin,
              destination: ref(projectId, proposal.destinationThreadId),
              explanation: messageRef(projectId, explanation),
              context: { replyTo: null, sources: [], attachments: [] },
              consultationId: proposal.consultationId ?? null,
              assignment:
                task?.delegationId != null
                  ? {
                      initiativeId: task.initiativeId,
                      taskId: task.id,
                      attemptId: task.delegationId,
                      owner: origin.conversation,
                    }
                  : null,
            };
          } else {
            action = input.action;
          }
          const deliveryId = CommandId.make(`crew:${projectId}:${input.commandId}`);
          switch (action.type) {
            case "workstream.link": {
              const thread = yield* deps.requireThread(projectId, action.threadId);
              if (thread.id === state.coordinatorThreadId || thread.linkOrigin != null)
                return yield* fail("Choose a local app-owned work thread.");
              const current = yield* get(projectId, "workstreams", thread.id, CrewWorkstream);
              if (current?.status === "unlinked") yield* ownershipGuard(state, thread.id);
              yield* put(projectId, "workstreams", thread.id, thread.id, {
                conversation: ref(projectId, thread.id),
                title: action.title,
                status: current?.status === "resolved" ? "resolved" : "open",
                linkedAt: current?.linkedAt ?? now,
                updatedAt: now,
              });
              break;
            }
            case "workstream.status": {
              const current = yield* get(projectId, "workstreams", action.threadId, CrewWorkstream);
              if (!current) return yield* fail("Workstream not found.", "not-found");
              if (current.status !== action.status) yield* ownershipGuard(state, action.threadId);
              yield* put(projectId, "workstreams", action.threadId, action.threadId, {
                ...current,
                status: action.status,
                updatedAt: now,
              });
              break;
            }
            case "workstream.task": {
              const task = state.tasks.find(
                (task) => task.id === action.taskId && task.initiativeId === action.initiativeId,
              );
              if (!task) return yield* fail("Task not found.", "not-found");
              if (action.threadId !== null) yield* participating(state, action.threadId);
              const current = yield* get(projectId, "task-links", task.id, CrewWorkstreamTaskLink);
              if (current && current.workstream.threadId !== action.threadId)
                yield* ownershipGuard(state, current.workstream.threadId);
              if (action.threadId === null)
                yield* sql`DELETE FROM project_crew_conversations WHERE project_id = ${projectId} AND collection = 'task-links' AND id = ${task.id}`;
              else
                yield* put(projectId, "task-links", task.id, action.threadId, {
                  workstream: ref(projectId, action.threadId),
                  taskId: task.id,
                  initiativeId: task.initiativeId,
                });
              break;
            }
            case "consultation.request": {
              const request = action.request;
              if (yield* get(projectId, "consultations", request.id, CrewConsultation))
                return yield* fail("Consultation id already exists.", "conflict");
              const pending = yield* sql<{
                count: number;
              }>`SELECT count(*) AS count FROM project_crew_conversations WHERE project_id = ${projectId} AND collection = 'consultations' AND json_extract(payload_json, '$.progress.state') IN ('queued','delivered')`;
              if ((pending[0]?.count ?? 0) >= 12)
                return yield* fail(
                  "Wait for pending consultations before requesting more expertise.",
                  "capacity",
                );
              yield* canonical(projectId, request.origin);
              yield* context(projectId, request.context);
              yield* participating(state, request.origin.conversation.threadId);
              const member = yield* get(
                projectId,
                "workstreams",
                request.destination.threadId,
                CrewWorkstream,
              );
              const previous =
                request.replyTo === null
                  ? null
                  : yield* get(
                      projectId,
                      "consultations",
                      request.replyTo.consultationId,
                      CrewConsultation,
                    );
              if (
                !member ||
                crewConsultationRequestProblem(scope(projectId), request, member, previous)
              )
                return yield* fail("Consultation scope, destination or reply does not match.");
              yield* put(projectId, "consultations", request.id, request.destination.threadId, {
                ...request,
                deliveryId,
                progress: { state: "queued" },
                createdAt: now,
                updatedAt: now,
              });
              yield* outbox(
                projectId,
                state.revision + 1,
                deliveryId,
                request.destination.threadId,
                "crew-consultation",
                { id: request.id, actor, limit },
              );
              break;
            }
            case "consultation.retry": {
              const current = yield* get(projectId, "consultations", action.id, CrewConsultation);
              const next =
                current === null
                  ? null
                  : retryCrewConsultation(current, action.previousDeliveryId, deliveryId, now);
              if (!next?.accepted)
                return yield* fail("Only the exact failed consultation delivery can be retried.");
              const authority = yield* requestDelivery(projectId, action.previousDeliveryId);
              if (actor !== null && authority.actor !== actor)
                return yield* fail(
                  "Only the original coordinator or the user can retry this delivery.",
                  "forbidden",
                );
              yield* put(
                projectId,
                "consultations",
                action.id,
                next.consultation.destination.threadId,
                next.consultation,
              );
              yield* outbox(
                projectId,
                state.revision + 1,
                deliveryId,
                next.consultation.destination.threadId,
                "crew-consultation",
                authority,
              );
              break;
            }
            case "consultation.cancel": {
              const current = yield* get(projectId, "consultations", action.id, CrewConsultation);
              if (!current || current.progress.state === "answered")
                return yield* fail("This consultation cannot be cancelled.");
              yield* put(projectId, "consultations", action.id, current.destination.threadId, {
                ...current,
                progress: { state: "cancelled" },
                updatedAt: now,
              });
              yield* sql`UPDATE project_teamwork_outbox SET status = 'cancelled' WHERE project_id = ${projectId} AND id = ${current.deliveryId} AND status IN ('pending','failed')`;
              break;
            }
            case "handoff.propose": {
              if (yield* get(projectId, "handoffs", action.id, CrewHandoff))
                return yield* fail("Handoff already exists.", "conflict");
              if (!sameCrewProject(scope(projectId), action.destination))
                return yield* fail(
                  "Handoff destination must belong to this environment and project.",
                  "forbidden",
                );
              yield* canonical(projectId, action.origin);
              const explanation = yield* canonical(projectId, action.explanation);
              yield* context(projectId, action.context);
              yield* participating(state, action.origin.conversation.threadId);
              yield* participating(state, action.destination.threadId);
              if (
                !sameCrewConversation(
                  action.origin.conversation,
                  action.explanation.conversation,
                ) ||
                explanation.senderThreadId !== state.coordinatorThreadId ||
                action.destination.threadId === action.origin.conversation.threadId
              )
                return yield* fail("The origin needs a visible explanation from its coordinator.");
              if (action.assignment !== null) {
                const a = action.assignment;
                const task = state.tasks.find(
                  (task) => task.id === a.taskId && task.initiativeId === a.initiativeId,
                );
                if (
                  !task ||
                  task.ownerThreadId !== a.owner.threadId ||
                  task.delegationId !== a.attemptId ||
                  !sameCrewProject(scope(projectId), a.owner)
                )
                  return yield* fail("Handoff assignment does not match authoritative ownership.");
              } else if (
                state.tasks.some(
                  (task) =>
                    task.ownerThreadId === action.origin.conversation.threadId &&
                    !["done", "cancelled"].includes(task.status),
                )
              )
                return yield* fail("An implementation handoff must name its current assignment.");
              if (action.consultationId !== null) {
                const consultation = yield* get(
                  projectId,
                  "consultations",
                  action.consultationId,
                  CrewConsultation,
                );
                if (
                  !consultation ||
                  !sameCrewConversation(
                    consultation.origin.conversation,
                    action.origin.conversation,
                  ) ||
                  consultation.origin.messageId !== action.origin.messageId ||
                  !sameCrewConversation(consultation.destination, action.destination)
                )
                  return yield* fail("Handoff consultation must return to its exact origin.");
              }
              yield* put(projectId, "handoffs", action.id, action.origin.conversation.threadId, {
                ...action,
                ownership:
                  action.assignment === null
                    ? { state: "discussion-only" }
                    : { state: "required", assignment: action.assignment, stopDeliveryId: null },
                state: action.assignment === null ? "ready" : "proposed",
                createdAt: now,
                updatedAt: now,
              });
              break;
            }
            case "handoff.complete":
            case "handoff.cancel": {
              const current = yield* get(projectId, "handoffs", action.id, CrewHandoff);
              if (!current || current.state === "cancelled")
                return yield* fail("Handoff unavailable.");
              if (action.type === "handoff.complete") {
                yield* ownershipGuard(state, current.origin.conversation.threadId);
                if (
                  current.ownership.state !== "discussion-only" &&
                  current.ownership.state !== "reconciled"
                ) {
                  const assignment = current.ownership.assignment;
                  yield* ownershipGuard(state, assignment.owner.threadId);
                  const confirmation = yield* findConfirmedHandoffStop(
                    projectId,
                    current.id,
                    assignment,
                  );
                  if (!confirmation)
                    return yield* fail(
                      "The exact assignment needs confirmed stop evidence before the handoff can complete.",
                    );
                  yield* put(
                    projectId,
                    "handoffs",
                    action.id,
                    current.origin.conversation.threadId,
                    {
                      ...current,
                      ownership: {
                        state: "reconciled",
                        assignment,
                        ...confirmation,
                        reconciledRevision: state.revision,
                      },
                      state: "completed",
                      updatedAt: now,
                    },
                  );
                  break;
                }
              }
              yield* put(projectId, "handoffs", action.id, current.origin.conversation.threadId, {
                ...current,
                state: action.type === "handoff.cancel" ? "cancelled" : "completed",
                updatedAt: now,
              });
              break;
            }
            case "attention.retry": {
              const current = yield* get(projectId, "attention", action.id, CrewAttention);
              if (
                current?.progress.state !== "failed" ||
                current.progress.deliveryId !== action.previousDeliveryId
              )
                return yield* fail("Retry only the exact failed coordinator delivery.");
              yield* put(projectId, "attention", current.id, current.source.conversation.threadId, {
                ...current,
                coordinator: ref(projectId, state.coordinatorThreadId),
                progress: { state: "queued", deliveryId },
                updatedAt: now,
              });
              yield* outbox(
                projectId,
                state.revision + 1,
                deliveryId,
                state.coordinatorThreadId,
                "crew-attention",
                { id: current.id, actor, limit },
              );
              break;
            }
          }
          return yield* commit(state, input.commandId, actor, actionJson, now);
        }),
      ),
    );
    yield* deps.changed(projectId);
    return receipt;
  }, Effect.mapError(storageError));

  const query = Effect.fn("CrewConversations.query")(function* (
    raw: CrewConversationQuery,
    actor: ThreadId | null = null,
  ) {
    const input = yield* decodeQuery(raw);
    if (!sameCrewProject(input.scope, scope(input.scope.projectId)))
      return yield* fail("Choose this environment's project.", "forbidden");
    const projectId = input.scope.projectId;
    yield* deps.authorize(projectId, actor);
    const state = yield* deps.load(projectId);
    if (
      input.messageIds !== undefined &&
      (input.threadId === undefined ||
        (input.collection !== "consultations" && input.collection !== "handoffs"))
    )
      return yield* fail("Select a conversation and its consultation or handoff messages.");
    if (actor !== null && actor !== state.coordinatorThreadId) {
      yield* participating(state, actor);
      if (input.threadId !== actor)
        return yield* fail(
          "Workers read their own conversation coordination records.",
          "forbidden",
        );
    }
    const limit = input.limit ?? 40;
    const rows = yield* input.messageIds === undefined
      ? sql<{
          id: string;
          payload_json: string;
        }>`SELECT id, payload_json FROM project_crew_conversations
          WHERE project_id = ${projectId} AND collection = ${input.collection} AND id > ${input.cursor ?? ""}
          AND (${input.id ?? null} IS NULL OR id = ${input.id ?? null})
          AND (${input.threadId ?? null} IS NULL OR thread_id = ${input.threadId ?? null}
            OR json_extract(payload_json, '$.origin.conversation.threadId') = ${input.threadId ?? null})
          ORDER BY id LIMIT ${limit + 1}`
      : Effect.gen(function* () {
          const messageIds = yield* encodeState(input.messageIds);
          // UNION ordering can otherwise make SQLite scan the collection's primary-key range.
          const origin = sql`SELECT id FROM project_crew_conversations INDEXED BY project_crew_conversations_origin_message
            WHERE project_id = ${projectId} AND collection = ${input.collection}
            AND json_extract(payload_json, '$.origin.conversation.threadId') = ${input.threadId ?? null}
            AND json_extract(payload_json, '$.origin.messageId') IN (SELECT value FROM json_each(${messageIds}))
            AND id > ${input.cursor ?? ""}
            AND (${input.id ?? null} IS NULL OR id = ${input.id ?? null})
            AND json_extract(payload_json, '$.origin.conversation.environmentId') = ${input.scope.environmentId}
            AND json_extract(payload_json, '$.origin.conversation.projectId') = ${projectId}`;
          const selected =
            input.collection === "handoffs"
              ? sql`${origin} UNION SELECT id FROM project_crew_conversations INDEXED BY project_crew_conversations_explanation_message
                WHERE project_id = ${projectId} AND collection = ${input.collection}
                AND json_extract(payload_json, '$.explanation.conversation.threadId') = ${input.threadId ?? null}
                AND json_extract(payload_json, '$.explanation.messageId') IN (SELECT value FROM json_each(${messageIds}))
                AND id > ${input.cursor ?? ""}
                AND (${input.id ?? null} IS NULL OR id = ${input.id ?? null})
                AND json_extract(payload_json, '$.explanation.conversation.environmentId') = ${input.scope.environmentId}
                AND json_extract(payload_json, '$.explanation.conversation.projectId') = ${projectId}
                AND json_extract(payload_json, '$.origin.conversation.threadId') = ${input.threadId ?? null}
                AND json_extract(payload_json, '$.origin.conversation.environmentId') = ${input.scope.environmentId}
                AND json_extract(payload_json, '$.origin.conversation.projectId') = ${projectId}`
              : origin;
          return yield* sql<{
            id: string;
            payload_json: string;
          }>`SELECT id, payload_json FROM project_crew_conversations
            WHERE project_id = ${projectId} AND collection = ${input.collection} AND id IN (${selected})
            ORDER BY id LIMIT ${limit + 1}`;
        });
    const entries = yield* Effect.forEach(rows.slice(0, limit), (row) =>
      decodeJson(row.payload_json),
    );
    return yield* decodePage({
      workstreams: [],
      taskLinks: [],
      consultations: [],
      handoffs: [],
      attention: [],
      scope: input.scope,
      revision: state.revision,
      [input.collection === "task-links" ? "taskLinks" : input.collection]: entries,
      nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
    });
  }, Effect.mapError(storageError));

  const deliveryPayload = Schema.Struct({
    id: Schema.String,
    actor: Schema.NullOr(Schema.String),
    limit: Schema.NullOr(
      Schema.Struct({
        runtimeMode: Schema.Literals([
          "approval-required",
          "auto-accept-edits",
          "auto",
          "full-access",
        ]),
        interactionMode: Schema.Literals(["plan", "default"]),
      }),
    ),
  });
  const decodeDelivery = Schema.decodeEffect(Schema.fromJsonString(deliveryPayload));
  const requestDelivery = Effect.fn("CrewConversations.requestDelivery")(function* (
    projectId: ProjectId,
    deliveryId: CommandId,
  ) {
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM project_teamwork_outbox
      WHERE project_id = ${projectId} AND id = ${deliveryId} AND kind = 'crew-consultation'`;
    if (!rows[0])
      return yield* fail("Consultation delivery authority is unavailable.", "forbidden");
    return yield* decodeDelivery(rows[0].payload_json);
  });
  const deliver = Effect.fn("CrewConversations.deliver")(function* (row: {
    id: string;
    project_id: ProjectId;
    thread_id: ThreadId;
    kind: string;
    payload_json: string;
  }) {
    const projectId = row.project_id;
    yield* deps.locks.withLock(
      projectId,
      Effect.gen(function* () {
        const active = yield* sql<{
          status: string;
        }>`SELECT status FROM project_teamwork_outbox WHERE id = ${row.id} AND project_id = ${projectId}`;
        if (active[0]?.status !== "pending") return;
        const storedPayload = yield* decodeDelivery(row.payload_json);
        const state = yield* deps.load(projectId);
        const consultation =
          row.kind === "crew-attention"
            ? null
            : yield* get(projectId, "consultations", storedPayload.id, CrewConsultation);
        const attention =
          row.kind === "crew-attention"
            ? yield* get(projectId, "attention", storedPayload.id, CrewAttention)
            : null;
        const now = DateTime.formatIso(yield* DateTime.now);
        if (
          row.kind === "crew-consultation" &&
          consultation?.deliveryId === row.id &&
          ["delivered", "answered"].includes(consultation.progress.state)
        ) {
          yield* sql`UPDATE project_teamwork_outbox SET status = 'delivered' WHERE id = ${row.id}`;
          return;
        }
        const outcome = yield* Effect.result(
          Effect.gen(function* () {
            const payload =
              row.kind === "crew-return" && consultation
                ? yield* requestDelivery(projectId, consultation.deliveryId)
                : storedPayload;
            yield* deps.requireThread(projectId, row.thread_id);
            if (payload.actor !== null) yield* deps.authorize(projectId, payload.actor as ThreadId);
            const members = state.tasks.filter(
              (task) =>
                task.ownerThreadId === row.thread_id ||
                task.ownerThreadId === consultation?.destination.threadId,
            );
            const paused = members.some((task) =>
              state.initiatives.some(
                (i) => i.id === task.initiativeId && ["paused", "cancelled"].includes(i.status),
              ),
            );
            if (
              paused ||
              (state.initiatives.some((i) => i.status === "paused") &&
                !state.initiatives.some((i) => i.status === "active"))
            )
              return yield* fail(
                "Crew work is paused. Explicitly resume it before starting a consultation or coordinator turn.",
              );
            const stops =
              yield* sql`SELECT id FROM project_teamwork_outbox WHERE project_id = ${projectId} AND thread_id = ${row.thread_id} AND kind = 'stop' AND status IN ('pending','failed') LIMIT 1`;
            if (stops.length)
              return yield* fail("An outstanding stop prevents this conversation delivery.");
            let text: string;
            let senderThreadId: ThreadId;
            let attachments: OrchestrationV2ConversationMessage["attachments"] = [];
            if (
              row.kind === "crew-consultation" &&
              consultation !== null &&
              consultation.deliveryId === row.id &&
              consultation.progress.state === "queued"
            ) {
              yield* participating(state, consultation.destination.threadId);
              yield* participating(state, consultation.origin.conversation.threadId);
              const origin = yield* canonical(projectId, consultation.origin);
              yield* context(projectId, consultation.context);
              const sources = yield* Effect.forEach(consultation.context.sources, (source) =>
                canonical(projectId, source),
              );
              attachments = (yield* Effect.forEach(consultation.context.attachments, (attachment) =>
                canonical(projectId, attachment.message).pipe(
                  Effect.map((message) =>
                    message.attachments.filter((item) => item.id === attachment.attachmentId),
                  ),
                ),
              )).flat();
              text = `Crew consultation ${consultation.id}. Answer this question using this workstream's expertise. This is discussion, not an implementation assignment; do not resume, change or replace tasks. Your canonical answer returns to the originating conversation.\nOrigin: ${yield* encodeState(consultation.origin)}\n${origin.text.slice(0, 6000)}\nSources: ${sources
                .map((s) => s.text.slice(0, 1000))
                .join("\n")
                .slice(0, 6000)}\nFollow-up: ${yield* encodeState(consultation.replyTo)}`;
              senderThreadId = consultation.origin.conversation.threadId;
            } else if (row.kind === "crew-return" && consultation?.progress.state === "answered") {
              const response = yield* canonical(projectId, consultation.progress.exchange.response);
              text = `Crew consultation ${consultation.id} answered. From ${consultation.destination.threadId}. Canonical source: ${yield* encodeState(consultation.progress.exchange.response)}\n${response.text.slice(0, 10000)}`;
              senderThreadId = consultation.destination.threadId;
            } else if (
              row.kind === "crew-attention" &&
              attention !== null &&
              state.coordinatorThreadId === row.thread_id
            ) {
              const source = yield* canonical(projectId, attention.source);
              text = `Crew attention ${attention.id}: ${attention.reason}. Source: ${yield* encodeState(attention.source)}\n${source.text.slice(0, 6000)}\nRead context, consult the existing workstream or arrange a visible handoff. Do not implement the request yourself or answer human-only approvals.`;
              senderThreadId = attention.source.conversation.threadId;
            } else
              return yield* fail("This conversation delivery no longer matches current state.");
            const currentLimit = yield* deps.authorize(projectId, payload.actor as ThreadId | null);
            // Recheck the original caller's authority on every replay; dispatch checks the target under its own lock.
            const limit =
              currentLimit && payload.limit
                ? {
                    runtimeMode: isRuntimeModeAbove(
                      currentLimit.runtimeMode,
                      payload.limit.runtimeMode,
                    )
                      ? payload.limit.runtimeMode
                      : currentLimit.runtimeMode,
                    interactionMode:
                      currentLimit.interactionMode === "plan" ||
                      payload.limit.interactionMode === "plan"
                        ? ("plan" as const)
                        : ("default" as const),
                  }
                : (currentLimit ?? payload.limit);
            return yield* deps.threads
              .sendToThread({
                projectId,
                threadId: row.thread_id,
                commandId: CommandId.make(row.id),
                messageId: MessageId.make(row.id),
                senderThreadId,
                text,
                attachments,
                mode: "queue",
                createdBy: "agent",
                creationSource: "server",
              })
              .pipe(Effect.provideService(DispatchModeLimit, limit ?? undefined));
          }),
        );
        yield* sql.withTransaction(
          Effect.gen(function* () {
            if (consultation !== null && row.kind === "crew-consultation") {
              const observation = Result.isFailure(outcome)
                ? {
                    type: "failed" as const,
                    detail:
                      "Consultation could not be delivered. Inspect permissions, pause, stop and source state before retrying.",
                  }
                : {
                    type: "delivered" as const,
                    request: messageRef(projectId, outcome.success.message),
                  };
              if (Result.isFailure(outcome) || outcome.success.delivery !== "queued") {
                const next = observeCrewConsultation(
                  consultation,
                  {
                    scope: scope(projectId),
                    consultationId: consultation.id,
                    deliveryId: CommandId.make(row.id),
                    outcome: observation,
                  },
                  now,
                );
                if (next.accepted)
                  yield* put(
                    projectId,
                    "consultations",
                    consultation.id,
                    consultation.destination.threadId,
                    next.consultation,
                  );
              }
            }
            if (attention !== null)
              yield* put(
                projectId,
                "attention",
                attention.id,
                attention.source.conversation.threadId,
                {
                  ...attention,
                  updatedAt: now,
                  progress: Result.isFailure(outcome)
                    ? {
                        state: "failed",
                        deliveryId: CommandId.make(row.id),
                        runId: null,
                        detail:
                          "Coordinator delivery failed. Inspect the source and coordinator state.",
                      }
                    : outcome.success.delivery === "queued"
                      ? { state: "queued", deliveryId: CommandId.make(row.id) }
                      : {
                          state: "delivered",
                          deliveryId: CommandId.make(row.id),
                          runId: outcome.success.run.id,
                        },
                },
              );
            yield* sql`UPDATE project_teamwork_outbox SET status = ${Result.isSuccess(outcome) ? "delivered" : "failed"} WHERE id = ${row.id}`;
            yield* commit(
              state,
              CommandId.make(`${row.id}:result`),
              null,
              yield* encodeState({
                type: "crew.conversation",
                deliveryId: row.id,
                status: Result.isSuccess(outcome) ? "accepted" : "failed",
              }),
              now,
            );
          }),
        );
      }),
    );
    yield* deps.changed(projectId);
  }, Effect.mapError(storageError));

  const observe = Effect.fn("CrewConversations.observe")(function* (
    stored: OrchestrationV2StoredEvent,
  ) {
    const event = stored.event;
    if (
      event.type !== "runtime-request.updated" &&
      event.type !== "run.updated" &&
      (event.type !== "message.updated" || event.payload.streaming || event.payload.role !== "user")
    )
      return null;
    const memberships = yield* sql<{
      project_id: ProjectId;
    }>`SELECT project_id FROM project_crew_conversations WHERE thread_id = ${event.threadId} AND collection = 'workstreams' AND json_extract(payload_json, '$.status') != 'unlinked'
      UNION SELECT project_id FROM project_teamwork WHERE json_extract(payload_json, '$.coordinatorThreadId') = ${event.threadId}`;
    const projectId = memberships[0]?.project_id;
    if (projectId === undefined) return null;
    yield* deps.locks.withLock(
      projectId,
      sql.withTransaction(
        Effect.gen(function* () {
          const state = yield* deps.load(projectId);
          if (state.coordinatorThreadId === null) return;
          if (event.threadId !== state.coordinatorThreadId) {
            const membership = yield* get(projectId, "workstreams", event.threadId, CrewWorkstream);
            if (
              !membership ||
              DateTime.toEpochMillis(event.occurredAt) < Date.parse(membership.linkedAt)
            )
              return;
          }
          const now = DateTime.formatIso(yield* DateTime.now);
          if (event.type === "runtime-request.updated") {
            if (event.runId == null) return;
            const observation = yield* encodeState({
              type: "crew.conversation",
              eventSequence: stored.sequence,
              runtimeRequestKind: event.payload.kind,
              runtimeRequestThreadId: event.threadId,
            });
            const existing = yield* sql<{ id: string }>`SELECT id FROM project_crew_conversations
              WHERE project_id = ${projectId} AND collection = 'attention' AND thread_id = ${event.threadId}
              AND json_extract(payload_json, '$.pendingRequest.requestId') = ${event.payload.id}
              AND json_extract(payload_json, '$.pendingRequest.runId') = ${event.runId}`;
            if (event.payload.status !== "pending") {
              if (!existing.length) return;
              for (const row of existing) {
                const attention = yield* get(projectId, "attention", row.id, CrewAttention);
                if (attention)
                  yield* put(projectId, "attention", row.id, event.threadId, {
                    ...attention,
                    pendingRequest: null,
                    updatedAt: now,
                  });
              }
              yield* commit(
                state,
                CommandId.make(`crew:event:${stored.sequence}`),
                null,
                observation,
                now,
              );
              return;
            }
            if (existing.length) return;
            const records = yield* deps.threads.getThreadRecords(
              event.threadId,
              ["runs", "messages", "runtimeRequests"],
              { runIds: [event.runId], messageRunIds: [event.runId], messageRoles: ["user"] },
            );
            if (
              !records.runtimeRequests.some(
                (request) => request.id === event.payload.id && request.status === "pending",
              )
            )
              return;
            const requestMessage = records.messages.find(
              (m) => m.id === records.runs[0]?.userMessageId,
            );
            if (!requestMessage) return;
            const source = messageRef(projectId, requestMessage);
            const coordinator = ref(projectId, state.coordinatorThreadId);
            const member = yield* get(projectId, "workstreams", event.threadId, CrewWorkstream);
            if (!member || member.status === "unlinked" || event.threadId === coordinator.threadId)
              return;
            const id = `request:${stored.sequence}`;
            yield* put(projectId, "attention", id, event.threadId, {
              id,
              source,
              coordinator,
              reason: event.payload.kind === "user_input" ? "question" : "approval",
              correlationId: null,
              pendingRequest: {
                requestId: event.payload.id,
                runId: event.runId,
                responder: "user-only",
              },
              progress: { state: "pending" },
              createdAt: now,
              updatedAt: now,
            });
            yield* commit(
              state,
              CommandId.make(`crew:event:${stored.sequence}`),
              null,
              observation,
              now,
            );
            return;
          }
          if (event.type === "run.updated") {
            if (
              !["completed", "failed", "interrupted", "cancelled", "running"].includes(
                event.payload.status,
              )
            )
              return;
            const rows = yield* sql<{
              id: string;
            }>`SELECT id FROM project_crew_conversations WHERE project_id = ${projectId} AND collection = 'consultations' AND thread_id = ${event.threadId} AND json_extract(payload_json, '$.progress.state') IN ('queued','delivered')`;
            let changed = false;
            if (event.threadId === state.coordinatorThreadId) {
              const pending = yield* sql<{
                id: string;
              }>`SELECT id FROM project_crew_conversations WHERE project_id = ${projectId} AND collection = 'attention'
              AND json_extract(payload_json, '$.progress.deliveryId') = ${event.payload.userMessageId}
              AND json_extract(payload_json, '$.progress.state') IN ('queued', 'delivered')`;
              for (const item of pending) {
                const attention = yield* get(projectId, "attention", item.id, CrewAttention);
                if (
                  attention === null ||
                  !["queued", "delivered"].includes(attention.progress.state) ||
                  !("deliveryId" in attention.progress)
                )
                  continue;
                const messages = yield* deps.threads.getMessagesById(event.threadId, [
                  MessageId.make(attention.progress.deliveryId),
                ]);
                if (
                  messages.get(MessageId.make(attention.progress.deliveryId))?.runId !==
                  event.payload.id
                )
                  continue;
                const progress =
                  event.payload.status === "completed"
                    ? {
                        state: "considered" as const,
                        deliveryId: attention.progress.deliveryId,
                        runId: event.payload.id,
                      }
                    : event.payload.status === "running"
                      ? {
                          state: "delivered" as const,
                          deliveryId: attention.progress.deliveryId,
                          runId: event.payload.id,
                        }
                      : {
                          state: "failed" as const,
                          deliveryId: attention.progress.deliveryId,
                          runId: event.payload.id,
                          detail: `Coordinator run ${event.payload.status}. Attention may not have been considered.`,
                        };
                yield* put(
                  projectId,
                  "attention",
                  attention.id,
                  attention.source.conversation.threadId,
                  { ...attention, progress, updatedAt: now },
                );
                changed = true;
              }
            }
            for (const row of rows) {
              const current = yield* get(projectId, "consultations", row.id, CrewConsultation);
              if (current === null) continue;
              const requests = yield* deps.threads.getMessagesById(event.threadId, [
                MessageId.make(current.deliveryId),
              ]);
              const request = requests.get(MessageId.make(current.deliveryId));
              if (request?.runId !== event.payload.id) continue;
              if (event.payload.status === "running") {
                const next = observeCrewConsultation(
                  current,
                  {
                    scope: scope(projectId),
                    consultationId: current.id,
                    deliveryId: current.deliveryId,
                    outcome: { type: "delivered", request: messageRef(projectId, request) },
                  },
                  now,
                );
                if (next.accepted && next.consultation !== current) {
                  yield* put(
                    projectId,
                    "consultations",
                    current.id,
                    current.destination.threadId,
                    next.consultation,
                  );
                  changed = true;
                }
                continue;
              }
              if (event.payload.status !== "completed") {
                const next = observeCrewConsultation(
                  current,
                  {
                    scope: scope(projectId),
                    consultationId: current.id,
                    deliveryId: current.deliveryId,
                    outcome: {
                      type: "failed",
                      detail: `Specialist run ${event.payload.status}. No answer was returned.`,
                    },
                  },
                  now,
                );
                if (next.accepted && next.consultation !== current) {
                  yield* put(
                    projectId,
                    "consultations",
                    current.id,
                    current.destination.threadId,
                    next.consultation,
                  );
                  changed = true;
                }
                continue;
              }
              const records = yield* deps.threads.getThreadRecords(event.threadId, ["messages"], {
                messageRunIds: [event.payload.id],
                messageRoles: ["assistant"],
              });
              const response = records.messages
                .filter((m) => !m.streaming && m.text.trim().length > 0)
                .at(-1);
              if (!response) {
                const next = observeCrewConsultation(
                  current,
                  {
                    scope: scope(projectId),
                    consultationId: current.id,
                    deliveryId: current.deliveryId,
                    outcome: {
                      type: "failed",
                      detail: "Specialist completed without a readable final answer.",
                    },
                  },
                  now,
                );
                if (next.accepted)
                  yield* put(
                    projectId,
                    "consultations",
                    current.id,
                    current.destination.threadId,
                    next.consultation,
                  );
                changed = true;
                continue;
              }
              const transition = observeCrewConsultation(
                current,
                {
                  scope: scope(projectId),
                  consultationId: current.id,
                  deliveryId: current.deliveryId,
                  outcome: {
                    type: "answered",
                    exchange: {
                      request: messageRef(projectId, request),
                      response: messageRef(projectId, response),
                      responseId: response.id,
                    },
                  },
                },
                now,
              );
              if (!transition.accepted) continue;
              yield* put(
                projectId,
                "consultations",
                current.id,
                current.destination.threadId,
                transition.consultation,
              );
              yield* outbox(
                projectId,
                state.revision + 1,
                CommandId.make(`${current.deliveryId}:return`),
                current.origin.conversation.threadId,
                "crew-return",
                { id: current.id, actor: null, limit: null },
              );
              changed = true;
            }
            if (changed)
              yield* commit(
                state,
                CommandId.make(`crew:event:${stored.sequence}`),
                null,
                yield* encodeState({ type: "crew.conversation", eventSequence: stored.sequence }),
                now,
              );
            return;
          }
          if (event.type !== "message.updated") return;
          const message = event.payload;
          const source = messageRef(projectId, message);
          if (
            message.createdBy !== "user" ||
            message.creationSource === "server" ||
            source.sender !== null ||
            message.id.startsWith("crew:")
          )
            return;
          const member = yield* get(projectId, "workstreams", event.threadId, CrewWorkstream);
          const coordinator = ref(projectId, state.coordinatorThreadId);
          if (member === null || !shouldRecordCrewAttention(source, coordinator, [member])) return;
          const id = `attention:${stored.sequence}`;
          const existing =
            yield* sql`SELECT id FROM project_crew_conversations WHERE project_id = ${projectId} AND collection = 'attention' AND thread_id = ${event.threadId} AND json_extract(payload_json, '$.source.messageId') = ${message.id} AND json_extract(payload_json, '$.reason') = 'user-message' LIMIT 1`;
          if (existing.length) return;
          const deliveryId = CommandId.make(`crew:${projectId}:attention:${id}`);
          yield* put(projectId, "attention", id, event.threadId, {
            id,
            source,
            coordinator,
            reason: "user-message",
            correlationId: null,
            pendingRequest: null,
            progress: { state: "queued", deliveryId },
            createdAt: now,
            updatedAt: now,
          });
          yield* outbox(
            projectId,
            state.revision + 1,
            deliveryId,
            coordinator.threadId,
            "crew-attention",
            { id, actor: null, limit: null },
          );
          yield* commit(
            state,
            CommandId.make(`crew:event:${stored.sequence}`),
            null,
            yield* encodeState({ type: "crew.conversation", eventSequence: stored.sequence }),
            now,
          );
        }),
      ),
    );
    yield* deps.changed(projectId);
    return projectId;
  }, Effect.mapError(storageError));

  return { command, query, deliver, observe };
});
