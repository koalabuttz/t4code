import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import {
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  ProviderSessionId,
} from "@t3tools/contracts";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Exit from "effect/Exit";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";

import * as InputStore from "./AlbedoInputStore.ts";
import * as CompactionStore from "./AlbedoCompactionStore.ts";
import * as SessionStore from "./AlbedoSessionStore.ts";
import * as NativeOutcomes from "./AlbedoNativeOutcomes.ts";
import { makeAdapter } from "./adapter.ts";
import {
  fakeDaemon,
  instanceId,
  nativeRunId,
  policy,
  providerSessionId,
  selection,
  threadId,
  turnInput,
} from "./adapter.test-fixtures.ts";
import { session } from "./session.test-fixtures.ts";

const layer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
  Layer.mergeAll(
    InputStore.layer,
    SessionStore.layer,
    NativeOutcomes.layer,
    CompactionStore.layer,
  ).pipe(
    Layer.provide(SecureRandom.layerWebCrypto),
    Layer.provideMerge(
      NodeSqliteClient.layer({ filename: ":memory:", readerWorker: false, writerWorker: false }),
    ),
  ),
);

const setup = Effect.gen(function* () {
  const fake = yield* fakeDaemon;
  const fs = yield* FileSystem.FileSystem;
  const homeDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-albedo-adapter-" });
  const adapter = yield* makeAdapter({
    instanceId,
    homeDirectory,
    connect: Effect.succeed(fake.client),
  });
  const open = { threadId, providerSessionId, modelSelection: selection, runtimePolicy: policy };
  const runtimeScope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(runtimeScope, Exit.void));
  const runtime = yield* adapter.openSession(open).pipe(Scope.provide(runtimeScope));
  const queue = yield* Effect.acquireRelease(
    Queue.unbounded<ProviderAdapterV2Event>(),
    Queue.shutdown,
  );
  const observed: ProviderAdapterV2Event[] = [];
  const eventFiber = yield* runtime.events.pipe(
    Stream.runForEach((event) => {
      observed.push(event);
      return Queue.offer(queue, event);
    }),
    Effect.forkScoped,
  );
  const providerThread = yield* runtime.ensureThread(open);
  yield* Deferred.await(fake.watching);
  const take = (predicate: (event: ProviderAdapterV2Event) => boolean) =>
    Stream.fromQueue(queue).pipe(Stream.filter(predicate), Stream.runHead);
  return {
    fake,
    adapter,
    open,
    runtime,
    runtimeScope,
    providerThread,
    take,
    observed,
    eventFiber,
    homeDirectory,
  };
});

describe("Albedo T3 adapter", () => {
  it.effect.each([
    "compacted",
    "unchanged",
    "failed",
    "lost_reply",
    "running",
    "interrupted",
    "unsent",
    "claimed_unsent",
  ] as const)("recovers native compaction with the same action identity when %s", (state) =>
    Effect.gen(function* () {
      const { fake, adapter, open, runtime, runtimeScope, providerThread, take } = yield* setup;
      const input = turnInput(providerThread);
      const message = { ...input.message, text: "/compact" };
      const nativeBefore = yield* fake.client.readSession(
        providerThread.nativeThreadRef!.nativeId!,
      );
      if (state === "lost_reply") fake.loseCompactionReply();
      if (state === "running" || state === "interrupted") fake.setCompactionState(state);
      const prepared =
        state === "claimed_unsent"
          ? yield* (yield* CompactionStore.AlbedoCompactionStore).claim({
              providerInstanceId: instanceId,
              runId: input.runId,
              messageId: message.messageId,
              sessionId: providerThread.nativeThreadRef!.nativeId!,
            })
          : null;
      if (state === "unchanged" || state === "failed")
        fake.setCompactionResult({
          selection_applied: true,
          effective_strategy: "summary",
          state,
          observation: null,
          failure:
            state === "failed"
              ? { code: "strategy_failed", detail: "Compaction strategy failed." }
              : null,
        });
      expect(runtime.compactThread).toBeDefined();
      let firstTurn: ProviderAdapterV2Event | undefined;
      if (state !== "unsent" && state !== "claimed_unsent") {
        const start = runtime.compactThread!({ ...input, message }).pipe(Effect.result);
        const first = yield* Effect.gen(function* () {
          if (state !== "running") return yield* start;
          const wait = yield* start.pipe(Effect.forkScoped);
          yield* Deferred.await(fake.compactionStarted);
          fake.setCompactionState("completed");
          yield* TestClock.adjust("200 millis");
          return yield* Fiber.join(wait);
        });
        expect(first._tag).toBe(state === "lost_reply" ? "Failure" : "Success");
        if (first._tag === "Failure") {
          expect(first.failure).toMatchObject({
            _tag: "ProviderAdapterTurnStartError",
            outcomeUnresolved: true,
          });
        } else {
          firstTurn = Option.getOrThrow(yield* take((event) => event.type === "turn.terminal"));
        }
      }
      yield* Scope.close(runtimeScope, Exit.void);
      const reattached = yield* adapter.openSession(open);
      const recovered = yield* Effect.acquireRelease(
        Queue.unbounded<ProviderAdapterV2Event>(),
        Queue.shutdown,
      );
      yield* reattached.events.pipe(
        Stream.runForEach((event) => Queue.offer(recovered, event)),
        Effect.forkScoped,
      );
      yield* reattached.ensureThread({ ...open, existingProviderThread: providerThread });
      let rebuilt = 0;
      const resumed = yield* reattached.resumeTurn!({
        ...input,
        messageId: message.messageId,
        unsubmittedMessage: Effect.sync(() => {
          rebuilt++;
          return message;
        }),
      }).pipe(Effect.result);
      expect(resumed._tag).toBe("Success");
      const status = state === "failed" || state === "interrupted" ? "failed" : "completed";
      const events = yield* Stream.fromQueue(recovered).pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
      );
      const row = events.find(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );
      expect(row).toMatchObject({
        turnItem: { type: "compaction", status },
      });
      const terminal = events.find((event) => event.type === "turn.terminal");
      expect(terminal).toMatchObject({ status });
      if (state === "interrupted")
        expect(terminal).toMatchObject({ failure: { code: "compaction_interrupted" } });
      if (firstTurn !== undefined) expect(terminal).toEqual(firstTurn);
      if (state === "compacted" || state === "unsent")
        expect(row).toMatchObject({
          turnItem: {
            beforeTokenCount: 12000,
            afterTokenCount: 3000,
            summary: "Retained Python variables and the working plan.",
          },
        });
      expect(rebuilt).toBe(state === "unsent" ? 1 : 0);
      expect(fake.compactions).toEqual([
        {
          sessionId: providerThread.nativeThreadRef!.nativeId,
          actionId: prepared?.actionId ?? expect.stringMatching(/^[0-9a-f-]{36}$/),
        },
      ]);
      const reads =
        state === "lost_reply" ? 2 : state === "running" || state === "claimed_unsent" ? 1 : 0;
      expect(fake.compactionReads).toEqual(
        Array.from({ length: reads }, () => fake.compactions[0]),
      );
      expect(fake.submissions).toHaveLength(0);
      expect(fake.configurations).toHaveLength(0);
      expect(new Set(fake.creations.map((creation) => creation.sessionId))).toEqual(
        new Set([providerThread.nativeThreadRef!.nativeId]),
      );
      const nativeAfter = yield* fake.client.readSession(providerThread.nativeThreadRef!.nativeId!);
      expect(nativeAfter.kernel).toEqual(nativeBefore.kernel);
      expect(nativeAfter.history).toEqual(nativeBefore.history);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
  it.effect.each(["legacy", "expired"] as const)(
    "keeps a %s compaction unresolved without submitting a replacement",
    (state) =>
      Effect.gen(function* () {
        const { fake, runtime, providerThread } = yield* setup;
        const input = turnInput(providerThread);
        const message = { ...input.message, text: "/compact" };
        const key = {
          providerInstanceId: instanceId,
          runId: input.runId,
          messageId: message.messageId,
          sessionId: providerThread.nativeThreadRef!.nativeId!,
        };
        if (state === "legacy") {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO albedo_compactions
            (provider_instance_id, run_id, message_id, session_id)
            VALUES (${key.providerInstanceId}, ${key.runId}, ${key.messageId}, ${key.sessionId})`;
        } else {
          const store = yield* CompactionStore.AlbedoCompactionStore;
          yield* store.claim(key);
          fake.expireCompactionIdentities();
        }
        const error = yield* Effect.flip(
          runtime.resumeTurn!({ ...input, messageId: message.messageId }),
        );
        expect(error).toMatchObject({
          _tag: "ProviderAdapterTurnStartError",
          outcomeUnresolved: true,
        });
        expect(fake.compactions).toHaveLength(0);
        expect(fake.compactionReads).toHaveLength(state === "legacy" ? 0 : 1);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );
  it.effect("shares the collection subscription and detaches one runtime independently", () =>
    Effect.gen(function* () {
      const { fake, adapter, open, runtimeScope, providerThread } = yield* setup;
      const secondScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void));
      const second = yield* adapter
        .openSession({
          ...open,
          providerSessionId: ProviderSessionId.make("second-observer"),
          readAppThread: Effect.succeed(turnInput(providerThread).appThread),
        })
        .pipe(Scope.provide(secondScope));
      const queue = yield* Effect.acquireRelease(
        Queue.unbounded<ProviderAdapterV2Event>(),
        Queue.shutdown,
      );
      yield* second.events.pipe(
        Stream.runForEach((event) => Queue.offer(queue, event)),
        Effect.forkScoped,
      );
      yield* second.ensureThread({ ...open, existingProviderThread: providerThread });
      const native = {
        ...session(),
        id: "shared-helper",
        parent_id: providerThread.nativeThreadRef!.nativeId!,
        role: "First task",
      };
      fake.helpers.set(native.id, native);
      yield* fake.refreshHelpers;
      yield* Stream.fromQueue(queue).pipe(
        Stream.filter((event) => event.type === "subagent.updated"),
        Stream.runHead,
      );
      expect(fake.collectionSubscriptions()).toBe(1);
      yield* Scope.close(runtimeScope, Exit.void);
      fake.helpers.set(native.id, { ...native, role: "Continued independently" });
      yield* fake.refreshHelpers;
      const updated = Option.getOrThrow(
        yield* Stream.fromQueue(queue).pipe(
          Stream.filter(
            (event) =>
              event.type === "subagent.updated" &&
              event.subagent.prompt === "Continued independently",
          ),
          Stream.runHead,
        ),
      );
      expect(updated).toMatchObject({ backgroundOwnerThreadId: threadId });
      expect(fake.collectionSubscriptions()).toBe(1);
      expect(fake.submissions).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
  it.effect(
    "projects owned native helpers after the parent turn without completing idle work",
    () =>
      Effect.gen(function* () {
        const { fake, runtime, providerThread, take, observed, eventFiber } = yield* setup;
        yield* runtime.startTurn(turnInput(providerThread));
        const started = Option.getOrThrow(
          yield* take((event) => event.type === "provider_turn.updated"),
        );
        if (started.type !== "provider_turn.updated") throw new Error("Missing parent turn");
        yield* runtime.interruptTurn({ providerThread, providerTurnId: started.providerTurn.id });
        yield* take((event) => event.type === "turn.terminal");
        const rootId = providerThread.nativeThreadRef!.nativeId!;
        const child = {
          ...session(),
          id: "native-child",
          root_id: rootId,
          parent_id: rootId,
          name: "Research",
          role: "Review evidence",
        };
        const peer = {
          ...session(),
          id: "native-peer",
          started_by: child.id,
          workspace: "/peer-workspace",
          name: "Peer",
          model: "peer-model",
        };
        fake.helpers.set(child.id, child);
        fake.helpers.set(peer.id, peer);
        fake.helpers.set("unrelated", { ...session(), id: "unrelated" });
        yield* fake.refreshHelpers;
        const pending = Option.getOrThrow(
          yield* take(
            (event) =>
              event.type === "provider_thread.updated" &&
              event.providerThread.pendingBackgroundTasks?.length === 2,
          ),
        );
        const peerEvent = observed.find(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "subagent" &&
            event.turnItem.title === "Peer",
        );
        expect(peerEvent).toMatchObject({
          backgroundOwnerThreadId: threadId,
          turnItem: { status: "idle", completedAt: null },
        });
        const helpers = observed.filter((event) => event.type === "subagent.updated");
        expect(helpers).toHaveLength(2);
        if (pending.type !== "provider_thread.updated") throw new Error("Missing helper tasks");
        const working = helpers.map((event) => ({
          ...child,
          id: event.subagent.nativeTaskRef!.nativeId!,
          status: { ...child.status, phase: "running" as const, run_id: "helper-run" },
        }));
        for (const helper of working) fake.helpers.set(helper.id, helper);
        yield* fake.refreshHelpers;
        yield* take(
          (event) =>
            event.type === "provider_thread.updated" &&
            event.providerThread.pendingBackgroundTasks?.length === 2,
        );
        const latestItems = new Map(
          observed.flatMap((event) =>
            event.type === "turn_item.updated"
              ? [[event.turnItem.id, event.turnItem] as const]
              : [],
          ),
        );
        expect(
          derivePendingBackgroundWork({
            latestRun: { id: turnInput(providerThread).runId, ordinal: 1, status: "completed" },
            providerThreads: [pending.providerThread],
            turnItems: [...latestItems.values()],
          }),
        ).toHaveLength(2);
        fake.helpers.set(child.id, child);
        fake.helpers.set(peer.id, peer);
        expect(helpers[1]?.subagent.parentNodeId).toBe(helpers[0]?.subagent.id);
        expect(
          helpers.every(
            (event) => event.subagent.runId === null && event.subagent.completedAt === null,
          ),
        ).toBe(true);
        const children = observed
          .filter((event) => event.type === "app_thread.created")
          .slice(0, 2);
        expect(children).toMatchObject([
          { createOnly: true, appThread: { modelSelection: { model: "fixture/fixture-model" } } },
          {
            createOnly: true,
            appThread: {
              modelSelection: { model: "fixture/peer-model" },
              worktreePath: "/peer-workspace",
            },
          },
        ]);
        fake.helpers.set(peer.id, { ...peer, closed: true });
        yield* fake.refreshHelpers;
        const closed = Option.getOrThrow(
          yield* take(
            (event) =>
              event.type === "subagent.updated" &&
              event.subagent.progress?.startsWith("Closed in Albedo") === true,
          ),
        );
        expect(closed).toMatchObject({
          subagent: {
            id: helpers[1]?.subagent.id,
            childThreadId: helpers[1]?.subagent.childThreadId,
            status: "idle",
            completedAt: null,
            startedAt: helpers[1]?.subagent.startedAt,
          },
        });
        yield* fake.endHelperStream(peer.id);
        yield* TestClock.adjust("4 seconds");
        expect(eventFiber.pollUnsafe()).toBeUndefined();
        expect(fake.collectionSubscriptions()).toBe(1);
        expect(fake.submissions).toHaveLength(1);
        expect(observed.filter((event) => event.type === "turn.terminal")).toHaveLength(1);
        yield* fake.sendHelper(child.id, [
          {
            type: "turn_completed",
            sequence: 1,
            data: {
              run_id: "helper-run",
              state: "completed",
              input_ids: [],
              input_count: 0,
              truncated: false,
            },
          },
        ]);
        yield* take(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "system_notice" &&
            event.turnItem.message.startsWith("Native turn completed"),
        );
        const completed = observed.findLast(
          (event) => event.type === "provider_thread.updated" && event.sessionScoped,
        );
        expect(completed).toMatchObject({
          pendingBackgroundWork: false,
          providerThread: { pendingBackgroundTasks: [] },
        });
        expect(observed).toContainEqual(
          expect.objectContaining({
            type: "subagent.updated",
            subagent: expect.objectContaining({
              nativeTaskRef: expect.objectContaining({ driver: "albedo", nativeId: child.id }),
              status: "completed",
            }),
          }),
        );
        const completedNative = fake.helpers.get(child.id)!;
        fake.helpers.set(child.id, {
          ...completedNative,
          cursor: { ...completedNative.cursor!, sequence: completedNative.cursor!.sequence + 1 },
        });
        yield* fake.refreshHelpers;
        const unresolved = Option.getOrThrow(
          yield* take(
            (event) =>
              event.type === "provider_thread.updated" &&
              event.providerThread.pendingBackgroundTasks?.length === 1,
          ),
        );
        expect(unresolved).toMatchObject({ pendingBackgroundWork: true });
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );
  it.effect("binds tools before input and refuses another provider's tool identity", () =>
    Effect.gen(function* () {
      const mcp = yield* McpProviderSessions.McpProviderSessions;
      const config = {
        environmentId: EnvironmentId.make("test-env"),
        threadId,
        providerSessionId: "mcp-credential-session",
        providerInstanceId: instanceId,
        endpoint: "http://127.0.0.1:4321/mcp",
        authorizationHeader: "Bearer native-owner-fixture",
        browserToolsAvailable: false,
      };
      yield* mcp.set(config);
      const { runtime, providerThread, homeDirectory, fake } = yield* setup;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const binding = path.join(
        homeDirectory,
        "t3-code",
        "v1",
        "sessions",
        `${providerThread.nativeThreadRef!.nativeId}.json`,
      );
      expect(JSON.parse(yield* fs.readFileString(binding))).toMatchObject({
        nativeSessionId: providerThread.nativeThreadRef!.nativeId,
        threadId,
        authorizationHeader: config.authorizationHeader,
      });
      yield* mcp.set({
        ...config,
        providerInstanceId: ProviderInstanceId.make("another-provider"),
      });
      expect(yield* Effect.flip(runtime.startTurn(turnInput(providerThread)))).toMatchObject({
        detail: "Albedo's T3 tool identity belongs to another provider or thread",
      });
      expect(fake.submissions).toHaveLength(0);
      yield* mcp.set({ ...config, authorizationHeader: "Bearer rotated-owner-fixture" });
      yield* runtime.startTurn(turnInput(providerThread));
      expect(JSON.parse(yield* fs.readFileString(binding))).toMatchObject({
        authorizationHeader: "Bearer rotated-owner-fixture",
      });
      expect(JSON.stringify(fake.submissions)).not.toContain("Bearer");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
  it.effect("reports native jobs and activity outside a T3 turn without producing completion", () =>
    Effect.gen(function* () {
      const { fake, runtime, take, observed } = yield* setup;
      const native = session();
      yield* fake.send([
        {
          type: "status",
          sequence: 0,
          data: { ...native.status, phase: "running", run_id: "native-wakeup" },
        },
        {
          type: "kernel",
          sequence: 0,
          data: {
            kernel: {
              ...native.kernel,
              state: "attached",
              live_job_count: 2,
              running_jobs: [
                {
                  id: "cell-1",
                  pid: null,
                  command: "Native Python work",
                  kind: "cell",
                  parent_id: null,
                  started_at: 1,
                },
              ],
            },
          },
        },
      ]);
      const observedThread = Option.getOrThrow(
        yield* take(
          (event) =>
            event.type === "provider_thread.updated" &&
            event.providerThread.pendingBackgroundTasks?.length === 3,
        ),
      );
      expect(observedThread).toMatchObject({ pendingBackgroundWork: true, sessionScoped: true });
      expect(runtime.providerSession.extensionStatuses).toContainEqual({
        key: "albedo.execution",
        text: "Albedo is running native work outside a T3 turn",
      });
      expect(yield* runtime.hasPendingBackgroundWork!).toBe(true);
      expect(observed.some((event) => event.type === "turn.terminal")).toBe(false);
      yield* fake.send([
        { type: "status", sequence: 0, data: native.status },
        {
          type: "kernel",
          sequence: 0,
          data: {
            kernel: {
              ...native.kernel,
              state: "attached",
              live_job_count: null,
              running_jobs: null,
            },
          },
        },
      ]);
      const unresolved = Option.getOrThrow(
        yield* take((event) => event.type === "provider_thread.updated"),
      );
      expect(unresolved).toMatchObject({
        pendingBackgroundWork: true,
        providerThread: { pendingBackgroundTasks: [{ taskId: "albedo:unresolved-jobs" }] },
      });
      expect(yield* runtime.hasPendingBackgroundWork!).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
  it.effect("cancels an accepted input before a native turn exists", () =>
    Effect.gen(function* () {
      const { runtime, providerThread, take } = yield* setup;
      yield* runtime.startTurn(turnInput(providerThread));
      const started = Option.getOrThrow(
        yield* take((event) => event.type === "provider_turn.updated"),
      );
      if (started.type !== "provider_turn.updated") throw new Error("Missing turn");
      expect(started.providerTurn.nativeTurnRef).toBeNull();
      yield* runtime.interruptTurn({ providerThread, providerTurnId: started.providerTurn.id });
      expect(
        Option.getOrThrow(yield* take((event) => event.type === "turn.terminal")),
      ).toMatchObject({ status: "cancelled" });
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
  it.effect.each([
    "same-turn",
    "later-turn",
    "lost-acknowledgement",
    "restart",
    "different-model",
    "stop",
    "later-failure",
    "cancelled-primary",
  ] as const)("tracks steering through native delivery and recovery (%s)", (scenario) =>
    Effect.gen(function* () {
      const { fake, adapter, open, runtime, runtimeScope, providerThread, take, observed } =
        yield* setup;
      const input = turnInput(providerThread);
      yield* runtime.startTurn(input);
      if (scenario !== "cancelled-primary") yield* fake.begin;
      const started = Option.getOrThrow(
        yield* take(
          (event) =>
            event.type === "provider_turn.updated" &&
            (scenario === "cancelled-primary" ||
              event.providerTurn.nativeTurnRef?.nativeId === nativeRunId),
        ),
      );
      if (started.type !== "provider_turn.updated") throw new Error("Missing native turn");
      const steer = {
        threadId: input.threadId,
        runId: input.runId,
        providerThread,
        providerTurnId: started.providerTurn.id,
        message: {
          ...input.message,
          messageId: MessageId.make("steering-message"),
          text: "Preserve this correction.",
        },
        ...(scenario === "different-model"
          ? { modelSelection: { ...input.modelSelection, model: "another-model" } }
          : {}),
      };
      if (scenario === "different-model") {
        expect((yield* Effect.flip(runtime.steerTurn(steer)))._tag).toBe(
          "ProviderAdapterSteerDeclinedError",
        );
        expect(fake.submissions).toHaveLength(1);
        return;
      }
      if (scenario === "lost-acknowledgement" || scenario === "restart") {
        fake.loseInputReply();
        yield* Effect.flip(runtime.steerTurn(steer));
      } else yield* runtime.steerTurn(steer);
      expect(fake.submissions).toHaveLength(2);
      if (scenario === "restart") {
        yield* Scope.close(runtimeScope, Exit.void);
        const restored = yield* adapter.openSession(open);
        yield* restored.resumeThread({ providerThread });
        const completed = yield* Deferred.make<ProviderAdapterV2Event>();
        yield* restored.events.pipe(
          Stream.runForEach((event) =>
            event.type === "turn.terminal" ? Deferred.succeed(completed, event) : Effect.void,
          ),
          Effect.forkScoped,
        );
        const { message, ...resumeInput } = input;
        yield* restored.resumeTurn!({ ...resumeInput, messageId: message.messageId });
        yield* fake.beginInput(1);
        yield* fake.finishInput(0, "completed");
        yield* fake.finishInput(1, "completed");
        expect(yield* Deferred.await(completed)).toMatchObject({ status: "completed" });
        expect(fake.submissions).toHaveLength(2);
        return;
      }
      yield* runtime.steerTurn(steer);
      expect(fake.submissions).toHaveLength(2);
      if (scenario === "cancelled-primary") {
        yield* fake.client.cancelInput(fake.submissions[0]!);
        yield* fake.beginInput(1, "correction-only-native-turn");
        yield* fake.finishInput(1, "completed");
        expect(
          Option.getOrThrow(yield* take((event) => event.type === "turn.terminal")),
        ).toMatchObject({ status: "cancelled" });
        expect(
          observed.some(
            (event) => event.type === "message.updated" && event.message.text === "Kept.",
          ),
        ).toBe(true);
        return;
      }
      if (scenario === "stop") {
        const stopping = yield* runtime
          .interruptTurn({ providerThread, providerTurnId: started.providerTurn.id })
          .pipe(Effect.forkChild);
        yield* take((event) => event.type === "steer.updated" && event.status === "cancelled");
        expect(stopping.pollUnsafe()).toBeUndefined();
        yield* fake.finishInput(0, "interrupted");
        yield* Fiber.join(stopping);
        expect(fake.decisions.get(fake.submissions[1]!.inputId)?.delivery).toBe("cancelled");
        return;
      }
      const later = scenario === "later-turn" || scenario === "later-failure";
      if (later) {
        yield* fake.finishInput(0, scenario === "later-failure" ? "abandoned" : "completed");
        yield* take((event) => event.type === "message.updated" && event.message.text === "Kept.");
        expect(yield* runtime.hasPendingBackgroundWork!).toBe(true);
        expect(observed.filter((event) => event.type === "turn.terminal")).toEqual([]);
      }
      yield* fake.beginInput(1, later ? "later-native-turn" : nativeRunId);
      yield* take((event) => event.type === "steer.updated" && event.status === "completed");
      yield* fake.finishInput(0, scenario === "later-failure" ? "abandoned" : "completed");
      yield* fake.finishInput(1, "completed");
      expect(
        Option.getOrThrow(yield* take((event) => event.type === "turn.terminal")),
      ).toMatchObject({ status: scenario === "later-failure" ? "failed" : "completed" });
      yield* runtime.steerTurn(steer);
      expect(fake.submissions).toHaveLength(2);
      expect(fake.submissions[1]?.request).toMatchObject({ text: "Preserve this correction." });
      if (scenario === "later-turn")
        expect(
          observed.some(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.nativeItemRef?.nativeId?.includes("later-native-turn"),
          ),
        ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
  it.effect.each(["completed", "interrupted", "abandoned"] as const)(
    "projects native %s without treating admission or idle as completion",
    (state) =>
      Effect.gen(function* () {
        const { fake, runtime, providerThread, take, observed } = yield* setup;
        yield* runtime.startTurn(turnInput(providerThread));
        yield* fake.send([
          {
            type: "status",
            sequence: 0,
            data: {
              phase: "idle",
              run_id: null,
              interrupt_requested: false,
              blocking_reason: null,
            },
          },
        ]);
        yield* fake.begin;
        yield* fake.send([
          {
            type: "text",
            sequence: 0,
            data: { run_id: nativeRunId, message_id: "live-reply", text: "Kept." },
          },
        ]);
        yield* take((event) => event.type === "message.updated" && event.message.streaming);
        expect(observed.some((event) => event.type === "turn.terminal")).toBe(false);
        yield* fake.finish(state);
        const terminal = yield* take((event) => event.type === "turn.terminal");
        expect(Option.getOrThrow(terminal)).toMatchObject({
          type: "turn.terminal",
          status: state === "abandoned" ? "failed" : state,
        });
        const replies = observed.filter((event) => event.type === "message.updated");
        expect(new Set(replies.map((event) => event.message.id)).size).toBe(1);
        expect(replies.at(-1)?.message).toMatchObject({ text: "Kept.", streaming: false });
        expect(fake.submissions).toHaveLength(1);
        expect(fake.creations[0]?.request).toMatchObject({
          workspace: "/workspace",
          provider_profile: "fixture",
          model: "fixture-model",
        });
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "waits for the durable interrupted outcome after the stop request is acknowledged",
    () =>
      Effect.gen(function* () {
        const { fake, runtime, providerThread, take } = yield* setup;
        yield* runtime.startTurn(turnInput(providerThread));
        yield* fake.begin;
        const started = Option.getOrThrow(
          yield* take(
            (event) =>
              event.type === "provider_turn.updated" &&
              event.providerTurn.nativeTurnRef?.nativeId === nativeRunId,
          ),
        );
        if (started.type !== "provider_turn.updated") throw new Error("Missing turn");
        fake.helpers.set("owned-helper", {
          ...session(),
          id: "owned-helper",
          parent_id: providerThread.nativeThreadRef!.nativeId!,
        });
        const stop = yield* runtime
          .interruptTurn({
            providerThread,
            providerTurnId: started.providerTurn.id,
            requestRuntimeRestart: true,
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(fake.interrupted);
        expect(stop.pollUnsafe()).toBeUndefined();
        yield* fake.finish("interrupted");
        yield* Fiber.join(stop);
        expect(fake.helpers.get("owned-helper")?.closed).toBe(true);
        fake.helpers.set("later-helper", {
          ...session(),
          id: "later-helper",
          started_by: providerThread.nativeThreadRef!.nativeId!,
        });
        yield* runtime.interruptTurn({
          providerThread,
          providerTurnId: started.providerTurn.id,
          requestRuntimeRestart: true,
        });
        expect(fake.helpers.get("later-helper")?.closed).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect.each([
    { lostAcknowledgement: false, stop: false },
    { lostAcknowledgement: true, stop: false },
    { lostAcknowledgement: true, stop: true },
    { lostAcknowledgement: false, stop: false, beforePreparation: "idle" },
    { lostAcknowledgement: false, stop: false, beforePreparation: "busy" },
  ])(
    "recovers the stored native input without another submission (%j)",
    ({ lostAcknowledgement, stop, ...scenario }) =>
      Effect.gen(function* () {
        const { fake, adapter, open, runtime, runtimeScope, providerThread, take } = yield* setup;
        const input = turnInput(providerThread);
        const beforePreparation = "beforePreparation" in scenario;
        if (lostAcknowledgement) {
          fake.loseInputReply();
          expect(yield* Effect.flip(runtime.startTurn(input))).toMatchObject({
            _tag: "ProviderAdapterTurnStartError",
            outcomeUnresolved: true,
          });
        } else if (!beforePreparation) yield* runtime.startTurn(input);
        if (!beforePreparation) yield* fake.begin;
        if (!lostAcknowledgement && !beforePreparation)
          yield* take(
            (event) =>
              event.type === "provider_turn.updated" &&
              event.providerTurn.nativeTurnRef?.nativeId === nativeRunId,
          );
        if ("beforePreparation" in scenario && scenario.beforePreparation === "busy") {
          yield* fake.send([
            {
              type: "status",
              sequence: 0,
              data: { ...session().status, phase: "running", run_id: "native-work" },
            },
          ]);
        }
        yield* Scope.close(runtimeScope, Exit.void);
        const resumed = yield* adapter.openSession(open);
        yield* resumed.resumeThread({ providerThread });
        if (stop) {
          fake.helpers.set("owned-helper", {
            ...session(),
            id: "owned-helper",
            parent_id: providerThread.nativeThreadRef!.nativeId!,
          });
          fake.helpers.set("unrelated", { ...session(), id: "unrelated" });
          yield* fake.finish("interrupted");
          yield* resumed.stopThread!({ providerThread });
          expect(fake.helpers.get("owned-helper")?.closed).toBe(true);
          expect(fake.helpers.get("unrelated")?.closed).toBe(false);
          expect(fake.submissions).toHaveLength(1);
          return;
        }
        const done = yield* Deferred.make<ProviderAdapterV2Event>();
        yield* resumed.events.pipe(
          Stream.runForEach((event) =>
            event.type === "turn.terminal" ? Deferred.succeed(done, event) : Effect.void,
          ),
          Effect.forkScoped,
        );
        const { message, ...resumeInput } = input;
        if (beforePreparation) {
          expect(
            yield* Effect.flip(
              resumed.resumeTurn!({ ...resumeInput, messageId: message.messageId }),
            ),
          ).toMatchObject({
            _tag: "ProviderAdapterProtocolError",
          });
          expect(fake.submissions).toHaveLength(0);
        }
        let prepared = 0;
        const recovery = resumed.resumeTurn!({
          ...resumeInput,
          messageId: message.messageId,
          unsubmittedMessage: Effect.sync(() => {
            prepared++;
            if (!beforePreparation)
              throw new Error("Accepted input must not prepare context again");
            return message;
          }),
        });
        if ("beforePreparation" in scenario && scenario.beforePreparation === "busy") {
          expect((yield* Effect.flip(recovery)).message).toContain("native work in progress");
          expect(fake.submissions).toHaveLength(0);
          expect(prepared).toBe(0);
          return;
        }
        yield* recovery;
        expect(prepared).toBe(beforePreparation ? 1 : 0);
        if (beforePreparation) {
          expect(fake.submissions[0]?.request).toMatchObject({
            kind: "message",
            text: expect.stringContaining(message.text),
          });
          yield* fake.begin;
        }
        yield* fake.finish("completed");
        expect(yield* Deferred.await(done)).toMatchObject({ status: "completed" });
        expect(fake.submissions).toHaveLength(1);
        expect(fake.submissions[0]?.request).toMatchObject({
          kind: "message",
          text: expect.stringContaining(message.text),
        });
        expect(new Set(fake.creations.map((entry) => entry.sessionId)).size).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("refuses unsupported policies and wrong workspaces before input dispatch", () =>
    Effect.gen(function* () {
      const { fake, adapter, open, runtime, providerThread } = yield* setup;
      for (const runtimePolicy of [
        { ...policy, interactionMode: "plan" as const },
        { ...policy, runtimeMode: "approval-required" as const },
      ]) {
        expect((yield* Effect.flip(adapter.openSession({ ...open, runtimePolicy })))._tag).toBe(
          "ProviderAdapterProtocolError",
        );
      }
      expect(
        (yield* Effect.flip(
          runtime.startTurn({
            ...turnInput(providerThread),
            runtimePolicy: { ...policy, cwd: "/other-assignment" },
          }),
        )).message,
      ).toContain("workspace");
      expect(
        (yield* Effect.flip(
          runtime.startTurn({
            ...turnInput(providerThread),
            modelSelection: { instanceId, model: "missing/fixture-model" },
          }),
        )).message,
      ).toContain("profile");
      expect(fake.submissions).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
