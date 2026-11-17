import {
  WS_METHODS,
  type OutpostHistory,
  type OutpostAttachment,
  type OutpostCatalog,
  type OutpostSession,
} from "@t3tools/contracts";
import * as Base64 from "effect/encoding/Base64";
import * as Result from "effect/Result";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createOutpostEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    fleets: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "outpost:fleets",
      tag: WS_METHODS.outpostSubscribe,
    }),
    save: createEnvironmentRpcCommand(runtime, {
      label: "outpost:save",
      tag: WS_METHODS.outpostSave,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "outpost:remove",
      tag: WS_METHODS.outpostRemove,
    }),
    test: createEnvironmentRpcCommand(runtime, {
      label: "outpost:test",
      tag: WS_METHODS.outpostTest,
    }),
    action: createEnvironmentRpcCommand(runtime, {
      label: "outpost:action",
      tag: WS_METHODS.outpostAction,
    }),
    history: createEnvironmentRpcCommand(runtime, {
      label: "outpost:history",
      tag: WS_METHODS.outpostHistory,
    }),
    attachment: createEnvironmentRpcCommand(runtime, {
      label: "outpost:attachment",
      tag: WS_METHODS.outpostAttachment,
    }),
  };
}

export function groupOutpostSessions(catalog: OutpostCatalog | null) {
  const projects = new Map<
    string,
    { id: string; path: string; running: OutpostSession[]; stopped: OutpostSession[] }
  >();
  for (const project of catalog?.projects ?? [])
    projects.set(project.id, { id: project.id, path: project.path, running: [], stopped: [] });
  for (const session of catalog?.sessions ?? []) {
    let project = projects.get(session.project_id);
    if (!project) {
      project = { id: session.project_id, path: session.project_id, running: [], stopped: [] };
      projects.set(session.project_id, project);
    }
    project[["running", "starting"].includes(session.lifecycle_state) ? "running" : "stopped"].push(
      session,
    );
  }
  return [...projects.values()];
}

export function outpostHistoryText(body: Readonly<Record<string, unknown>>): string {
  const capturedText = (value: unknown) => {
    if (typeof value === "string") return value;
    return value !== null &&
      typeof value === "object" &&
      "text" in value &&
      typeof value.text === "string"
      ? value.text
      : null;
  };
  if (body.type === "user_message") {
    const text = capturedText(body.content);
    if (text !== null) return `User\n${text}`;
  }
  if (body.type === "assistant_message" && Array.isArray(body.blocks)) {
    return `Assistant\n${body.blocks
      .map((block: unknown) => {
        if (
          block !== null &&
          typeof block === "object" &&
          "type" in block &&
          ["text", "thinking"].includes(String(block.type)) &&
          "text" in block
        ) {
          const text = capturedText(block.text);
          if (text !== null) return text;
        }
        return JSON.stringify(block, null, 2);
      })
      .join("\n")}`;
  }
  const text =
    typeof body.text === "string"
      ? body.text
      : typeof body.content === "string"
        ? body.content
        : null;
  return text ?? JSON.stringify(body, null, 2);
}

export function outpostHistoryAttachments(history: OutpostHistory): readonly string[] {
  const ids = new Set<string>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 30 || value === null || typeof value !== "object") return;
    if ("artifact_id" in value && typeof value.artifact_id === "string") ids.add(value.artifact_id);
    for (const entry of Object.values(value)) visit(entry, depth + 1);
  };
  for (const item of history.page.items) visit(item.body, 0);
  return [...ids];
}

export function createOutpostAttachmentReader() {
  let decoder = new TextDecoder();
  let previousKey: string | null = null;
  let nextOffset = 0;
  return (checkpoint: string, chunk: OutpostAttachment) => {
    const bytes = Result.getOrThrow(Base64.decode(chunk.data_base64));
    const key = JSON.stringify([checkpoint, chunk.artifact_id]);
    if (previousKey !== key || nextOffset !== chunk.offset) decoder = new TextDecoder();
    previousKey = key;
    nextOffset = chunk.offset + bytes.byteLength;
    return {
      id: chunk.artifact_id,
      next: nextOffset,
      total: chunk.total_length,
      text: /^(text\/|application\/json)/.test(chunk.media_type)
        ? decoder.decode(bytes, { stream: nextOffset < chunk.total_length })
        : `Binary attachment (${chunk.media_type}), ${bytes.byteLength} bytes in this chunk.`,
    };
  };
}
