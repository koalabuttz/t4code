import {
  isProviderNativeSubagentThread,
  type ScopedProjectRef,
  type ThreadId,
} from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/reactivity";
import { scopedProjectKey } from "../environment/scoped.ts";
import type { EnvironmentThreadShell } from "./models.ts";

export function crewLiveFreshness(
  connected: boolean,
  query: { data: unknown | null; error: string | null; isSuccess: boolean },
) {
  if (!connected) return "disconnected" as const;
  if (query.error) return "stale" as const;
  // Stream waiting means waiting for its next value, even after a successful emission.
  return query.data !== null && query.isSuccess ? ("current" as const) : ("unknown" as const);
}

export const crewDraftBrief = Atom.family((_projectKey: string) =>
  Atom.make("").pipe(Atom.keepAlive),
);
const crewDraftTitleOverride = Atom.family((_projectKey: string) =>
  Atom.make<string | null>(null).pipe(Atom.keepAlive),
);
function suggestCrewTitle(brief: string): string {
  const firstLine = brief.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  return firstLine.length > 80 ? `${firstLine.slice(0, 77).trimEnd()}…` : firstLine;
}
export const crewDraftTitle = Atom.family((projectKey: string) =>
  Atom.writable(
    (get) =>
      get(crewDraftTitleOverride(projectKey)) ?? suggestCrewTitle(get(crewDraftBrief(projectKey))),
    (context, value: string | null) => context.set(crewDraftTitleOverride(projectKey), value),
  ).pipe(Atom.keepAlive),
);
export const crewDraftMode = Atom.family((_projectKey: string) =>
  Atom.make<"swarm" | "teamwork">("swarm").pipe(Atom.keepAlive),
);
export const crewOriginThread = Atom.family((_projectKey: string) =>
  Atom.make<ThreadId | null>(null).pipe(Atom.keepAlive),
);
export const crewCandidateThread = Atom.family((_projectKey: string) =>
  Atom.make<ThreadId | null>(null).pipe(Atom.keepAlive),
);

export function prepareCrewEntry(
  registry: AtomRegistry.AtomRegistry,
  project: ScopedProjectRef,
  entry: { threadId?: ThreadId | null; brief?: string },
): void {
  const key = scopedProjectKey(project);
  if (entry.threadId != null) {
    registry.set(crewOriginThread(key), entry.threadId);
    registry.set(crewCandidateThread(key), null);
  }
  if (entry.brief?.trim()) registry.set(crewDraftBrief(key), entry.brief);
}

type CrewConversation = Pick<
  EnvironmentThreadShell,
  "id" | "projectId" | "deletedAt" | "source" | "environmentId"
>;

export function isCrewCoordinatorCandidate(project: ScopedProjectRef, thread: CrewConversation) {
  return (
    thread.environmentId === project.environmentId &&
    thread.projectId === project.projectId &&
    thread.deletedAt === null &&
    !isProviderNativeSubagentThread(thread.source)
  );
}

export function resolveCrewCoordinator(input: {
  project: ScopedProjectRef;
  threads: ReadonlyArray<CrewConversation>;
  coordinatorThreadId: ThreadId | null;
  originThreadId?: ThreadId | null;
  candidateThreadId?: ThreadId | null;
}): {
  threadId: ThreadId | null;
  source: "coordinator" | "candidate" | "origin" | "none";
  reason: string | null;
} {
  const eligible = (id: ThreadId) =>
    input.threads.some(
      (thread) => thread.id === id && isCrewCoordinatorCandidate(input.project, thread),
    );
  if (input.coordinatorThreadId !== null)
    return {
      threadId: input.coordinatorThreadId,
      source: "coordinator",
      reason: eligible(input.coordinatorThreadId)
        ? null
        : "The existing coordinator conversation is unavailable. Use explicit handover to replace it.",
    };
  const candidate = input.candidateThreadId ?? input.originThreadId;
  if (candidate != null && eligible(candidate))
    return {
      threadId: candidate,
      source: input.candidateThreadId != null ? "candidate" : "origin",
      reason: null,
    };
  return {
    threadId: null,
    source: "none",
    reason:
      candidate != null
        ? "This conversation is unavailable or cannot coordinate this project. Choose an available project conversation."
        : "Choose a project conversation to coordinate this initiative.",
  };
}
export function readCrewCommand(text: string): { brief: string } | null {
  const match = /^\/(?:crew|swarm)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match ? { brief: match[1]?.trim() ?? "" } : null;
}

export type CrewView =
  | "overview"
  | "tasks"
  | "conversations"
  | "board"
  | "knowledge"
  | "context"
  | "roles"
  | "history";
export const crewSelectedInitiative = Atom.family((_projectKey: string) =>
  Atom.make<string | null>(null).pipe(Atom.keepAlive),
);
export const crewSelectedView = Atom.family((_projectKey: string) =>
  Atom.make<CrewView>("tasks").pipe(Atom.keepAlive),
);
export const crewSelectedTask = Atom.family((_projectKey: string) =>
  Atom.make<string | null>(null).pipe(Atom.keepAlive),
);
export const crewFilters = Atom.family((_projectKey: string) =>
  Atom.make<{ query: string; status: string | null; ownerThreadId: ThreadId | null }>({
    query: "",
    status: null,
    ownerThreadId: null,
  }).pipe(Atom.keepAlive),
);
export const crewScrollOffset = Atom.family((_projectKey: string) =>
  Atom.make(0).pipe(Atom.keepAlive),
);
export const crewMessageDraft = Atom.family((_projectKey: string) =>
  Atom.make<{ text: string; recipients: ReadonlyArray<ThreadId>; intent: "ask" | "note" }>({
    text: "",
    recipients: [],
    intent: "ask",
  }).pipe(Atom.keepAlive),
);
export const crewReturnContext = Atom.family((_projectKey: string) =>
  Atom.make<{
    threadId: ThreadId;
    taskId: string | null;
    kind: "conversation" | "question" | "approval";
    requestId: string | null;
  } | null>(null).pipe(Atom.keepAlive),
);
