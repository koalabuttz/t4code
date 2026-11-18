import {
  ProjectId,
  EnvironmentId,
  CommandId,
  MessageId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type TeamworkSnapshot,
  type TeamworkTask,
} from "@t3tools/contracts";
import type { CrewConsultation } from "@t3tools/contracts/crewConversation";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { classifyCrewSupervision } from "@t3tools/shared/crewSupervision";
import { crewMessageRecipients, crewSupervisionFacts } from "./crewPanel.logic";
import {
  crewChatExchanges,
  crewReturnLookupId,
  crewReturnedAnswer,
  crewUndeliveredAnswerSource,
  currentCrewRuntimeRequests,
  establishCrewCoordinator,
  hasCrewProjectFootprint,
  scopeCrewRuntimeRequests,
} from "./crewChat.logic";

const workerId = ThreadId.make("worker");
const coordinatorId = ThreadId.make("coordinator");

it("attributes only the correlated server return at its origin across follow-ups", () => {
  const scope = {
    environmentId: EnvironmentId.make("machine"),
    projectId: ProjectId.make("project"),
  };
  const origin = { ...scope, threadId: coordinatorId };
  const destination = { ...scope, threadId: workerId };
  const originMessage = {
    conversation: origin,
    messageId: MessageId.make("question"),
    runId: null,
    actor: "user",
    sender: null,
  } as const;
  const source = {
    conversation: destination,
    messageId: MessageId.make("answer"),
    runId: RunId.make("worker-run"),
    actor: "agent",
    sender: null,
  } as const;
  const consultation: CrewConsultation = {
    id: "consult-1",
    origin: originMessage,
    destination,
    deliveryId: CommandId.make("delivery-1"),
    context: { replyTo: null, sources: [], attachments: [] },
    replyTo: null,
    progress: {
      state: "answered",
      exchange: {
        request: { ...source, messageId: MessageId.make("request") },
        response: source,
        responseId: source.messageId,
      },
    },
    createdAt: "2026-11-17T00:00:00Z",
    updatedAt: "2026-11-17T00:00:01Z",
  };
  const followUp: CrewConsultation = {
    ...consultation,
    id: "follow-up",
    deliveryId: CommandId.make("delivery-2"),
    origin: { ...originMessage, messageId: MessageId.make("next-question") },
    replyTo: { consultationId: consultation.id, responseId: source.messageId },
    progress: { state: "queued" },
  };
  const exchanges = crewChatExchanges(scope, coordinatorId, [consultation, followUp], []);
  expect([...exchanges.byReturn.keys()]).toEqual(["delivery-1:return"]);
  expect(exchanges.byOrigin.get(followUp.origin.messageId)).toEqual([followUp]);
  expect(crewChatExchanges(scope, workerId, [consultation], []).byReturn.size).toBe(0);
  expect(
    crewChatExchanges(
      { ...scope, environmentId: EnvironmentId.make("other") },
      coordinatorId,
      [consultation],
      [],
    ).byReturn.size,
  ).toBe(0);
  const returned = {
    id: MessageId.make("delivery-1:return"),
    text: `Crew consultation consult-1 answered. From worker. Canonical source: ${JSON.stringify(source)}\nAndroid draws behind the system bar.`,
    creationSource: "server",
    createdBy: "agent",
    senderThreadId: workerId,
  } as const;
  expect(crewReturnedAnswer(returned, exchanges.byReturn.get(returned.id))).toBe(
    "Android draws behind the system bar.",
  );
  expect(crewReturnedAnswer({ ...returned, createdBy: "user" }, consultation)).toBeNull();
  expect(
    crewReturnedAnswer({ ...returned, id: MessageId.make("delivery-2:return") }, consultation),
  ).toBeNull();
  expect(
    crewReturnedAnswer(
      { ...returned, text: returned.text.replace('"worker-run"', '"unrelated-run"') },
      consultation,
    ),
  ).toBeNull();
  expect(crewUndeliveredAnswerSource(consultation, "failed", false)).toEqual(source);
  expect(crewUndeliveredAnswerSource(consultation, "failed", true)).toBeNull();
  expect(crewUndeliveredAnswerSource(consultation, "pending", false)).toEqual(source);
  expect(crewUndeliveredAnswerSource(followUp, "failed", false)).toBeNull();
  const historical = {
    ...returned,
    id: MessageId.make("crew:project:older-return-command:return"),
  };
  expect(crewReturnLookupId(historical, scope)).toBe("consult-1");
  expect(crewReturnLookupId({ ...historical, creationSource: "web" }, scope)).toBeNull();
  expect(
    crewReturnLookupId(historical, { ...scope, projectId: ProjectId.make("another-project") }),
  ).toBeNull();
});

it("never substitutes another pending action for an exact Crew request", () => {
  const approvals = [{ requestId: "approval-a" }, { requestId: "approval-b" }];
  const questions = [{ requestId: "question-a" }];
  const projection = {
    runtimeRequests: [
      { id: "approval-a", kind: "command_execution", status: "pending" },
      { id: "approval-b", kind: "command_execution", status: "pending" },
      { id: "question-a", kind: "user_input", status: "pending" },
    ],
    turnItems: [
      { type: "approval_request", requestId: "approval-a", runId: "run-a" },
      { type: "approval_request", requestId: "approval-b", runId: "run-b" },
      { type: "user_input_request", requestId: "question-a", runId: "run-a" },
    ],
  };
  const request = { projection, approvals, questions, requestId: "approval-a", runId: "run-a" };
  expect(scopeCrewRuntimeRequests(request)).toEqual({
    approvals: [approvals[0]],
    questions: [],
    status: "pending",
  });
  expect(scopeCrewRuntimeRequests({ ...request, projection: null })).toEqual({
    approvals: [],
    questions: [],
    status: "loading",
  });
  expect(scopeCrewRuntimeRequests({ ...request, runId: "run-b" })).toEqual({
    approvals: [],
    questions: [],
    status: "unavailable",
  });
  const resolved = {
    ...projection,
    runtimeRequests: projection.runtimeRequests.map((entry) =>
      entry.id === "approval-a" ? { ...entry, status: "resolved" } : entry,
    ),
  };
  expect(currentCrewRuntimeRequests(resolved).map((entry) => entry.requestId)).toEqual([
    "approval-b",
    "question-a",
  ]);
  expect(
    scopeCrewRuntimeRequests({ ...request, projection: resolved, approvals: [approvals[1]!] }),
  ).toEqual({ approvals: [], questions: [], status: "unavailable" });
  expect(scopeCrewRuntimeRequests({ ...request, requestId: undefined })).toEqual({
    approvals,
    questions,
    status: "unscoped",
  });
});

it("opens Crew automatically only for a coordinator or initiative footprint", () => {
  const { snapshot } = fixture();
  expect(hasCrewProjectFootprint({ ...snapshot, coordinatorThreadId: null })).toBe(true);
  expect(hasCrewProjectFootprint({ ...snapshot, initiatives: [] })).toBe(true);
  const footprintRemoved = { ...snapshot, coordinatorThreadId: null, initiatives: [] };
  expect(footprintRemoved.revision).toBeGreaterThan(0);
  expect(hasCrewProjectFootprint(footprintRemoved)).toBe(false);
});

it("adopts a concurrently created shell using the fresh Crew revision", async () => {
  const { snapshot } = fixture();
  const scope = { environmentId: EnvironmentId.make("machine"), projectId: snapshot.projectId };
  const candidate = { ...scope, threadId: coordinatorId, eligible: true };
  const readCrew = vi
    .fn()
    .mockResolvedValueOnce({ ...snapshot, coordinatorThreadId: null })
    .mockResolvedValue({ ...snapshot, revision: 5, coordinatorThreadId: null });
  const readThread = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(candidate);
  const create = vi.fn().mockRejectedValue(new Error("Another client created the shell."));
  const setCoordinator = vi.fn().mockResolvedValue(undefined);
  await expect(
    establishCrewCoordinator({
      scope,
      threadId: coordinatorId,
      readCrew,
      readThread,
      create,
      setCoordinator,
    }),
  ).resolves.toBe(coordinatorId);
  expect(setCoordinator).toHaveBeenCalledExactlyOnceWith(5);
});

it("keeps the coordinator chosen by another client when adoption loses a revision race", async () => {
  const { snapshot } = fixture();
  const scope = { environmentId: EnvironmentId.make("machine"), projectId: snapshot.projectId };
  const candidate = { ...scope, threadId: coordinatorId, eligible: true };
  const winner = ThreadId.make("other-coordinator");
  const empty = { ...snapshot, coordinatorThreadId: null };
  const readCrew = vi
    .fn()
    .mockResolvedValueOnce(empty)
    .mockResolvedValueOnce({ ...empty, revision: 2 })
    .mockResolvedValueOnce({ ...snapshot, coordinatorThreadId: winner, revision: 3 });
  const setCoordinator = vi.fn().mockRejectedValue(new Error("Revision conflict."));
  await expect(
    establishCrewCoordinator({
      scope,
      threadId: coordinatorId,
      readCrew,
      readThread: () => Promise.resolve(candidate),
      setCoordinator,
    }),
  ).resolves.toBe(winner);
  expect(setCoordinator).toHaveBeenCalledExactlyOnceWith(2);
});

it("rejects a pre-existing shell outside the exact project before adopting it", async () => {
  const { snapshot } = fixture();
  const scope = { environmentId: EnvironmentId.make("machine"), projectId: snapshot.projectId };
  const candidate = {
    ...scope,
    projectId: ProjectId.make("other-project"),
    threadId: coordinatorId,
    eligible: true,
  };
  const setCoordinator = vi.fn();
  await expect(
    establishCrewCoordinator({
      scope,
      threadId: coordinatorId,
      readCrew: () => Promise.resolve({ ...snapshot, coordinatorThreadId: null }),
      readThread: () => Promise.resolve(candidate),
      setCoordinator,
    }),
  ).rejects.toThrow("cannot coordinate the selected project");
  expect(setCoordinator).not.toHaveBeenCalled();
});

function fixture() {
  const task: TeamworkTask = {
    id: "task",
    initiativeId: "goal",
    title: "Deliver",
    brief: "Deliver the result",
    criteria: "Verified",
    roleId: null,
    milestoneId: null,
    dependencies: [],
    knowledgeIds: [],
    status: "running",
    ownerThreadId: workerId,
    delegatedTaskId: null,
    delegationId: "attempt",
    evidence: "",
    review: null,
    createdAt: "2026-11-17T00:00:00Z",
    updatedAt: "2026-11-17T00:00:00Z",
  };
  const snapshot: TeamworkSnapshot = {
    projectId: ProjectId.make("project"),
    revision: 1,
    coordinatorThreadId: coordinatorId,
    tasks: [task],
    roles: [],
    board: [],
    knowledge: [],
    initiatives: [
      {
        id: "goal",
        title: "Goal",
        brief: "Deliver",
        status: "active",
        approved: true,
        mode: "swarm",
        milestones: [],
        createdAt: "2026-11-17T00:00:00Z",
        updatedAt: "2026-11-17T00:00:00Z",
      },
    ],
  };
  return { snapshot, task };
}

it("uses only the current shell question and never infers its responder from the coordinator", () => {
  const { snapshot } = fixture();
  for (const userOnly of [undefined, false, true]) {
    const facts = crewSupervisionFacts(snapshot, [
      {
        id: workerId,
        deletedAt: null,
        status: "running",
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("current-question"),
          kind: "user_input",
          userOnly,
          createdAt: DateTime.makeUnsafe("2026-11-17T00:00:00Z"),
        },
      },
    ]);
    expect(facts.inputRequests).toEqual([
      { threadId: workerId, requestId: "current-question", userOnly },
    ]);
    const result = classifyCrewSupervision({
      snapshot,
      ...facts,
      deliveries: [],
      freshness: "current",
    });
    expect(result.items.find((item) => item.kind === "input")).toMatchObject({
      responsibility: userOnly ? "human" : "unknown",
      action: { threadId: workerId, requestId: "current-question", focus: "input" },
    });
  }
  const facts = crewSupervisionFacts(snapshot, [
    { id: workerId, deletedAt: null, status: "running", pendingRuntimeRequest: null },
  ]);
  expect(facts.inputRequests).toEqual([]);
  expect(facts.execution[0]?.state).toBe("working");
});

it("keeps coordinator failure, startup and intentionally stopped workers distinct", () => {
  const { snapshot } = fixture();
  const facts = crewSupervisionFacts(snapshot, [
    {
      id: coordinatorId,
      deletedAt: null,
      status: "failed",
      pendingRuntimeRequest: null,
      lastError: "Coordinator crashed",
    },
    { id: workerId, deletedAt: null, status: "starting", pendingRuntimeRequest: null },
  ]);
  const result = classifyCrewSupervision({
    snapshot,
    ...facts,
    deliveries: [],
    freshness: "current",
  });
  expect(result.attention).toContainEqual(
    expect.objectContaining({
      kind: "coordinator-failed",
      detail: "Coordinator crashed",
      initiativeId: null,
    }),
  );
  expect(result.initiatives[0]?.progress).toMatchObject({ running: 0, starting: 1 });
  expect(result.items.find((item) => item.kind === "worker-active")?.underway).toBe(false);
  const paused = {
    ...snapshot,
    initiatives: snapshot.initiatives.map((initiative) => ({
      ...initiative,
      status: "paused" as const,
    })),
  };
  const stopped = crewSupervisionFacts(paused, [
    { id: workerId, deletedAt: null, status: "interrupted", pendingRuntimeRequest: null },
  ]);
  expect(
    classifyCrewSupervision({
      snapshot: paused,
      ...stopped,
      deliveries: [],
      freshness: "current",
    }).attention.some((item) => item.taskId === "task"),
  ).toBe(false);
});

it("leaves missing and deleted execution uncertain and does not assign a submitted review", () => {
  const { snapshot, task } = fixture();
  const reviewing = { ...snapshot, tasks: [{ ...task, status: "review" as const }] };
  const facts = crewSupervisionFacts(reviewing, [
    {
      id: workerId,
      deletedAt: DateTime.makeUnsafe("2026-11-17T00:00:00Z"),
      status: "completed",
      pendingRuntimeRequest: null,
    },
  ]);
  expect(facts.execution[0]?.state).toBe("unavailable");
  expect(facts.coordinatorExecution?.state).toBe("unknown");
  const result = classifyCrewSupervision({
    snapshot: reviewing,
    ...facts,
    deliveries: [],
    freshness: "disconnected",
  });
  expect(result.items.find((item) => item.kind === "review")).toMatchObject({
    actor: { kind: "unknown" },
    underway: false,
  });
  expect(result.clear).toBe(false);
  expect(result.initiatives[0]?.progress.running).toBeNull();
});

it("offers only current scoped participants and rejects a draft with any unavailable recipient", () => {
  const { snapshot, task } = fixture();
  const environmentId = EnvironmentId.make("environment");
  const project = { environmentId, projectId: snapshot.projectId };
  const coordinator = { ...project, id: coordinatorId, deletedAt: null };
  const worker = { ...project, id: workerId, deletedAt: null };
  const completed = { ...snapshot, tasks: [{ ...task, status: "done" as const }] };
  const read = (
    threads: Parameters<typeof crewMessageRecipients>[0]["threads"],
    selected = [coordinatorId, workerId],
  ) =>
    crewMessageRecipients({
      snapshot: completed,
      initiativeId: "goal",
      project,
      threads,
      selected,
    });
  expect(read([coordinator, worker])).toMatchObject({
    recipients: [coordinatorId, workerId],
    invalidRecipients: [],
    canAsk: true,
  });
  expect(read([coordinator, worker]).members.map((member) => member.id)).toEqual([
    coordinatorId,
    workerId,
  ]);
  for (const threads of [
    [worker],
    [{ ...coordinator, deletedAt: "2026-11-17T00:00:00Z" }, worker],
    [{ ...coordinator, environmentId: EnvironmentId.make("other-environment") }, worker],
    [{ ...coordinator, projectId: ProjectId.make("other-project") }, worker],
  ]) {
    const result = read(threads);
    expect(result.members.map((member) => member.id)).toEqual([workerId]);
    expect(result).toMatchObject({
      recipients: [workerId],
      invalidRecipients: [coordinatorId],
      canAsk: false,
    });
  }
  for (const threads of [
    [coordinator],
    [coordinator, { ...worker, deletedAt: "2026-11-17T00:00:00Z" }],
    [coordinator, { ...worker, environmentId: EnvironmentId.make("other-environment") }],
    [coordinator, { ...worker, projectId: ProjectId.make("other-project") }],
  ]) {
    const result = read(threads);
    expect(result.members.map((member) => member.id)).toEqual([coordinatorId]);
    expect(result).toMatchObject({
      recipients: [coordinatorId],
      invalidRecipients: [workerId],
      canAsk: false,
    });
  }
  const unassigned = ThreadId.make("not-a-participant");
  expect(
    read([coordinator, worker, { ...project, id: unassigned, deletedAt: null }], [unassigned]),
  ).toMatchObject({ recipients: [], invalidRecipients: [unassigned], canAsk: false });
  expect(read([coordinator, worker], [])).toMatchObject({
    recipients: [],
    invalidRecipients: [],
    canAsk: false,
  });
});
