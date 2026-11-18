import { expect, it } from "@effect/vitest";
import {
  CommandId,
  ThreadId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RunAttemptId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { CommandReceiptStoreV2 } from "./CommandReceiptStore.ts";
import { EffectOutboxV2, type OrchestrationEffectV2 } from "./EffectOutbox.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import * as StopConfirmation from "./StopConfirmation.ts";

const threadId = ThreadId.make("owner");
const commandId = CommandId.make("stop-owner");
const childId = ThreadId.make("child");
const request = {
  type: "provider-turn.interrupt" as const,
  providerSessionId: ProviderSessionId.make("session"),
  providerThreadId: ProviderThreadId.make("native-thread"),
  providerTurnId: ProviderTurnId.make("native-turn"),
};
const row = (id: string, owner: ThreadId, command: CommandId): OrchestrationEffectV2 => ({
  id,
  threadId: owner,
  commandId: command,
  request,
  status: "running",
  attemptCount: 1,
  availableAt: "1970-01-01T00:00:00.000Z",
  createdAt: "1970-01-01T00:00:00.000Z",
  updatedAt: "1970-01-01T00:00:00.000Z",
  completedAt: null,
  leaseOwner: "worker",
  lastError: null,
});

it.effect.each([
  "confirmed",
  "failed",
  "cancelled",
  "missing",
  "unresponsive",
  "active",
  "remote",
] as const)("confirms the stop result independently of its acknowledgement: %s", (mode) =>
  Effect.gen(function* () {
    const observed = yield* Deferred.make<void>();
    const terminal = yield* Deferred.make<void>();
    const effects = new Map([
      [commandId, row("root-effect", threadId, commandId)],
      [
        CommandId.make(`${commandId}:stop:${childId}`),
        {
          ...row("child-effect", childId, CommandId.make(`${commandId}:stop:${childId}`)),
          request: {
            ...request,
            type: "provider-runtime.stop" as const,
            providerTurnId: null,
            runId: RunId.make("child-run"),
            attemptId: RunAttemptId.make("child-attempt"),
          },
        },
      ],
    ]);
    const visited: ThreadId[] = [];
    const confirm = yield* StopConfirmation.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(CommandReceiptStoreV2)({
            getByCommandId: (id) => {
              if (mode === "unresponsive" && id === "child-effect:background-work-settled")
                return Effect.succeedNone;
              const child = id.includes("child");
              return Effect.succeedSome({
                commandId: id,
                threadId: child ? childId : threadId,
                commandType: id.endsWith(":background-work-settled")
                  ? "thread.background-work.settle"
                  : "thread.stop",
                acceptedAt: DateTime.makeUnsafe(0),
                status: "accepted",
                resultSequence: 1,
                error: null,
              });
            },
          }),
          Layer.mock(EffectOutboxV2)({
            listByCommandId: (id) => Effect.succeed(effects.has(id) ? [effects.get(id)!] : []),
            awaitSettled: (id) =>
              id === "child-effect"
                ? Deferred.succeed(observed, undefined).pipe(
                    Effect.andThen(Deferred.await(terminal)),
                  )
                : Effect.void,
            get: (id) => {
              const effect = [...effects.values()].find((value) => value.id === id)!;
              if (id === "child-effect" && mode === "missing") return Effect.succeedNone;
              return Effect.succeedSome({
                ...effect,
                status:
                  id === "child-effect" && (mode === "failed" || mode === "cancelled")
                    ? mode
                    : "succeeded",
              });
            },
          }),
          Layer.mock(ProjectionStoreV2)({
            getThreadRecords: (id) => {
              visited.push(id);
              return Effect.succeed({
                thread: { activeProviderThreadId: null },
                providerThreads: [],
                turnItems: [],
                runs: id === childId && mode === "active" ? [{ status: "running" }] : [],
                subagents:
                  id === threadId
                    ? [{ origin: "app_owned", childThreadId: childId }]
                    : mode === "remote"
                      ? [{ origin: "app_owned", childThreadId: null, remoteChild: {} }]
                      : [],
              } as never);
            },
          }),
        ),
      ),
    );
    const waiting = yield* confirm({ commandId, threadId }).pipe(Effect.result, Effect.forkScoped);
    yield* Deferred.await(observed);
    expect(waiting.pollUnsafe()).toBeUndefined();
    expect(visited).toEqual([threadId]);
    yield* Deferred.succeed(terminal, undefined);
    const result = yield* Fiber.join(waiting);
    expect(result).toMatchObject(
      mode === "confirmed"
        ? { _tag: "Success" }
        : { _tag: "Failure", failure: { _tag: "StopConfirmationError" } },
    );
  }).pipe(Effect.scoped),
);
