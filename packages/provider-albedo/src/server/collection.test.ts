import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as Stream from "effect/Stream";
import { AlbedoClient, AlbedoProtocolError } from "./AlbedoClient.ts";
import { fakeDaemon } from "./adapter.test-fixtures.ts";
import * as Collection from "./collection.ts";
import * as Protocol from "./sessionProtocol.ts";
import { generation, session } from "./session.test-fixtures.ts";

const ready = {
  events: [
    { type: "ready", data: {} },
    { type: "reset", data: { reason: "initial" } },
  ],
} satisfies Protocol.CollectionBatch;
const activity = (sequence: number, phase: "running" | "idle" = "running", actor = generation) =>
  ({
    events: [
      {
        type: "activity",
        data: {
          session_id: session().id,
          cursor: { generation: actor, sequence },
          status: { ...session().status, phase, run_id: phase === "idle" ? null : "native-run" },
          current_progress: [],
        },
      },
    ],
  }) satisfies Protocol.CollectionBatch;

describe("Albedo native agent collection", () => {
  it.effect("opens a fresh shared subscription after exhausted reconnect attempts", () =>
    Effect.gen(function* () {
      const fake = yield* fakeDaemon;
      const attempts = yield* Effect.acquireRelease(Queue.unbounded<number>(), Queue.shutdown);
      let count = 0;
      const shared = yield* Collection.share(
        Effect.succeed(
          AlbedoClient.of({
            ...fake.client,
            watchSessions: () =>
              Stream.unwrap(
                Effect.gen(function* () {
                  const attempt = ++count;
                  yield* Queue.offer(attempts, attempt);
                  return attempt <= 4
                    ? Stream.fail(
                        new AlbedoProtocolError({
                          operation: "collection.watch",
                          reason: "invalid_response",
                        }),
                      )
                    : Stream.succeed(ready).pipe(Stream.concat(Stream.never));
                }),
              ),
          }),
        ),
      );
      const first = yield* shared;
      expect(yield* shared).toBe(first);
      const failed = yield* first.pipe(Stream.runDrain, Effect.exit, Effect.forkScoped);
      for (const expected of [1, 2, 3, 4]) {
        expect(yield* Queue.take(attempts)).toBe(expected);
        if (expected < 4) yield* TestClock.adjust("1 second");
      }
      expect(Exit.isFailure(yield* Fiber.join(failed))).toBe(true);
      const recovered = yield* shared;
      expect(recovered).not.toBe(first);
      const observed = yield* recovered.pipe(Stream.take(1), Stream.runCollect);
      expect(observed[0]?.has(session().id)).toBe(true);
      expect(yield* Queue.take(attempts)).toBe(5);
      expect(yield* shared).toBe(recovered);
    }).pipe(Effect.scoped),
  );
  it.effect(
    "refreshes after readiness, removes stale members, and ignores older actor updates",
    () =>
      Effect.gen(function* () {
        const fake = yield* fakeDaemon;
        const root = session();
        const child = { ...root, id: "native-child", parent_id: root.id };
        let reads = 0;
        const snapshots = yield* Collection.watch(
          AlbedoClient.of({
            ...fake.client,
            readSessions: () =>
              Effect.sync(() => ({
                items:
                  ++reads === 1
                    ? [root, child]
                    : [{ ...root, cursor: { generation, sequence: 6 } }],
                next: null,
              })),
            watchSessions: () =>
              Stream.fromArray([
                ready,
                activity(5),
                activity(3, "idle"),
                {
                  events: [
                    {
                      type: "invalidate",
                      data: { urls: ["/sessions"], session_ids: [child.id], scope_dirty: true },
                    },
                  ],
                },
                activity(4),
              ] satisfies Protocol.CollectionBatch[]),
          }),
        ).pipe(Stream.take(5), Stream.runCollect);
        expect(reads).toBe(2);
        expect(snapshots[0]!.size).toBe(2);
        expect(snapshots[2]!.get(root.id)?.status.phase).toBe("running");
        expect(snapshots[3]!.has(child.id)).toBe(false);
        expect(snapshots[4]!.get(root.id)?.cursor?.sequence).toBe(6);
        expect(snapshots[4]!.get(root.id)?.status.phase).toBe("idle");
        expect(snapshots[0]!.get(root.id)?.status.phase).toBe("idle");
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    "not_ready",
    "overflow",
    "closed",
    "paging_limit",
    "invalid_page",
    "size_limit",
  ] as const)("does not claim a complete graph after %s", (reason) =>
    Effect.gen(function* () {
      const fake = yield* fakeDaemon;
      const batches: Protocol.CollectionBatch[] =
        reason === "not_ready"
          ? [activity(1)]
          : reason === "overflow"
            ? [ready, { events: [{ type: "overflow", data: {} }] }]
            : [ready];
      const failure = yield* Effect.flip(
        Collection.watch(
          AlbedoClient.of({
            ...fake.client,
            readSessions: (page) =>
              Effect.succeed({
                items:
                  reason === "paging_limit"
                    ? []
                    : reason === "size_limit"
                      ? Array.from({ length: 8 }, (_, index) => ({
                          ...session(),
                          id: `${page?.next ?? "0"}/${index}`,
                          workspace: "x".repeat(65536),
                        }))
                      : reason === "invalid_page"
                        ? [session(), session()]
                        : [session()],
                next:
                  reason === "paging_limit"
                    ? "repeated"
                    : reason === "size_limit"
                      ? String(Number(page?.next ?? 0) + 1)
                      : null,
              }),
            watchSessions: () => Stream.fromArray(batches),
          }),
        ).pipe(Stream.runCollect),
      );
      expect(failure).toMatchObject({ reason });
    }).pipe(Effect.scoped),
  );

  it("associates children and owned peers without taking over unrelated roots or cycling", () => {
    const root = session();
    const rows = [
      root,
      { ...root, id: "child", parent_id: root.id },
      { ...root, id: "peer", root_id: "peer", started_by: "child" },
      { ...root, id: "grandchild", parent_id: "peer", root_id: "peer" },
      { ...root, id: "unrelated", root_id: "unrelated" },
      { ...root, id: "cycle-a", parent_id: "cycle-b" },
      { ...root, id: "cycle-b", parent_id: "cycle-a" },
    ];
    const snapshot = new Map(rows.map((row) => [row.id, row]));
    expect(Collection.owned(snapshot, root.id).map((row) => row.id)).toEqual([
      "child",
      "peer",
      "grandchild",
    ]);
    expect(Collection.owned(snapshot, "cycle-a").map((row) => row.id)).toEqual(["cycle-b"]);
  });
});
