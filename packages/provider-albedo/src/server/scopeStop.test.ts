import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { AlbedoClient, AlbedoTransportError } from "./AlbedoClient.ts";
import { fakeDaemon } from "./adapter.test-fixtures.ts";
import { generation, session, sessionId } from "./session.test-fixtures.ts";
import type { Session } from "./sessionProtocol.ts";
import * as ScopeStop from "./scopeStop.ts";

const running = (): Session => ({
  ...session(),
  status: { ...session().status, phase: "running", run_id: "native-run" },
  input_order: 3,
  kernel: { ...session().kernel, state: "attached", instance_id: "keep-python" },
});

describe("Albedo owned work Stop", () => {
  it.effect("waits beyond acknowledgement and keeps the root kernel", () =>
    Effect.gen(function* () {
      const fake = yield* fakeDaemon;
      const observing = yield* Deferred.make<void>();
      const ended = yield* Deferred.make<void>();
      let root = running();
      const client = AlbedoClient.of({
        ...fake.client,
        readSession: () => Effect.sync(() => root),
        readSessions: () => Effect.sync(() => ({ items: [root], next: null })),
        watchSession: () =>
          Stream.fromEffect(
            Deferred.succeed(observing, undefined).pipe(
              Effect.andThen(Deferred.await(ended)),
              Effect.as({
                generation,
                cursor: 1,
                events: [{ type: "status" as const, sequence: 1, data: session().status }],
              }),
            ),
          ),
      });
      const stopping = yield* ScopeStop.stop(client, sessionId).pipe(Effect.forkScoped);
      yield* Deferred.await(observing);
      expect(stopping.pollUnsafe()).toBeUndefined();
      root = { ...root, status: session().status };
      yield* Deferred.succeed(ended, undefined);
      const result = yield* Fiber.join(stopping);
      expect(result.kernel.instance_id).toBe("keep-python");
      expect(result.closed).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("closes owned children and peers, catches spawned helpers and job-driven wakeups", () =>
    Effect.gen(function* () {
      const fake = yield* fakeDaemon;
      let root = running();
      root = {
        ...root,
        kernel: {
          ...root.kernel,
          live_job_count: 1,
          running_jobs: [
            {
              id: "job",
              pid: 10,
              command: "work",
              kind: "command",
              parent_id: null,
              started_at: 0,
            },
          ],
        },
      };
      const child = { ...running(), id: "child", parent_id: root.id };
      const peer = { ...running(), id: "peer", started_by: root.id };
      const unrelated = {
        ...running(),
        id: "unrelated",
        root_id: root.id,
        started_by: "someone-else",
      };
      const helpers = new Map([child, peer, unrelated].map((row) => [row.id, row]));
      const stopped: string[] = [];
      const captured: Array<string | null> = [];
      const client = AlbedoClient.of({
        ...fake.client,
        readSession: (id) => Effect.sync(() => (id === root.id ? root : helpers.get(id)!)),
        readSessions: () => Effect.sync(() => ({ items: [root, ...helpers.values()], next: null })),
        interruptSession: (_id, request) =>
          Effect.sync(() => {
            captured.push(request.run_id);
            root = { ...root, status: session().status };
            return {
              run_id: request.run_id,
              state: "requested" as const,
              cancelled_input_ids: [],
              warnings: [],
            };
          }),
        closeAgent: (id) =>
          Effect.sync(() => {
            stopped.push(id);
            const value = {
              ...helpers.get(id)!,
              closed: true,
              status: session().status,
              kernel: session().kernel,
            };
            helpers.set(id, value);
            if (id === "child")
              helpers.set("late-child", { ...running(), id: "late-child", parent_id: "child" });
            return value;
          }),
        stopJob: () =>
          Effect.sync(() => {
            root = {
              ...root,
              input_order: 4,
              status: { ...running().status, run_id: "job-note-wakeup" },
              kernel: { ...root.kernel, live_job_count: 0, running_jobs: [] },
            };
            return root;
          }),
      });
      const result = yield* ScopeStop.stop(client, root.id);
      expect(stopped).toEqual(["child", "peer", "late-child"]);
      expect(captured).toEqual(["native-run", "job-note-wakeup"]);
      expect(result.kernel).toMatchObject({ instance_id: "keep-python", live_job_count: 0 });
      expect(helpers.get("unrelated")).toEqual(unrelated);
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    "lost_ack",
    "unknown_jobs",
    "kernel_changed",
    "actor_changed",
    "closed_but_running",
    "new_run",
  ] as const)("reconciles or refuses uncertain work: %s", (mode) =>
    Effect.gen(function* () {
      const fake = yield* fakeDaemon;
      let root = running();
      const child = { ...running(), id: "child", parent_id: root.id, closed: true };
      const client = AlbedoClient.of({
        ...fake.client,
        readSession: (id) => Effect.sync(() => (id === child.id ? child : root)),
        readSessions: () =>
          Effect.sync(() => ({
            items: mode === "closed_but_running" ? [root, child] : [root],
            next: null,
          })),
        interruptSession: (_id, request) =>
          Effect.gen(function* () {
            root = {
              ...root,
              status:
                mode === "new_run"
                  ? { ...running().status, run_id: "replacement" }
                  : session().status,
            };
            if (mode === "unknown_jobs")
              root = {
                ...root,
                kernel: { ...root.kernel, live_job_count: null, running_jobs: null },
              };
            if (mode === "kernel_changed")
              root = { ...root, kernel: { ...root.kernel, instance_id: "replacement" } };
            if (mode === "actor_changed")
              root = { ...root, cursor: { generation: "different-generation", sequence: 0 } };
            if (mode === "lost_ack")
              return yield* new AlbedoTransportError({
                operation: "session.interrupt",
                cause: "lost acknowledgement",
              });
            return {
              run_id: request.run_id,
              state: "requested" as const,
              cancelled_input_ids: [],
              warnings: [],
            };
          }),
        closeAgent: () => Effect.succeed(child),
      });
      const result = yield* ScopeStop.stop(client, root.id).pipe(Effect.result);
      expect(result).toMatchObject(
        mode === "lost_ack"
          ? { _tag: "Success", success: { kernel: { instance_id: "keep-python" } } }
          : { _tag: "Failure", failure: { _tag: "AlbedoStopUnconfirmed" } },
      );
    }).pipe(Effect.scoped),
  );
});
