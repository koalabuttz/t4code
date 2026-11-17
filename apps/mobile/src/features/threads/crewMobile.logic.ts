import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { crewMessageDraft } from "@t3tools/client-runtime/state/crew";
import type { TeamworkReadResult, TeamworkSnapshot, ThreadId } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import { crewTaskExecution } from "@t3tools/shared/crewExecution";
import { classifyCrewSupervision } from "@t3tools/shared/crewSupervision";

type MessageDraft = Atom.Type<ReturnType<typeof crewMessageDraft>>;

export function mobileCrewDraftAfterSave(
  current: MessageDraft,
  submitted: MessageDraft,
  saved: boolean | undefined,
) {
  return saved && submitted.intent === "note" && current === submitted
    ? { ...current, text: "" }
    : current;
}

export function mobileCrewMessageDeliveries(
  projectId: TeamworkSnapshot["projectId"],
  entry: TeamworkSnapshot["board"][number],
  deliveries: TeamworkReadResult["deliveries"],
) {
  return entry.recipients.map((threadId) => ({
    threadId,
    delivery:
      deliveries.find(
        (delivery) =>
          delivery.kind === "message" &&
          delivery.threadId === threadId &&
          entry.revision !== undefined &&
          delivery.id.startsWith(`${projectId}:${entry.revision}:`),
      ) ?? null,
  }));
}

export function mobileCrewSupervision(
  data: TeamworkReadResult,
  threads: ReadonlyArray<EnvironmentThreadShell>,
  freshness: Parameters<typeof classifyCrewSupervision>[0]["freshness"],
) {
  const shells = new Map(threads.map((thread) => [thread.id, thread]));
  const execution = (threadId: ThreadId | null) => {
    const shell = threadId === null ? undefined : shells.get(threadId);
    return shell?.deletedAt != null
      ? "unavailable"
      : shell
        ? {
            status: shell.runtime?.status ?? shell.source.status,
            hasPendingApprovals: shell.hasPendingApprovals,
            hasPendingUserInput: shell.hasPendingUserInput,
            hasPendingBackgroundTasks: shell.pendingBackgroundTasks.length > 0,
            lastError: shell.runtime?.lastError ?? shell.source.lastError,
          }
        : null;
  };
  const coordinator = data.snapshot.coordinatorThreadId;
  return classifyCrewSupervision({
    snapshot: data.snapshot,
    execution: data.snapshot.tasks.map((task) =>
      crewTaskExecution(task, execution(task.ownerThreadId)),
    ),
    coordinatorExecution: coordinator
      ? crewTaskExecution(
          { id: "coordinator", ownerThreadId: coordinator, status: "running" },
          execution(coordinator),
        )
      : null,
    deliveries: data.deliveries,
    freshness,
    inputRequests: threads.flatMap((thread) => {
      const request = thread.source.pendingRuntimeRequest;
      return request?.kind === "user_input"
        ? [{ threadId: thread.id, requestId: request.id, userOnly: request.userOnly }]
        : [];
    }),
  });
}

export function mobileCrewRecipients(
  snapshot: TeamworkSnapshot,
  initiativeId: string,
  threads: ReadonlyArray<EnvironmentThreadShell>,
) {
  return [
    ...new Set([
      ...(snapshot.coordinatorThreadId ? [snapshot.coordinatorThreadId] : []),
      ...snapshot.tasks.flatMap((task) =>
        task.initiativeId === initiativeId &&
        task.ownerThreadId !== null &&
        !["done", "cancelled"].includes(task.status)
          ? [task.ownerThreadId]
          : [],
      ),
    ]),
  ].filter((id) => threads.some((thread) => thread.id === id && thread.deletedAt === null));
}

export function mobileCrewArtifactWorkspace(
  sourceThreadId: ThreadId | null,
  threads: ReadonlyArray<EnvironmentThreadShell>,
  projectWorkspace: string | null,
) {
  if (sourceThreadId === null) return projectWorkspace;
  const source = threads.find(
    (thread) => thread.id === sourceThreadId && thread.deletedAt === null,
  );
  return source ? (source.worktreePath ?? projectWorkspace) : null;
}
