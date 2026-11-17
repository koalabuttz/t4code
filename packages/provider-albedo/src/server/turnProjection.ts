import {
  ProviderDriverKind,
  type ProviderTurnId,
  type RunId,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import type { IdAllocatorV2 } from "@t3tools/provider-core/server/IdAllocator";
import type { ProviderAdapterV2TurnInput } from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type * as Protocol from "./sessionProtocol.ts";

export const driver = ProviderDriverKind.make("albedo");
export const providerRef = (nativeId: string) => ({
  driver,
  nativeId,
  strength: "strong" as const,
});
type Entry = (typeof Protocol.HistoryPage.Type.items)[number];
type Progress = (typeof Protocol.Session.Type.current_progress)[number];
type Tool = Extract<Protocol.Event, { type: "tool" }>["data"];
type Live = { readonly kind: "text" | "thinking"; readonly runId: string; readonly text: string };

export interface Projection {
  readonly cursor: Protocol.Cursor | null;
  readonly observedRunId: string | null;
  readonly history: ReadonlyMap<string, Entry>;
  readonly live: ReadonlyMap<string, Live>;
  readonly progress: ReadonlyMap<string, Progress>;
  readonly tools: ReadonlyMap<string, Tool>;
}

export class AlbedoProjectionError extends Schema.TaggedError<AlbedoProjectionError>()(
  "AlbedoProjectionError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}

export const empty = (): Projection => ({
  cursor: null,
  observedRunId: null,
  history: new Map(),
  live: new Map(),
  progress: new Map(),
  tools: new Map(),
});

export const reduce = Effect.fn("AlbedoProjection.reduce")(function* (
  previous: Projection,
  nativeRunId: string | null,
  events: ReadonlyArray<Protocol.Event>,
  cursor: Protocol.Cursor,
) {
  if (previous.cursor !== null && previous.cursor.generation !== cursor.generation)
    return yield* new AlbedoProjectionError({
      detail: "Albedo's generation changed without restoring its snapshot",
    });
  const history = new Map(previous.history);
  const live = new Map(previous.live);
  const progress = new Map(previous.progress);
  const tools = new Map(previous.tools);
  let observedRunId = previous.observedRunId;
  for (const event of events) {
    if (previous.cursor !== null && event.sequence <= previous.cursor.sequence) continue;
    switch (event.type) {
      case "status":
        observedRunId = event.data.run_id;
        break;
      case "message": {
        if (event.data.entry.turn_id !== nativeRunId) break;
        history.set(event.data.entry.id, event.data.entry);
        for (const id of event.data.replaces_live_ids ?? []) live.delete(id);
        break;
      }
      case "text":
      case "thinking": {
        if (event.data.run_id !== nativeRunId) break;
        const current = live.get(event.data.message_id);
        live.set(event.data.message_id, {
          kind: event.type,
          runId: event.data.run_id,
          text: (current?.text ?? "") + event.data.text,
        });
        break;
      }
      case "tool_progress": {
        if (nativeRunId === null || observedRunId !== nativeRunId) break;
        const value = event.data.progress;
        if (value !== null) progress.set(value.call_id, value);
        break;
      }
      case "tool": {
        if (nativeRunId === null || observedRunId !== nativeRunId) break;
        tools.set(event.data.progress_call_id, event.data);
        progress.delete(event.data.progress_call_id);
        break;
      }
      default:
        break;
    }
  }
  const state = {
    cursor:
      previous.cursor !== null && previous.cursor.sequence > cursor.sequence
        ? previous.cursor
        : cursor,
    observedRunId,
    history,
    live,
    progress,
    tools,
  };
  yield* validate(state);
  return state;
});

export const validateAll = Effect.fn("AlbedoProjection.validateAll")(function* (
  states: Iterable<Projection>,
) {
  let rows = 0;
  let live = 0;
  let characters = 0;
  for (const state of states) {
    rows += state.history.size + state.tools.size + state.progress.size;
    live += state.live.size;
    for (const entry of state.history.values())
      for (const part of entry.content) if (part.kind === "text") characters += part.text.length;
    for (const value of state.live.values()) characters += value.text.length;
  }
  if (rows > 8192 || live > 256) {
    return yield* new AlbedoProjectionError({
      detail:
        "This Albedo turn exceeds T3's activity limit. Its native session remains available in Albedo.",
    });
  }
  if (characters > 16 * 1024 * 1024)
    return yield* new AlbedoProjectionError({
      detail:
        "This Albedo turn exceeds T3's text limit. Its full output remains in the native session.",
    });
});
const validate = (state: Projection) => validateAll([state]);

export const restore = Effect.fn("AlbedoProjection.restore")(function* (
  nativeRunId: string | null,
  history: ReadonlyArray<Entry>,
  outputs: ReadonlyArray<{
    readonly output: typeof Protocol.ActiveOutput.Type;
    readonly text: string;
  }>,
  progress: ReadonlyArray<Progress>,
  snapshot: Pick<Protocol.Session, "cursor" | "status" | "history">,
) {
  const state: Projection = {
    cursor: snapshot.cursor,
    observedRunId: snapshot.status.run_id,
    history: new Map(
      history
        .filter(
          (entry) =>
            entry.turn_id === nativeRunId &&
            nativeRunId !== null &&
            entry.position <= snapshot.history.high_water,
        )
        .map((entry) => [entry.id, entry]),
    ),
    live: new Map(
      outputs
        .filter((entry) => entry.output.run_id === nativeRunId)
        .map(({ output, text }) => [
          output.message_id,
          { kind: output.kind, runId: output.run_id, text },
        ]),
    ),
    progress: new Map(
      (snapshot.status.run_id === nativeRunId ? progress : []).map((entry) => [
        entry.call_id,
        entry,
      ]),
    ),
    tools: new Map(),
  };
  yield* validate(state);
  return state;
});

const contentText = (entry: Entry) =>
  entry.content.flatMap((part) => (part.kind === "text" ? [part.text] : [])).join("");
const jsonField = (entry: Entry, field: string) =>
  entry.content.find((part) => part.kind === "json" && part.field === field);

export function render(
  state: Projection,
  input: Pick<ProviderAdapterV2TurnInput, "threadId" | "rootNodeId"> & {
    readonly providerThread: Pick<ProviderAdapterV2TurnInput["providerThread"], "id">;
    readonly runId: RunId | null;
  },
  turn: Pick<OrchestrationV2ProviderTurn, "startedAt"> & { readonly id: ProviderTurnId | null },
  nativeRunId: string,
  ids: IdAllocatorV2["Service"]["derive"],
  now: DateTime.Utc,
): ReadonlyArray<OrchestrationV2TurnItem> {
  const rows: OrchestrationV2TurnItem[] = [];
  const entries = [...state.history.values()].sort(
    (a, b) =>
      a.position - b.position || (a.kind === "thinking" ? -1 : b.kind === "thinking" ? 1 : 0),
  );
  const prefix = `${input.providerThread.id}/${nativeRunId}/`;
  const base = (key: string, ordinal: number, completed: boolean) => ({
    id: ids.turnItemFromProviderItem({ driver, nativeItemId: prefix + key }),
    threadId: input.threadId,
    runId: input.runId,
    nodeId: input.rootNodeId,
    providerThreadId: input.providerThread.id,
    providerTurnId: turn.id,
    nativeItemRef: providerRef(prefix + key),
    parentItemId: null,
    ordinal,
    status: completed ? ("completed" as const) : ("running" as const),
    title: null,
    startedAt: turn.startedAt,
    completedAt: completed ? now : null,
    updatedAt: now,
  });
  const counts = { text: 0, thinking: 0 };
  const message = (
    kind: "text" | "thinking",
    text: string,
    position: number,
    streaming: boolean,
    phase?: Entry["phase"],
  ) => {
    const key = `${kind}/${counts[kind]++}`;
    const common = base(key, position * 10 + (kind === "thinking" ? 0 : 1), !streaming);
    rows.push(
      kind === "thinking"
        ? { ...common, type: "reasoning", text, streaming }
        : {
            ...common,
            type: "assistant_message",
            text,
            streaming,
            messageId: ids.messageFromProviderItem({ driver, nativeItemId: prefix + key }),
            ...(phase === "final"
              ? { phase: "final_answer" as const }
              : phase === "commentary"
                ? { phase: "commentary" as const }
                : {}),
          },
    );
  };
  const completedTools = new Map<string, { readonly tool: Tool; readonly position: number }>();
  for (const entry of entries) {
    if (entry.kind === "assistant" || entry.kind === "thinking") {
      message(
        entry.kind === "assistant" ? "text" : "thinking",
        contentText(entry),
        entry.position,
        false,
        entry.phase,
      );
    }
    if (entry.kind === "tool_result" && entry.tool !== null) {
      const args = entries.find(
        (candidate) =>
          candidate.kind === "tool_call" &&
          candidate.tool?.tool_call_id === entry.tool?.tool_call_id,
      );
      const argument =
        jsonField(entry, "arguments") ??
        (args === undefined ? undefined : jsonField(args, "arguments"));
      const result = jsonField(entry, "result");
      const key = entry.tool.progress_call_id ?? entry.tool.tool_call_id;
      completedTools.set(key, {
        position: entry.position,
        tool: {
          ...entry.tool,
          progress_call_id: key,
          arguments: argument?.kind === "json" ? argument.value : null,
          result: result?.kind === "json" ? result.value : contentText(entry),
          trace: null,
          content_complete: entry.content_complete,
          reference: null,
        },
      });
    }
  }
  const nextPosition = (entries.at(-1)?.position ?? 0) + 1;
  // Native blocks become one durable entry per kind and response; grouping keeps IDs stable across a reset that missed its commit.
  for (const kind of ["thinking", "text"] as const) {
    const segments = [...state.live.values()].filter((entry) => entry.kind === kind);
    if (segments.length > 0)
      message(kind, segments.map((entry) => entry.text).join(""), nextPosition, true);
  }
  for (const [key, tool] of state.tools)
    if (!completedTools.has(key)) completedTools.set(key, { tool, position: nextPosition });
  for (const [key, { tool, position }] of completedTools)
    rows.push({
      ...base(`tool/${key}`, position * 10 + 2, true),
      type: "dynamic_tool",
      toolName: tool.name || null,
      title: tool.title ?? tool.name,
      input: tool.arguments,
      output: tool.result,
      status: tool.status === "failed" ? "failed" : "completed",
    });
  for (const [key, progress] of state.progress)
    if (!completedTools.has(key))
      rows.push({
        ...base(`tool/${key}`, nextPosition * 10 + 2, false),
        type: "dynamic_tool",
        toolName: progress.name || null,
        title: progress.title ?? progress.name,
        input: progress.preview?.text ?? "",
      });
  return rows;
}

export function unchanged(
  previous: OrchestrationV2TurnItem | undefined,
  next: OrchestrationV2TurnItem,
) {
  if (
    previous === undefined ||
    previous.type !== next.type ||
    previous.status !== next.status ||
    previous.ordinal !== next.ordinal ||
    previous.title !== next.title
  )
    return false;
  if (previous.type === "assistant_message" && next.type === "assistant_message")
    return (
      previous.text === next.text &&
      previous.streaming === next.streaming &&
      previous.phase === next.phase
    );
  if (previous.type === "reasoning" && next.type === "reasoning")
    return previous.text === next.text && previous.streaming === next.streaming;
  if (previous.type === "dynamic_tool" && next.type === "dynamic_tool")
    return (
      previous.toolName === next.toolName &&
      previous.input === next.input &&
      previous.output === next.output
    );
  return false;
}
