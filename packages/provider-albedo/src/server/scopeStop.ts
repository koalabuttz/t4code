import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AlbedoClient } from "./AlbedoClient.ts";
import * as Collection from "./collection.ts";
import * as Replay from "./sessionReplay.ts";
import type { Session } from "./sessionProtocol.ts";

export class AlbedoStopUnconfirmed extends Schema.TaggedError<AlbedoStopUnconfirmed>()(
  "AlbedoStopUnconfirmed",
  { sessionId: Schema.String, reason: Schema.String },
) {
  override get message() {
    return `Albedo Stop is unresolved: ${this.reason}. Keep the existing assignment until its owned work is confirmed stopped.`;
  }
}

const idle = (native: Session) =>
  native.status.phase === "idle" &&
  native.status.run_id === null &&
  native.pending_inputs.length === 0;
const noJobs = (native: Session) =>
  native.kernel.state !== "lost" &&
  native.kernel.live_job_count === 0 &&
  native.kernel.running_jobs?.length === 0;
const closed = (native: Session) =>
  native.closed && idle(native) && noJobs(native) && native.kernel.state === "none";

const interrupt = Effect.fn("AlbedoScopeStop.interrupt")(function* (
  client: AlbedoClient["Service"],
  before: Session,
) {
  if (idle(before)) return before;
  const fail = (reason: string) => new AlbedoStopUnconfirmed({ sessionId: before.id, reason });
  const read = client.readSession(before.id).pipe(
    Effect.filterOrFail(
      (after) => after.cursor?.generation === before.cursor?.generation,
      () => fail("the native session restarted during Stop"),
    ),
  );
  yield* client
    .interruptSession(before.id, {
      run_id: before.status.run_id,
      through_input_order: before.input_order,
    })
    .pipe(
      Effect.catchTags({
        AlbedoTransportError: (cause) =>
          read.pipe(Effect.flatMap((after) => (idle(after) ? Effect.void : Effect.fail(cause)))),
      }),
    );
  const after = yield* read;
  if (idle(after)) return after;
  if (after.status.run_id !== before.status.run_id)
    return yield* fail("new native work arrived during interruption");
  let cursor = after.cursor ?? undefined;
  const settled = yield* client.watchSession(before.id, cursor).pipe(
    Stream.mapEffect(
      Effect.fn("AlbedoScopeStop.observeInterruption")(function* (batch) {
        const delivery = yield* Replay.prepare(before.id, cursor, batch);
        cursor = delivery.cursor;
        const observed = yield* read;
        if (!idle(observed) && observed.status.run_id !== before.status.run_id)
          return yield* fail("new native work arrived during interruption");
        return observed;
      }),
    ),
    Stream.filter(idle),
    Stream.runHead,
    Effect.timeoutOrElse({
      duration: "20 seconds",
      orElse: () => Effect.fail(fail("the native turn has not stopped")),
    }),
  );
  if (Option.isNone(settled)) return yield* fail("the stop observation stream ended");
  return settled.value;
});

export const stop = Effect.fn("AlbedoScopeStop.stop")(function* (
  client: AlbedoClient["Service"],
  rootId: string,
) {
  const fail = (reason: string) => new AlbedoStopUnconfirmed({ sessionId: rootId, reason });
  const initial = yield* client.readSession(rootId);
  const kernelId = initial.kernel.instance_id;
  const generation = initial.cursor?.generation;
  const unchanged = (native: Session) =>
    native.cursor?.generation === generation &&
    (native.kernel.instance_id === kernelId || native.kernel.state === "none");
  let mutations = 0;
  // Closing helpers and stopping jobs can deliver mail that wakes their owner.
  for (let pass = 0; pass < 8; pass++) {
    const before = yield* client.readSession(rootId);
    if (!unchanged(before)) return yield* fail("the owning runtime changed during Stop");
    if (!unchanged(yield* interrupt(client, before)))
      return yield* fail("the owning runtime changed during interruption");
    const graph = yield* Collection.readSnapshot(client);
    if (!graph.has(rootId)) return yield* fail("the owning session is missing from the collection");
    const helpers = Collection.owned(graph, rootId);
    if (helpers.length > 256) return yield* fail("the owned helper graph exceeds the stop limit");
    for (const helper of helpers) {
      const native = yield* client.readSession(helper.id);
      if (closed(native)) continue;
      if (++mutations > 512) return yield* fail("owned work keeps changing during Stop");
      yield* client.closeAgent(helper.id);
    }
    const root = yield* client.readSession(rootId);
    if (!unchanged(root)) return yield* fail("the owning runtime changed during helper cleanup");
    if (
      root.kernel.state === "lost" ||
      root.kernel.live_job_count === null ||
      root.kernel.running_jobs === null ||
      root.kernel.live_job_count !== root.kernel.running_jobs.length
    )
      return yield* fail("the complete native job list is unavailable");
    for (const job of root.kernel.running_jobs) {
      if (++mutations > 512) return yield* fail("owned work keeps changing during Stop");
      yield* client.stopJob(rootId, job.id);
    }
    const afterJobs = yield* client.readSession(rootId);
    if (!unchanged(afterJobs)) return yield* fail("the owning runtime changed during job cleanup");
    const after = yield* interrupt(client, afterJobs);
    const finalGraph = yield* Collection.readSnapshot(client);
    if (!finalGraph.has(rootId)) return yield* fail("the owning session disappeared during Stop");
    const remaining = Collection.owned(finalGraph, rootId);
    if (remaining.some((helper) => !helper.closed)) continue;
    for (const helper of remaining) {
      if (!closed(yield* client.readSession(helper.id)))
        return yield* fail("a closed helper still has unresolved work");
    }
    const confirmed = yield* client.readSession(rootId);
    if (!unchanged(confirmed)) return yield* fail("the owning runtime changed during Stop");
    if (idle(after) && idle(confirmed) && noJobs(confirmed)) return confirmed;
  }
  return yield* fail("native work continues to arrive after cleanup");
});
