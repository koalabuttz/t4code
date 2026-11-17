import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderThreadId, ThreadId } from "@t3tools/contracts";
import { derive } from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NativeOutcomes from "./AlbedoNativeOutcomes.ts";
import { AlbedoClient } from "./AlbedoClient.ts";
import { at, fakeDaemon, nativeRunId, threadId } from "./adapter.test-fixtures.ts";
import * as Conversation from "./nativeConversation.ts";
import type * as Session from "./sessionProtocol.ts";
import { generation, session } from "./session.test-fixtures.ts";

describe("Albedo native conversations", () => {
  it.effect.each([false, true])(
    "retains native mail and verifier outcomes through reset (autonomous parent: %s)",
    (autonomousOnly) =>
      Effect.gen(function* () {
        const fake = yield* fakeDaemon;
        const request: typeof Session.HistoryEntry.Type = {
          id: "request",
          position: 3,
          kind: "user",
          turn_id: nativeRunId,
          turn_type: "agent",
          input_id: null,
          created_at: "2026-11-16T12:00:00Z",
          content: [{ kind: "text", text: "Verify the evidence" }],
          mail: {
            mail_id: "native-mail",
            sender_session_id: "parent",
            sender_label: "Parent",
            kind: "task",
            external: false,
            answer: false,
          },
          checkpoint_id: null,
          content_complete: true,
          tool: null,
        };
        const ownRequest = {
          ...request,
          id: "app-request",
          position: 1,
          turn_id: "app-run",
          turn_type: "user" as const,
          mail: null,
          content: [{ kind: "text" as const, text: "Already displayed by T3" }],
        };
        const ownReply = {
          ...ownRequest,
          id: "app-reply",
          position: 2,
          kind: "assistant" as const,
        };
        const ownHistory = autonomousOnly ? [ownRequest, ownReply] : [];
        let native = {
          ...session(),
          active_output: autonomousOnly
            ? [
                {
                  message_id: "owned-spilled-output",
                  run_id: "app-run",
                  kind: "text" as const,
                  elapsed_ms: null,
                  bytes: 6,
                  text: null,
                  reference: {
                    url: `/sessions/${session().id}/active-output/owned`,
                    field: "text",
                    bytes: 6,
                  },
                },
              ]
            : [],
          history: { ...session().history, items: [...ownHistory, request], high_water: 3 },
        };
        const makeView = Conversation.make({
          nativeId: native.id,
          providerInstanceId: "albedo-test",
          threadId: autonomousOnly ? threadId : ThreadId.make("native-child"),
          ownerThreadId: threadId,
          providerThreadId: ProviderThreadId.make("native-provider-child"),
          ids: derive,
          startedAt: at,
          autonomousOnly,
        }).pipe(
          Effect.provideService(AlbedoClient, {
            ...fake.client,
            readHistory: () => Effect.sync(() => native.history),
          }),
        );
        const view = yield* makeView;
        const initial = yield* view.accept({
          generation,
          cursor: 0,
          snapshot: native,
          events: [{ type: "reset", data: { reason: "initial" } }],
        });
        expect(
          initial.events.some(
            (event) =>
              event.type === "message.updated" && event.message.text === "Already displayed by T3",
          ),
        ).toBe(false);
        expect(initial.events).toContainEqual(
          expect.objectContaining({
            type: "message.updated",
            backgroundOwnerThreadId: threadId,
            message: expect.objectContaining({
              role: "user",
              text: "Verify the evidence",
              runId: null,
              threadId: autonomousOnly ? threadId : "native-child",
            }),
          }),
        );
        expect(initial.events).toContainEqual(
          expect.objectContaining({
            type: "turn_item.updated",
            turnItem: expect.objectContaining({
              type: "system_notice",
              message: "Native task from Parent",
              startedAt: at,
              completedAt: at,
            }),
          }),
        );
        const streamed = yield* view.accept({
          generation,
          cursor: 3,
          events: [
            {
              type: "status",
              sequence: 1,
              data: { ...native.status, phase: "running", run_id: nativeRunId },
            },
            {
              type: "text",
              sequence: 2,
              data: { run_id: nativeRunId, message_id: "live", text: "Checking evidence" },
            },
            {
              type: "tool",
              sequence: 3,
              data: {
                tool_call_id: "submit",
                progress_call_id: "verify",
                name: "python",
                arguments: { code: "mail.submit()" },
                result: { error: "Verifier rejected the result" },
                trace: null,
                reference: null,
                content_complete: true,
                status: "failed",
              },
            },
          ],
        });
        const reply = streamed.events.find((event) => event.type === "message.updated");
        expect(reply).toMatchObject({ message: { streaming: true, text: "Checking evidence" } });
        expect(streamed.events).toContainEqual(
          expect.objectContaining({
            type: "turn_item.updated",
            turnItem: expect.objectContaining({
              type: "dynamic_tool",
              status: "failed",
              output: { error: "Verifier rejected the result" },
            }),
          }),
        );
        yield* Effect.flip(
          view.accept({
            generation,
            cursor: 5,
            events: [{ type: "status", sequence: 5, data: native.status }],
          }),
        );
        expect(view.cursor()?.sequence).toBe(3);
        const interrupted = yield* view.accept({
          generation,
          cursor: 4,
          events: [
            {
              type: "turn_completed",
              sequence: 4,
              data: {
                run_id: nativeRunId,
                state: "interrupted",
                input_ids: [],
                input_count: 0,
                truncated: false,
              },
            },
          ],
        });
        expect(interrupted.events).toContainEqual(
          expect.objectContaining({
            type: "message.updated",
            message: expect.objectContaining({
              id: reply?.type === "message.updated" ? reply.message.id : undefined,
              streaming: false,
              text: "Checking evidence",
            }),
          }),
        );
        native = {
          ...native,
          cursor: { generation, sequence: 4 },
          history: {
            ...native.history,
            high_water: 4,
            items: [
              ...ownHistory,
              request,
              {
                ...request,
                id: "reply",
                kind: "assistant",
                turn_type: "user",
                position: 4,
                mail: null,
                content: [{ kind: "text", text: "Checking evidence" }],
              },
            ],
          },
        };
        const recovered = yield* view.accept({
          generation,
          cursor: 4,
          snapshot: native,
          events: [{ type: "reset", data: { reason: "replay_unavailable" } }],
        });
        const recoveredReply = recovered.events.find((event) => event.type === "message.updated");
        if (recoveredReply !== undefined)
          expect(recoveredReply).toMatchObject({
            message: {
              id: reply?.type === "message.updated" ? reply.message.id : undefined,
              streaming: false,
            },
          });
        const restarted = yield* makeView;
        const restored = yield* restarted.accept({
          generation,
          cursor: 4,
          snapshot: native,
          events: [{ type: "reset", data: { reason: "initial" } }],
        });
        expect(restored.events).toContainEqual(
          expect.objectContaining({
            type: "message.updated",
            message: expect.objectContaining({
              id: reply?.type === "message.updated" ? reply.message.id : undefined,
              text: "Checking evidence",
              streaming: false,
            }),
          }),
        );
        expect(
          restored.events.some(
            (event) =>
              event.type === "message.updated" && event.message.text === "Already displayed by T3",
          ),
        ).toBe(false);
        const restoredOutcome = restored.events.find(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "system_notice" &&
            event.turnItem.message.startsWith("Native turn interrupted"),
        );
        const originalOutcome = interrupted.events.find(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "system_notice",
        );
        expect(restoredOutcome).toEqual(originalOutcome);
        expect(
          [
            ...initial.events,
            ...streamed.events,
            ...interrupted.events,
            ...recovered.events,
            ...restored.events,
          ].some((event) => event.type === "turn.terminal" || event.type === "subagent.updated"),
        ).toBe(false);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.merge(
            NodeServices.layer,
            NativeOutcomes.layer.pipe(
              Layer.provide(
                NodeSqliteClient.layer({
                  filename: ":memory:",
                  readerWorker: false,
                  writerWorker: false,
                }),
              ),
            ),
          ),
        ),
      ),
  );
});
