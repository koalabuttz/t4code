import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { crewMessageDraft } from "@t3tools/client-runtime/state/crew";
import type { TeamworkReadResult, TeamworkSnapshot, ThreadId } from "@t3tools/contracts";
import type {
  CrewConsultation,
  CrewConversationRef,
  CrewProjectScope,
  CrewWorkstream,
  CrewWorkstreamTaskLink,
} from "@t3tools/contracts/crewConversation";
import type { Atom } from "effect/reactivity";
import * as DateTime from "effect/DateTime";
import { crewTaskExecution } from "@t3tools/shared/crewExecution";
import { classifyCrewSupervision } from "@t3tools/shared/crewSupervision";
import { sameCrewConversation, sameCrewProject } from "@t3tools/shared/crewConversation";

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
    threadExecution: threads.map((thread) =>
      crewTaskExecution(
        { id: thread.id, ownerThreadId: thread.id, status: "done" },
        execution(thread.id),
      ),
    ),
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

export function mobileCrewReturnedAnswer(
  conversation: CrewConversationRef,
  consultation: CrewConsultation,
  message: { id: string; text: string; senderThreadId?: ThreadId },
): string | null {
  if (
    consultation.progress.state !== "answered" ||
    !sameCrewConversation(conversation, consultation.origin.conversation) ||
    !sameCrewProject(conversation, consultation.destination) ||
    !sameCrewConversation(
      consultation.destination,
      consultation.progress.exchange.response.conversation,
    ) ||
    consultation.progress.exchange.response.actor !== "agent" ||
    message.id !== `${consultation.deliveryId}:return` ||
    message.senderThreadId !== consultation.destination.threadId
  )
    return null;
  // The return envelope has one metadata line followed by the canonical answer excerpt.
  const newline = message.text.indexOf("\n");
  return newline < 0 ? null : message.text.slice(newline + 1);
}

type WorkstreamGroup = "Needs you" | "Working" | "Waiting" | "Resolved";

export function mobileCrewWorkstreamGroups(input: {
  scope: CrewProjectScope;
  workstreams: readonly CrewWorkstream[];
  links: readonly CrewWorkstreamTaskLink[];
  threads: readonly EnvironmentThreadShell[];
  supervision: ReturnType<typeof mobileCrewSupervision> | null;
  freshness: Parameters<typeof mobileCrewSupervision>[2];
  search: string;
}) {
  const search = input.search.trim().toLowerCase();
  const groups = new Map<
    WorkstreamGroup,
    {
      workstream: CrewWorkstream;
      shell: EnvironmentThreadShell | undefined;
      detail: string;
      unread: boolean;
    }[]
  >([
    ["Needs you", []],
    ["Working", []],
    ["Waiting", []],
    ["Resolved", []],
  ]);
  const tasksByWorkstream = new Map<ThreadId, Set<string>>();
  for (const link of input.links) {
    if (!sameCrewProject(input.scope, link.workstream)) continue;
    const ids = tasksByWorkstream.get(link.workstream.threadId) ?? new Set();
    ids.add(link.taskId);
    tasksByWorkstream.set(link.workstream.threadId, ids);
  }
  const shells = new Map(
    input.threads
      .filter((thread) => thread.deletedAt === null && sameCrewProject(input.scope, thread))
      .map((thread) => [thread.id, thread]),
  );
  for (const workstream of input.workstreams) {
    if (workstream.status === "unlinked" || !sameCrewProject(input.scope, workstream.conversation))
      continue;
    const { threadId } = workstream.conversation;
    const shell = shells.get(threadId);
    if (search && !`${workstream.title} ${shell?.title ?? ""}`.toLowerCase().includes(search))
      continue;
    const linked = tasksByWorkstream.get(threadId);
    const facts =
      input.supervision?.items.filter(
        (item) => (item.taskId !== null && linked?.has(item.taskId)) || item.threadId === threadId,
      ) ?? [];
    const needsYou = facts.find(
      (item) =>
        item.attention &&
        item.kind !== "review" &&
        (item.responsibility === "human" || item.responsibility === "unknown"),
    );
    const threadExecution = crewTaskExecution(
      { id: threadId, ownerThreadId: threadId, status: "done" },
      shell
        ? {
            status: shell.runtime?.status ?? shell.source.status,
            hasPendingApprovals: shell.hasPendingApprovals,
            hasPendingUserInput: shell.hasPendingUserInput,
            lastError: shell.runtime?.lastError ?? shell.source.lastError,
          }
        : null,
    );
    const active = facts.find((item) => item.underway && item.kind !== "review");
    const waiting = facts.find((item) => item.kind === "review" || item.kind === "dependencies");
    const group: WorkstreamGroup =
      input.freshness !== "current" ||
      !shell ||
      needsYou ||
      ["approval", "input", "failed", "unknown", "unavailable", "disconnected"].includes(
        threadExecution.state,
      )
        ? "Needs you"
        : active || ["working", "starting"].includes(threadExecution.state)
          ? "Working"
          : workstream.status === "resolved" && !waiting
            ? "Resolved"
            : "Waiting";
    const detail =
      input.freshness !== "current"
        ? "Execution is unconfirmed"
        : !shell
          ? "Conversation unavailable"
          : (needsYou?.label ??
            active?.label ??
            waiting?.label ??
            (group === "Resolved"
              ? "Resolved"
              : group === "Working"
                ? "Work in progress"
                : group === "Needs you"
                  ? "Open the thread to check its current request or execution"
                  : "Waiting for a message or assignment"));
    const lastVisit = shell?.lastVisitedAt;
    groups.get(group)?.push({
      workstream,
      shell,
      detail,
      unread: Boolean(
        lastVisit &&
        shell?.source.latestVisibleMessage &&
        DateTime.toEpochMillis(shell.source.latestVisibleMessage.updatedAt) > Date.parse(lastVisit),
      ),
    });
  }
  return Array.from(groups, ([title, rows]) => ({ title, rows }));
}
