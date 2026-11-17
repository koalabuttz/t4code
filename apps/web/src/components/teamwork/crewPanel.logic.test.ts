import {
  ProjectId,
  RuntimeRequestId,
  ThreadId,
  type TeamworkSnapshot,
  type TeamworkTask,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";
import { classifyCrewSupervision } from "@t3tools/shared/crewSupervision";
import { crewSupervisionFacts } from "./crewPanel.logic";

const workerId = ThreadId.make("worker");
const coordinatorId = ThreadId.make("coordinator");
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
