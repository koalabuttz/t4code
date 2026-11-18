import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AlbedoClient } from "./AlbedoClient.ts";
import * as Protocol from "./sessionProtocol.ts";

type Summary = typeof Protocol.SessionSummary.Type;
export type Snapshot = ReadonlyMap<string, Summary>;
const encodeSummary = Schema.encodeSync(Schema.fromJsonString(Protocol.SessionSummary));
const characterLimit = 8 * 1024 * 1024;

export class AlbedoCollectionError extends Schema.TaggedError<AlbedoCollectionError>()(
  "AlbedoCollectionError",
  {
    reason: Schema.Literals([
      "not_ready",
      "overflow",
      "closed",
      "paging_limit",
      "invalid_page",
      "size_limit",
    ]),
  },
) {
  override get message() {
    return this.reason === "paging_limit" || this.reason === "size_limit"
      ? "Albedo's agent collection exceeds the supported paging limit. Its ownership graph is unresolved."
      : "Albedo's agent collection needs an authoritative refresh before its state can be trusted.";
  }
}

const read = Effect.fn("AlbedoCollection.read")(function* (client: AlbedoClient["Service"]) {
  const found = new Map<string, Summary>();
  const visited = new Set<string>();
  let characters = 0;
  let next: string | undefined;
  do {
    const page = yield* client.readSessions(next === undefined ? undefined : { next });
    for (const row of page.items) {
      if (found.has(row.id)) return yield* new AlbedoCollectionError({ reason: "invalid_page" });
      if (found.size >= 8192) return yield* new AlbedoCollectionError({ reason: "paging_limit" });
      characters += encodeSummary(row).length;
      if (characters > characterLimit)
        return yield* new AlbedoCollectionError({ reason: "size_limit" });
      found.set(row.id, row);
    }
    next = page.next ?? undefined;
    if (next !== undefined) {
      if (visited.has(next) || visited.size >= 1024)
        return yield* new AlbedoCollectionError({ reason: "paging_limit" });
      visited.add(next);
    }
  } while (next !== undefined);
  return { rows: found, characters };
});

export const readSnapshot = (client: AlbedoClient["Service"]) =>
  read(client).pipe(Effect.map(({ rows }) => rows));

// A collection cursor is per actor; only its replay stream can establish a turn's outcome.
export const watch = (client: AlbedoClient["Service"]) =>
  Stream.unwrap(
    Effect.sync(() => {
      let rows: Snapshot | null = null;
      let characters = 0;
      const apply = Effect.fn("AlbedoCollection.apply")(function* (
        batch: Protocol.CollectionBatch,
      ) {
        const ready = batch.events[0]?.type === "ready";
        if (rows === null && !ready)
          return yield* new AlbedoCollectionError({ reason: "not_ready" });
        if (batch.events.some((event) => event.type === "overflow"))
          return yield* new AlbedoCollectionError({ reason: "overflow" });
        let refresh = ready;
        for (const event of batch.events) {
          if (event.type === "invalidate") refresh = true;
          if (event.type === "activity") {
            const previous = rows?.get(event.data.session_id);
            if (previous?.cursor?.generation !== event.data.cursor.generation) refresh = true;
          }
          if (
            event.type === "mail" &&
            (!rows?.has(event.data.receiver_session_id) ||
              (event.data.sender_session_id !== null && !rows?.has(event.data.sender_session_id)))
          )
            refresh = true;
        }
        const replacement = refresh ? yield* read(client) : undefined;
        const updated = replacement?.rows ?? new Map(rows!);
        let retainedCharacters = replacement?.characters ?? characters;
        for (const event of batch.events) {
          if (event.type !== "activity") continue;
          const previous = updated.get(event.data.session_id);
          if (
            previous === undefined ||
            previous.cursor?.generation !== event.data.cursor.generation ||
            previous.cursor.sequence >= event.data.cursor.sequence
          )
            continue;
          const next = {
            ...previous,
            cursor: event.data.cursor,
            status: event.data.status,
            current_progress: event.data.current_progress,
          };
          retainedCharacters += encodeSummary(next).length - encodeSummary(previous).length;
          if (retainedCharacters > characterLimit)
            return yield* new AlbedoCollectionError({ reason: "size_limit" });
          updated.set(previous.id, next);
        }
        rows = updated;
        characters = retainedCharacters;
        return rows;
      });
      return client
        .watchSessions()
        .pipe(
          Stream.mapEffect(apply),
          Stream.concat(Stream.fail(new AlbedoCollectionError({ reason: "closed" }))),
        );
    }),
  );

export function owned(snapshot: Snapshot, rootId: string): ReadonlyArray<Summary> {
  const ownedIds = new Set([rootId]);
  const dependents = new Map<string, Summary[]>();
  for (const row of snapshot.values()) {
    const parent = row.parent_id ?? row.started_by;
    if (parent === null) continue;
    const children = dependents.get(parent) ?? [];
    children.push(row);
    dependents.set(parent, children);
  }
  const result: Summary[] = [];
  const pending = [rootId];
  for (let index = 0; index < pending.length; index++) {
    for (const child of dependents.get(pending[index]!) ?? []) {
      if (ownedIds.has(child.id)) continue;
      ownedIds.add(child.id);
      pending.push(child.id);
      result.push(child);
    }
  }
  return result;
}

export const share = Effect.fn("AlbedoCollection.share")(function* <E>(
  connect: Effect.Effect<AlbedoClient["Service"], E>,
) {
  const parentScope = yield* Effect.scope;
  const gate = yield* Semaphore.make(1);
  const open = Effect.fn("AlbedoCollection.open")(function* () {
    const scope = yield* Scope.fork(parentScope);
    let ended = false;
    const events = yield* Stream.unwrap(connect.pipe(Effect.map(watch))).pipe(
      Stream.retry(Schedule.recurs(3).pipe(Schedule.addDelay(() => Effect.succeed("1 second")))),
      Stream.ensuring(
        Effect.sync(() => {
          ended = true;
        }),
      ),
      Stream.broadcast({ capacity: 1, replay: 1, strategy: "sliding" }),
      Scope.provide(scope),
    );
    return { events, scope, ended: () => ended };
  });
  let current: Effect.Success<ReturnType<typeof open>> | undefined;
  return Effect.gen(function* () {
    if (current !== undefined && !current.ended()) return current.events;
    if (current !== undefined) yield* Scope.close(current.scope, Exit.void);
    current = yield* open();
    return current.events;
  }).pipe(gate.withPermit);
});
