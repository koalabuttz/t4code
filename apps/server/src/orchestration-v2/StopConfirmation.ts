import { CommandId, ThreadId } from "@t3tools/contracts";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { CommandReceiptStoreV2 } from "./CommandReceiptStore.ts";
import { EffectOutboxV2 } from "./EffectOutbox.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";

export class StopConfirmationError extends Schema.TaggedError<StopConfirmationError>()(
  "StopConfirmationError",
  { threadId: ThreadId, reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message() {
    return `Stop has not been confirmed: ${this.reason}. Keep the previous assignment until its work stops.`;
  }
}
const isStopConfirmationError = Schema.is(StopConfirmationError);

export const make = Effect.gen(function* () {
  const outbox = yield* EffectOutboxV2;
  const receipts = yield* CommandReceiptStoreV2;
  const projections = yield* ProjectionStoreV2;
  return Effect.fn("StopConfirmation.confirm")(
    function* (input: { readonly threadId: ThreadId; readonly commandId: CommandId }) {
      const pending = [{ ...input }];
      const visited = new Set<ThreadId>();
      for (let index = 0; index < pending.length; index++) {
        const target = pending[index]!;
        if (visited.has(target.threadId)) continue;
        if (visited.size >= 256)
          return yield* new StopConfirmationError({
            ...target,
            reason: "the delegated tree exceeds the confirmation limit",
          });
        visited.add(target.threadId);
        const fail = (reason: string) =>
          new StopConfirmationError({ threadId: target.threadId, reason });
        const receipt = yield* receipts.getByCommandId(target.commandId);
        if (
          Option.isNone(receipt) ||
          receipt.value.threadId !== target.threadId ||
          receipt.value.commandType !== "thread.stop" ||
          receipt.value.status !== "accepted"
        )
          return yield* fail("the stop command has no accepted receipt");
        const effects = yield* outbox.listByCommandId(target.commandId);
        for (const effect of effects) {
          yield* outbox.awaitSettled(effect.id);
          const settled = yield* outbox.get(effect.id);
          if (Option.isNone(settled) || settled.value.status !== "succeeded")
            return yield* fail("a stop effect failed, was cancelled, or lost its result");
          if (
            effect.request.type === "provider-turn.interrupt" ||
            effect.request.type === "provider-runtime.stop"
          ) {
            const confirmed = yield* receipts.getByCommandId(
              CommandId.make(`${effect.id}:background-work-settled`),
            );
            if (
              Option.isNone(confirmed) ||
              confirmed.value.status !== "accepted" ||
              confirmed.value.threadId !== target.threadId
            )
              return yield* fail("the provider has not confirmed the interruption");
          }
        }
        const records = yield* projections.getThreadRecords(
          target.threadId,
          ["runs", "providerThreads", "turnItems", "subagents"],
          {
            turnItemTypes: ["command_execution", "dynamic_tool", "subagent"],
            turnItemStatuses: ["pending", "running", "waiting"],
          },
        );
        if (
          records.runs.some((run) =>
            ["preparing", "starting", "running", "waiting"].includes(run.status),
          )
        )
          return yield* fail("the thread still has an active run");
        if (
          derivePendingBackgroundWork({
            latestRun: records.runs.findLast((run) => run.status !== "queued"),
            providerThreads: records.providerThreads,
            turnItems: records.turnItems,
            activeProviderThreadId: records.thread.activeProviderThreadId,
            runs: records.runs,
          }).length > 0
        )
          return yield* fail("the thread still reports background work");
        for (const task of records.subagents) {
          if (task.origin !== "app_owned") continue;
          if (task.childThreadId !== null) {
            pending.push({
              threadId: task.childThreadId,
              commandId: CommandId.make(`${input.commandId}:stop:${task.childThreadId}`),
            });
          } else if (task.remoteChild !== undefined) {
            return yield* fail("a linked worker has no confirmed remote stop");
          }
        }
      }
    },
    (effect, input) =>
      effect.pipe(
        Effect.timeoutOrElse({
          duration: "2 minutes",
          orElse: () =>
            Effect.fail(
              new StopConfirmationError({
                threadId: input.threadId,
                reason: "work has not stopped within the confirmation window",
              }),
            ),
        }),
        Effect.mapError((cause) =>
          isStopConfirmationError(cause)
            ? cause
            : new StopConfirmationError({
                threadId: input.threadId,
                reason: "the stop result is unavailable",
                cause,
              }),
        ),
      ),
  );
});
