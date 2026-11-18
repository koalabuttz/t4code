import { assert, it } from "@effect/vitest";
import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import {
  ChatAttachmentId,
  CommandId,
  NodeId,
  EnvironmentId,
  MessageId,
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import type { CrewConversationAction, CrewMessageRef } from "@t3tools/contracts/crewConversation";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlStatement from "effect/sql/Statement";
import * as Sqlite from "../persistence/Sqlite.ts";
import crewVisibleMessageIndexes from "../persistence/Migrations/100_CrewVisibleMessageIndexes.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { CrewArtifacts } from "./CrewArtifacts.ts";
import * as Teamwork from "./TeamworkService.ts";

const projectId = ProjectId.make("crew-project");
const environmentId = EnvironmentId.make("crew-environment");
const coordinator = ThreadId.make("coordinator");
const worker = ThreadId.make("android");
const scope = { projectId, environmentId };
const context = { sources: [], attachments: [], replyTo: null };
const source: CrewMessageRef = {
  conversation: { ...scope, threadId: coordinator },
  messageId: MessageId.make("question"),
  runId: RunId.make("origin-run"),
  actor: "user",
  sender: null,
};

it.effect(
  "returns correlated consultation answers and follow-ups, deduplicates oversight and preserves scoped workstreams",
  () => {
    const messages = new Map<MessageId, OrchestrationV2ConversationMessage>();
    const sent: Array<{ threadId: ThreadId; text: string; messageId: MessageId }> = [];
    let queued = false;
    let busy = false;
    let failed = false;
    let queueHeldAfterStop: boolean | undefined;
    let questionStatus: "pending" | "resolved" = "pending";
    let coordinatorMode: "approval-required" | "full-access" = "approval-required";
    let coordinatorActiveRunId = source.runId;
    const returnModes: Array<string | undefined> = [];
    return Effect.gen(function* () {
      const teams = yield* Teamwork.TeamworkService;
      const now = yield* DateTime.now;
      const attachmentId = ChatAttachmentId.make("screen");
      messages.set(source.messageId, {
        id: source.messageId,
        threadId: coordinator,
        runId: source.runId,
        role: "user",
        createdBy: "user",
        creationSource: "web",
        attachments: [
          {
            type: "image",
            id: attachmentId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 140,
          },
        ],
        text: "Why is the Android screen clipped?",
        streaming: false,
        nodeId: null,
        createdAt: now,
        updatedAt: now,
      });
      yield* teams.mutate({
        projectId,
        commandId: CommandId.make("adopt"),
        expectedRevision: 0,
        action: { type: "coordinator.set", threadId: coordinator },
      });
      const command = (
        expectedRevision: number,
        commandId: string,
        action: CrewConversationAction,
      ) =>
        teams.conversationCommand({
          scope,
          expectedRevision,
          commandId: CommandId.make(commandId),
          action,
        });
      const action = {
        type: "workstream.link",
        threadId: worker,
        title: "Android improvements",
      } as const;
      const receipt = yield* command(1, "link", action);
      assert.equal(receipt.revision, 2);
      assert.deepEqual(yield* command(1, "link", action), receipt);
      const collision = yield* Effect.result(command(1, "link", { ...action, title: "Different" }));
      assert.isTrue(Result.isFailure(collision));
      const request = {
        id: "clipping",
        origin: source,
        destination: { ...scope, threadId: worker },
        context,
        replyTo: null,
      };
      const compact = {
        scope,
        expectedRevision: 2,
        commandId: CommandId.make("consult"),
        action: {
          type: "consultation.request-from-message",
          id: request.id,
          destinationThreadId: worker,
        },
      } as const;
      const anotherQuestion = MessageId.make("second-question-in-run");
      messages.set(anotherQuestion, { ...messages.get(source.messageId)!, id: anotherQuestion });
      assert.isTrue(
        Result.isFailure(yield* Effect.result(teams.conversationCommand(compact, coordinator))),
      );
      messages.delete(anotherQuestion);
      const compactReceipt = yield* teams.conversationCommand(compact, coordinator);
      coordinatorActiveRunId = null;
      assert.deepEqual(yield* teams.conversationCommand(compact, coordinator), compactReceipt);
      yield* teams.drain;
      const page = yield* teams.conversationQuery({
        scope,
        collection: "consultations",
        id: request.id,
      });
      assert.equal(page.consultations[0]?.progress.state, "delivered");
      assert.deepEqual(page.consultations[0]?.origin, source);
      assert.deepEqual(page.consultations[0]?.context.attachments, [
        { message: source, attachmentId },
      ]);
      const revision = (yield* teams.read(projectId)).snapshot.revision;
      const wrongThread = yield* Effect.result(
        command(revision, "wrong-thread", {
          type: "consultation.request-from-message",
          id: "wrong-thread",
          originThreadId: worker,
          originMessageId: source.messageId,
          destinationThreadId: worker,
        }),
      );
      assert.isTrue(Result.isFailure(wrongThread));
      const forged = yield* Effect.result(
        command(revision, "forged", {
          type: "consultation.request",
          request: { ...request, id: "forged", origin: { ...source, actor: "agent" } },
        }),
      );
      assert.isTrue(Result.isFailure(forged));
      const wrongScope = yield* Effect.result(
        teams.conversationQuery({
          scope: { ...scope, environmentId: EnvironmentId.make("other") },
          collection: "workstreams",
        }),
      );
      assert.isTrue(Result.isFailure(wrongScope));
      const consultation = page.consultations[0]!;
      const sourceRequest = messages.get(MessageId.make(consultation.deliveryId))!;
      const answer = {
        ...sourceRequest,
        id: MessageId.make(
          "message:provider:acpRegistry:native-item:provider-instance%3AdevReplay%3A00000000-0000-4000-8000-000000000000%3Aturn%3A1%3Aassistant%3A0",
        ),
        role: "assistant" as const,
        creationSource: "provider" as const,
        text: "Use the safe-area inset.",
        senderThreadId: worker,
      };
      messages.set(answer.id, answer);
      coordinatorMode = "full-access";
      const completed = {
        sequence: 10,
        commandId: null,
        event: {
          type: "run.updated",
          occurredAt: now,
          threadId: worker,
          payload: { id: sourceRequest.runId, status: "completed" },
        },
      } as OrchestrationV2StoredEvent;
      yield* teams.observeConversationEvent(completed);
      yield* teams.drain;
      assert.deepEqual(returnModes, ["approval-required"]);
      const answered = (yield* teams.conversationQuery({ scope, collection: "consultations" }))
        .consultations[0]!;
      assert.equal(answered.progress.state, "answered");
      if (answered.progress.state === "answered")
        assert.equal(answered.progress.exchange.response.messageId, answer.id);
      assert.equal(sent.at(-1)?.threadId, coordinator);
      assert.include(sent.at(-1)!.text, answer.id);
      const count = sent.length;
      yield* teams.observeConversationEvent(completed);
      yield* teams.drain;
      assert.equal(sent.length, count);
      queued = true;
      const followupMessageId = MessageId.make("follow-up-question");
      messages.set(followupMessageId, {
        ...messages.get(source.messageId)!,
        id: followupMessageId,
        text: "What about landscape?",
        attachments: [],
      });
      const followup = {
        type: "consultation.request-from-message",
        id: "follow-up",
        originThreadId: coordinator,
        originMessageId: followupMessageId,
        destinationThreadId: worker,
        replyTo: { consultationId: request.id, responseId: answer.id },
      } as const;
      const followupRevision = (yield* teams.read(projectId)).snapshot.revision;
      const followupReceipt = yield* command(followupRevision, "follow-up", followup);
      yield* teams.drain;
      assert.deepEqual(yield* command(followupRevision, "follow-up", followup), followupReceipt);
      const followed = (yield* teams.conversationQuery({
        scope,
        collection: "consultations",
        id: "follow-up",
      })).consultations[0]!;
      assert.equal(followed.progress.state, "queued");
      assert.equal(followed.origin.messageId, followupMessageId);
      assert.include(sent.at(-1)!.text, answer.id);
      const direct = {
        ...messages.get(source.messageId)!,
        id: MessageId.make("direct"),
        threadId: worker,
      };
      messages.set(direct.id, direct);
      const directEvent = {
        sequence: 20,
        commandId: null,
        event: { type: "message.updated", occurredAt: now, threadId: worker, payload: direct },
      } as OrchestrationV2StoredEvent;
      yield* teams.observeConversationEvent(directEvent);
      yield* teams.drain;
      yield* teams.observeConversationEvent({ ...directEvent, sequence: 21 });
      yield* teams.drain;
      assert.equal(
        (yield* teams.conversationQuery({ scope, collection: "attention" })).attention.length,
        1,
      );
      const change = (id: string, action: CrewConversationAction) =>
        Effect.gen(function* () {
          return yield* command((yield* teams.read(projectId)).snapshot.revision, id, action);
        });
      const api = ThreadId.make("api");
      yield* change("link-api", { type: "workstream.link", threadId: api, title: "API" });
      const explanation = {
        ...direct,
        id: MessageId.make("handoff-explanation"),
        createdBy: "agent" as const,
        creationSource: "server" as const,
        senderThreadId: coordinator,
      };
      messages.set(explanation.id, explanation);
      const origin = {
        ...source,
        conversation: { ...scope, threadId: worker },
        messageId: direct.id,
      };
      const handoff = {
        type: "handoff.propose",
        id: "route-api",
        origin,
        destination: { ...scope, threadId: api },
        context,
        consultationId: null,
        assignment: null,
        explanation: {
          ...origin,
          messageId: explanation.id,
          actor: "agent",
          sender: { ...scope, threadId: coordinator },
        },
      } as const;
      const otherQuestion = { ...direct, id: MessageId.make("other-question") };
      messages.set(otherQuestion.id, otherQuestion);
      yield* change("other-consultation", {
        type: "consultation.request",
        request: {
          ...request,
          id: "other-consultation",
          origin: { ...origin, messageId: otherQuestion.id },
          destination: handoff.destination,
        },
      });
      yield* teams.drain;
      const unrelated = yield* Effect.result(
        change("wrong-handoff", {
          ...handoff,
          consultationId: "other-consultation",
        }),
      );
      assert.isTrue(Result.isFailure(unrelated));
      yield* change("handoff", handoff);
      busy = true;
      assert.isTrue(
        Result.isFailure(
          yield* Effect.result(
            change("busy-handoff", { type: "handoff.complete", id: "route-api" }),
          ),
        ),
      );
      busy = false;
      yield* change("complete-handoff", { type: "handoff.complete", id: "route-api" });
      assert.equal(
        (yield* teams.conversationQuery({ scope, collection: "handoffs" })).handoffs[0]?.state,
        "completed",
      );
      queued = false;
      failed = true;
      coordinatorMode = "approval-required";
      yield* teams.conversationCommand(
        {
          scope,
          expectedRevision: (yield* teams.read(projectId)).snapshot.revision,
          commandId: CommandId.make("offline"),
          action: {
            type: "consultation.request",
            request: { ...request, id: "offline", origin, destination: handoff.destination },
          },
        },
        coordinator,
      );
      yield* teams.drain;
      const offline = (yield* teams.conversationQuery({
        scope,
        collection: "consultations",
        id: "offline",
      })).consultations[0]!;
      assert.equal(offline.progress.state, "failed");
      failed = false;
      coordinatorMode = "full-access";
      yield* change("retry", {
        type: "consultation.retry",
        id: offline.id,
        previousDeliveryId: offline.deliveryId,
      });
      yield* teams.drain;
      const retried = (yield* teams.conversationQuery({
        scope,
        collection: "consultations",
        id: "offline",
      })).consultations[0]!;
      assert.equal(retried.progress.state, "delivered");
      assert.notEqual(retried.deliveryId, offline.deliveryId);
      const retriedMessage = messages.get(MessageId.make(retried.deliveryId))!;
      const retryAnswer = {
        ...answer,
        id: MessageId.make("retry-answer"),
        threadId: api,
        senderThreadId: api,
        runId: retriedMessage.runId,
      };
      messages.set(retryAnswer.id, retryAnswer);
      const retryCompleted = {
        sequence: 22,
        commandId: null,
        event: {
          type: "run.updated",
          occurredAt: now,
          threadId: api,
          payload: { id: retriedMessage.runId, status: "completed" },
        },
      } as OrchestrationV2StoredEvent;
      yield* teams.observeConversationEvent(retryCompleted);
      yield* teams.drain;
      yield* teams.observeConversationEvent(retryCompleted);
      yield* teams.drain;
      assert.deepEqual(returnModes, ["approval-required", "approval-required"]);
      assert.equal(sent.at(-1)?.threadId, worker);
      const pendingEvent = {
        sequence: 23,
        commandId: null,
        event: {
          type: "runtime-request.updated",
          occurredAt: now,
          threadId: worker,
          runId: direct.runId,
          payload: { id: "human-question", kind: "user_input", status: "pending" },
        },
      } as OrchestrationV2StoredEvent;
      yield* teams.observeConversationEvent(pendingEvent);
      const human = (yield* teams.conversationQuery({
        scope,
        collection: "attention",
      })).attention.find((a) => a.pendingRequest !== null)!;
      assert.equal(human.pendingRequest?.responder, "user-only");
      assert.equal(human.pendingRequest?.requestId, "human-question");
      assert.equal(human.progress.state, "pending");
      questionStatus = "resolved";
      if (pendingEvent.event.type !== "runtime-request.updated") throw new Error("fixture");
      const resolved = {
        ...pendingEvent,
        event: {
          ...pendingEvent.event,
          payload: {
            ...pendingEvent.event.payload,
            status: "resolved" as const,
          },
        },
      };
      yield* teams.observeConversationEvent({ ...resolved, sequence: 24 });
      yield* teams.observeConversationEvent({ ...resolved, sequence: 25 });
      yield* teams.observeConversationEvent({ ...pendingEvent, sequence: 26 });
      const historical = yield* teams.conversationQuery({ scope, collection: "attention" });
      assert.deepEqual(
        historical.attention.filter((a) => a.reason === "question").map((a) => a.pendingRequest),
        [null],
      );
      const directAttention = (yield* teams.conversationQuery({
        scope,
        collection: "attention",
      })).attention.find((a) => a.reason === "user-message")!;
      assert.equal(directAttention.progress.state, "queued");
      yield* teams.observeConversationEvent({
        sequence: 31,
        commandId: null,
        event: {
          type: "message.updated",
          threadId: worker,
          occurredAt: DateTime.add(now, { days: -1 }),
          payload: { ...direct, id: MessageId.make("before-link") },
        },
      } as OrchestrationV2StoredEvent);
      const reflected = {
        ...direct,
        id: MessageId.make("reflected"),
        senderThreadId: coordinator,
        createdBy: "agent" as const,
        creationSource: "server" as const,
      };
      yield* teams.observeConversationEvent({
        ...directEvent,
        sequence: 33,
        event: { ...directEvent.event, type: "message.updated", payload: reflected },
      } as OrchestrationV2StoredEvent);
      if ("deliveryId" in directAttention.progress) {
        const delivered = messages.get(MessageId.make(directAttention.progress.deliveryId))!;
        yield* teams.observeConversationEvent({
          sequence: 34,
          commandId: null,
          event: {
            type: "run.updated",
            threadId: coordinator,
            occurredAt: now,
            payload: { id: delivered.runId, userMessageId: delivered.id, status: "completed" },
          },
        } as OrchestrationV2StoredEvent);
        assert.equal(
          (yield* teams.conversationQuery({
            scope,
            collection: "attention",
            id: directAttention.id,
          })).attention[0]?.progress.state,
          "considered",
        );
      }
      assert.equal(
        (yield* teams.conversationQuery({ scope, collection: "attention" })).attention.length,
        2,
      );
      assert.deepEqual((yield* teams.read(projectId)).snapshot.tasks, []);
      const mutate = (id: string, action: import("@t3tools/contracts").TeamworkAction) =>
        Effect.gen(function* () {
          return yield* teams.mutate({
            projectId,
            commandId: CommandId.make(id),
            expectedRevision: (yield* teams.read(projectId)).snapshot.revision,
            action,
          });
        });
      yield* mutate("initiative", {
        type: "initiative.create",
        id: "implementation",
        title: "Implementation",
        brief: "Fix clipping",
        mode: "swarm",
      });
      yield* mutate("task", {
        type: "task.create",
        id: "owned",
        initiativeId: "implementation",
        title: "Clipping",
        brief: "Fix clipping",
        criteria: "Inset applied",
        roleId: null,
        milestoneId: null,
        dependencies: [],
        knowledgeIds: [],
      });
      yield* mutate("reserve", { type: "task.reserve", id: "owned", delegationId: "attempt" });
      yield* mutate("assign", {
        type: "task.assign",
        id: "owned",
        delegationId: "attempt",
        threadId: worker,
        delegatedTaskId: NodeId.make("delegated"),
      });
      const reportRevision = (yield* teams.read(projectId)).snapshot.revision;
      const report = (expectedRevision: number, commandId: string) =>
        teams.mutate(
          {
            projectId,
            expectedRevision,
            commandId: CommandId.make(commandId),
            action: {
              type: "task.report",
              id: "owned",
              attemptId: "attempt",
              status: "running",
              evidence: "Checked the inset.",
            },
          },
          worker,
        );
      questionStatus = "pending";
      const approval = {
        ...pendingEvent,
        event: {
          ...pendingEvent.event,
          payload: { ...pendingEvent.event.payload, kind: "mcp-elicitation" as const },
        },
      };
      yield* teams.observeConversationEvent({ ...approval, sequence: 35 });
      questionStatus = "resolved";
      yield* teams.observeConversationEvent({
        ...approval,
        sequence: 36,
        event: { ...approval.event, payload: { ...approval.event.payload, status: "resolved" } },
      });
      assert.isAbove((yield* teams.read(projectId)).snapshot.revision, reportRevision);
      yield* report(reportRevision, "approved-report");
      assert.equal(
        (yield* teams.read(projectId)).snapshot.tasks[0]?.evidence,
        "Checked the inset.",
      );
      assert.isTrue(Result.isFailure(yield* Effect.result(report(reportRevision, "old-report"))));
      const ownedHandoff = {
        type: "handoff.propose",
        id: "owned-route",
        origin,
        destination: { ...scope, threadId: api },
        context,
        consultationId: null,
        explanation: {
          ...origin,
          messageId: explanation.id,
          actor: "agent",
          sender: { ...scope, threadId: coordinator },
        },
        assignment: null,
      } as const;
      assert.isTrue(Result.isFailure(yield* Effect.result(change("hide-owner", ownedHandoff))));
      const proposal = {
        type: "handoff.propose-from-attention",
        id: ownedHandoff.id,
        attentionId: directAttention.id,
        destinationThreadId: api,
        explanationMessageId: explanation.id,
        taskId: "owned",
      } as const;
      assert.isTrue(
        Result.isFailure(
          yield* Effect.result(
            change("bad-explanation", { ...proposal, explanationMessageId: direct.id }),
          ),
        ),
      );
      yield* change("owned-proposal", proposal);
      const proposed = (yield* teams.conversationQuery({
        scope,
        collection: "handoffs",
        id: proposal.id,
      })).handoffs[0];
      assert.deepEqual(proposed?.origin, directAttention.source);
      assert.equal(proposed?.ownership.state, "required");
      if (proposed?.ownership.state === "required") {
        assert.equal(proposed.ownership.assignment.attemptId, "attempt");
      }
      assert.isTrue(
        Result.isFailure(
          yield* Effect.result(
            change("active-transfer", { type: "handoff.complete", id: "owned-route" }),
          ),
        ),
      );
      yield* mutate("pause", { type: "initiative.status", id: "implementation", status: "paused" });
      yield* teams.drain;
      yield* mutate("release", { type: "task.reset", id: "owned", status: "ready" });
      yield* teams.drain;
      queueHeldAfterStop = false;
      assert.isTrue(
        Result.isFailure(
          yield* Effect.result(
            change("unheld-queue-transfer", { type: "handoff.complete", id: "owned-route" }),
          ),
        ),
      );
      queueHeldAfterStop = true;
      yield* change("reconciled-transfer", { type: "handoff.complete", id: "owned-route" });
      assert.equal(
        (yield* teams.conversationQuery({ scope, collection: "handoffs", id: "owned-route" }))
          .handoffs[0]?.ownership.state,
        "reconciled",
      );
      yield* change("paused-question", {
        type: "consultation.request",
        request: { ...request, id: "paused" },
      });
      yield* teams.drain;
      assert.equal(
        (yield* teams.conversationQuery({ scope, collection: "consultations", id: "paused" }))
          .consultations[0]?.progress.state,
        "failed",
      );
      assert.equal((yield* teams.read(projectId)).snapshot.initiatives[0]?.status, "paused");
      const sql = yield* SqlClient.SqlClient;
      const route = (yield* teams.conversationQuery({
        scope,
        collection: "handoffs",
        id: "route-api",
      })).handoffs[0]!;
      const visibleQuestion = MessageId.make("visible-question");
      const visibleExplanation = MessageId.make("visible-explanation");
      for (let index = 0; index < 103; index++) {
        const id = `history-${String(index).padStart(3, "0")}`;
        const record = {
          ...(index === 101 ? answered : index === 102 ? consultation : followed),
          id,
          deliveryId: CommandId.make(`crew:${projectId}:${id}`),
          origin: { ...source, messageId: index >= 100 ? visibleQuestion : MessageId.make(id) },
        };
        yield* sql`INSERT INTO project_crew_conversations (project_id, collection, id, thread_id, payload_json)
          VALUES (${projectId}, 'consultations', ${id}, ${worker}, ${JSON.stringify(record)})`;
        const handoffRecord = {
          ...route,
          id,
          origin: { ...route.origin, messageId: MessageId.make(id) },
          explanation: {
            ...route.explanation,
            messageId: index === 102 ? visibleExplanation : MessageId.make(id),
          },
        };
        yield* sql`INSERT INTO project_crew_conversations (project_id, collection, id, thread_id, payload_json)
          VALUES (${projectId}, 'handoffs', ${id}, ${worker}, ${JSON.stringify(handoffRecord)})`;
      }
      const failedReturnId = `crew:${projectId}:history-101:return`;
      yield* sql`INSERT INTO project_teamwork_outbox (id, project_id, revision, thread_id, kind, status, payload_json)
        VALUES (${failedReturnId}, ${projectId}, 1, ${coordinator}, 'message', 'failed', '{}')`;
      assert.isFalse(messages.has(MessageId.make(failedReturnId)));
      assert.equal(
        (yield* teams.read(projectId)).deliveries.find((delivery) => delivery.id === failedReturnId)
          ?.status,
        "failed",
      );
      yield* sql`DROP INDEX project_crew_conversations_origin_message`;
      yield* sql`DROP INDEX project_crew_conversations_explanation_message`;
      yield* crewVisibleMessageIndexes;
      const ordinary = yield* teams.conversationQuery({
        scope,
        collection: "consultations",
        threadId: coordinator,
        limit: 100,
      });
      assert.equal(ordinary.consultations.length, 100);
      assert.isNotNull(ordinary.nextCursor);
      assert.isFalse(ordinary.consultations.some((record) => record.id === "history-101"));
      const selected = { messageIds: [visibleQuestion] };
      const visible = yield* teams.conversationQuery({
        scope,
        collection: "consultations",
        threadId: coordinator,
        ...selected,
        limit: 100,
      });
      assert.deepEqual(
        visible.consultations.map((record) => [record.id, record.progress.state]),
        [
          ["history-100", "queued"],
          ["history-101", "answered"],
          ["history-102", "delivered"],
        ],
      );
      assert.isNull(visible.nextCursor);
      const selectedPage = yield* teams.conversationQuery({
        scope,
        collection: "consultations",
        threadId: coordinator,
        ...selected,
        limit: 1,
      });
      assert.equal(selectedPage.nextCursor, "history-100");
      const nextSelectedPage = yield* teams.conversationQuery({
        scope,
        collection: "consultations",
        threadId: coordinator,
        ...selected,
        limit: 100,
        cursor: selectedPage.nextCursor!,
      });
      assert.deepEqual(
        nextSelectedPage.consultations.map((record) => record.id),
        ["history-101", "history-102"],
      );
      const visibleHandoffs = yield* teams.conversationQuery({
        scope,
        collection: "handoffs",
        threadId: worker,
        messageIds: [visibleExplanation],
      });
      assert.deepEqual(
        visibleHandoffs.handoffs.map((record) => record.id),
        ["history-102"],
      );
      assert.deepEqual(visibleHandoffs.handoffs[0]?.ownership, route.ownership);
      const overlappingHandoff = yield* teams.conversationQuery({
        scope,
        collection: "handoffs",
        threadId: worker,
        messageIds: [MessageId.make("history-102"), visibleExplanation, visibleExplanation],
      });
      assert.deepEqual(
        overlappingHandoff.handoffs.map((record) => record.id),
        ["history-102"],
      );
      for (const filter of [{ id: "history-101" }, { cursor: "history-102" }]) {
        const excluded = yield* teams.conversationQuery({
          scope,
          collection: "handoffs",
          threadId: worker,
          messageIds: [MessageId.make("history-102"), visibleExplanation],
          ...filter,
        });
        assert.deepEqual(excluded.handoffs, []);
      }
      const wrongThreadSelection = yield* teams.conversationQuery({
        scope,
        collection: "consultations",
        threadId: worker,
        ...selected,
      });
      assert.deepEqual(wrongThreadSelection.consultations, []);
      for (const invalid of [
        { scope, collection: "consultations" as const, ...selected },
        { scope, collection: "attention" as const, threadId: coordinator, ...selected },
        { scope, collection: "consultations" as const, threadId: coordinator, messageIds: [] },
        {
          scope,
          collection: "consultations" as const,
          threadId: coordinator,
          messageIds: Array.from({ length: 101 }, () => visibleQuestion),
        },
      ]) {
        assert.isTrue(Result.isFailure(yield* Effect.result(teams.conversationQuery(invalid))));
      }
      assert.isTrue(
        Result.isFailure(
          yield* Effect.result(
            teams.conversationQuery(
              { scope, collection: "consultations", threadId: coordinator, ...selected },
              worker,
            ),
          ),
        ),
      );
      const exactSelected = yield* teams.conversationQuery({
        scope,
        collection: "consultations",
        threadId: coordinator,
        ...selected,
        id: "history-101",
      });
      assert.deepEqual(
        exactSelected.consultations.map((record) => record.id),
        ["history-101"],
      );
      for (const collection of ["consultations", "handoffs"] as const) {
        for (const messageIds of [
          [collection === "consultations" ? visibleQuestion : visibleExplanation],
          [MessageId.make("no-visible-exchange")],
        ]) {
          const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
          const page = yield* teams
            .conversationQuery({
              scope,
              collection,
              threadId: collection === "consultations" ? coordinator : worker,
              messageIds,
              limit: 100,
              ...(messageIds[0] === "no-visible-exchange" ? {} : { cursor: "history-099" }),
            })
            .pipe(
              Effect.provideService(SqlStatement.CurrentTransformer, (statement) =>
                Effect.sync(() => {
                  const compiled = statement.compile();
                  if (compiled[0].includes("project_crew_conversations")) statements.push(compiled);
                  return statement;
                }),
              ),
            );
          assert.equal(statements.length, 1);
          const [statement, parameters] = statements[0]!;
          const plan = (yield* sql.unsafe<{ detail: string }>(
            `EXPLAIN QUERY PLAN ${statement}`,
            parameters,
          )).map((row) => row.detail);
          if (messageIds[0] === "no-visible-exchange") {
            assert.deepEqual(page.consultations, []);
            assert.deepEqual(page.handoffs, []);
          }
          assert.isTrue(
            plan.some(
              (detail) =>
                detail.includes("project_crew_conversations_origin_message") &&
                detail.includes("project_id=? AND collection=? AND <expr>=? AND <expr>=? AND id>?"),
            ),
            plan.join("\n"),
          );
          if (collection === "handoffs")
            assert.isTrue(
              plan.some(
                (detail) =>
                  detail.includes("project_crew_conversations_explanation_message") &&
                  detail.includes(
                    "project_id=? AND collection=? AND <expr>=? AND <expr>=? AND id>?",
                  ),
              ),
              plan.join("\n"),
            );
          assert.isFalse(
            plan.some((detail) => /SCAN (?:project_crew_conversations|record)\b/.test(detail)),
            plan.join("\n"),
          );
          for (const detail of plan.filter((row) =>
            row.includes("sqlite_autoindex_project_crew_conversations_1"),
          ))
            assert.include(detail, "(project_id=? AND collection=? AND id=?)");
        }
      }
    }).pipe(
      Effect.provide(
        Teamwork.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ServerEnvironmentIdentity, {
                getEnvironmentId: Effect.succeed(environmentId),
              }),
              Layer.mock(CrewArtifacts)({
                inspect: () => Effect.succeed({ status: "available", detail: "Fixture" }),
              }),
              Layer.mock(ProjectStore.ProjectStoreV2)({
                get: () => Effect.succeedSome({ projectId } as never),
              }),
              Layer.mock(Threads.ThreadManagementService)({
                streamStoredEvents: Stream.empty,
                getShellSnapshot: () => Effect.succeed({ threads: [] } as never),
                getThreadShell: (id) =>
                  Effect.succeed({
                    id,
                    projectId,
                    deletedAt: null,
                    activeRunId: id === coordinator ? coordinatorActiveRunId : null,
                    status: busy ? "running" : "completed",
                    runtimeMode:
                      id === coordinator
                        ? coordinatorMode
                        : id === worker
                          ? "full-access"
                          : "approval-required",
                    interactionMode: "default",
                    creationSource: "mcp",
                    lineage: {
                      parentThreadId: id === coordinator ? null : coordinator,
                      rootThreadId: coordinator,
                      relationshipToParent: id === coordinator ? null : "subagent",
                    },
                  } as never),
                streamStoredEventsFrom: () => Stream.empty,
                getMessagesById: (threadId, ids) =>
                  Effect.succeed(
                    new Map(
                      ids.flatMap((id) =>
                        messages.get(id)?.threadId === threadId ? [[id, messages.get(id)!]] : [],
                      ),
                    ),
                  ),
                getThreadRecords: (threadId, _fields, filter) =>
                  Effect.succeed({
                    runtimeRequests: [{ id: "human-question", status: questionStatus }],
                    runs: [
                      {
                        id: source.runId,
                        userMessageId: MessageId.make("direct"),
                        status: "interrupted",
                      },
                      ...(threadId === worker && queueHeldAfterStop !== undefined
                        ? [
                            {
                              id: RunId.make("held-message"),
                              status: "queued",
                              queueHeld: queueHeldAfterStop,
                            },
                          ]
                        : []),
                    ],
                    messages: [...messages.values()].filter(
                      (m) =>
                        m.threadId === threadId &&
                        (filter?.messageRunIds === undefined ||
                          (m.runId !== null && filter.messageRunIds.includes(m.runId))) &&
                        (filter?.messageRoles === undefined ||
                          filter.messageRoles.includes(m.role)),
                    ),
                  } as never),
                sendToThread: (input) =>
                  Effect.gen(function* () {
                    if (input.commandId.endsWith(":return"))
                      returnModes.push((yield* DispatchModeLimit)?.runtimeMode);
                    if (failed)
                      return yield* new Threads.ThreadManagementThreadNotFoundError({
                        projectId,
                        threadId: input.threadId,
                      });
                    const now = yield* DateTime.now;
                    sent.push(input);
                    const message: OrchestrationV2ConversationMessage = {
                      id: input.messageId,
                      threadId: input.threadId,
                      runId: RunId.make(input.commandId),
                      ...(input.senderThreadId === undefined
                        ? {}
                        : { senderThreadId: input.senderThreadId }),
                      createdBy: "agent",
                      role: "user",
                      creationSource: "server",
                      nodeId: null,
                      text: input.text,
                      attachments: [],
                      streaming: false,
                      createdAt: now,
                      updatedAt: now,
                    };
                    messages.set(message.id, message);
                    return {
                      message,
                      run: { id: message.runId },
                      delivery: queued ? "queued" : "started",
                    } as never;
                  }),
                dispatch: () => Effect.succeed({} as never),
                confirmStop: () => Effect.void,
              }),
            ),
          ),
          Layer.provideMerge(Sqlite.layerMemory),
        ),
      ),
    );
  },
);
