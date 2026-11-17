import {
  ProjectId,
  ThreadId,
  type TeamworkInitiative,
  type TeamworkSnapshot,
  type TeamworkTask,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { classifyCrewSupervision, type CrewSupervisionInput } from "./crewSupervision.ts";

const coordinator = ThreadId.make("coordinator");
const worker = ThreadId.make("worker");
const initiative = (overrides: Partial<TeamworkInitiative> = {}): TeamworkInitiative => ({
  id: "one",
  title: "First goal",
  brief: "Deliver the first goal",
  mode: "swarm",
  status: "active",
  approved: true,
  milestones: [{ id: "milestone", title: "Delivery", criteria: "Verified", accepted: false }],
  createdAt: "2026-11-17T00:00:00Z",
  updatedAt: "2026-11-17T00:00:00Z",
  ...overrides,
});
const task = (overrides: Partial<TeamworkTask> = {}): TeamworkTask => ({
  id: "task",
  initiativeId: "one",
  title: "Build",
  brief: "Build it",
  criteria: "Verified",
  roleId: null,
  milestoneId: "milestone",
  dependencies: [],
  knowledgeIds: [],
  status: "running",
  ownerThreadId: worker,
  delegatedTaskId: null,
  delegationId: "attempt",
  evidence: "",
  review: null,
  createdAt: "2026-11-17T00:00:00Z",
  updatedAt: "2026-11-17T00:00:00Z",
  ...overrides,
});
const snapshot = (overrides: Partial<TeamworkSnapshot> = {}): TeamworkSnapshot => ({
  projectId: ProjectId.make("project"),
  revision: 1,
  coordinatorThreadId: coordinator,
  initiatives: [initiative()],
  tasks: [task()],
  board: [],
  knowledge: [],
  roles: [],
  ...overrides,
});
const input = (overrides: Partial<CrewSupervisionInput> = {}): CrewSupervisionInput => ({
  snapshot: snapshot(),
  freshness: "current",
  deliveries: [],
  execution: [
    { taskId: "task", threadId: worker, state: "working", detail: null, needsAttention: false },
  ],
  coordinatorExecution: { threadId: coordinator, state: "finished", detail: null },
  ...overrides,
});

describe("Crew supervision", () => {
  it("distinguishes human responses, crew execution and unknown review ownership", () => {
    const responder = { kind: "agent", threadId: coordinator } as const;
    for (const { state, request, actor, responsibility } of [
      { state: "approval", request: undefined, actor: { kind: "human" }, responsibility: "human" },
      { state: "input", request: undefined, actor: { kind: "unknown" }, responsibility: "unknown" },
      {
        state: "input",
        request: { userOnly: false },
        actor: { kind: "unknown" },
        responsibility: "unknown",
      },
      {
        state: "input",
        request: { userOnly: true },
        actor: { kind: "human" },
        responsibility: "human",
      },
      {
        state: "input",
        request: { responseActor: responder },
        actor: responder,
        responsibility: "crew",
      },
      {
        state: "input",
        request: { responseActor: { kind: "human" } },
        actor: { kind: "human" },
        responsibility: "human",
      },
      {
        state: "input",
        request: { userOnly: true, responseActor: responder },
        actor: { kind: "human" },
        responsibility: "human",
      },
      {
        state: "approval",
        request: { responseActor: responder },
        actor: { kind: "human" },
        responsibility: "human",
      },
    ] as const) {
      const result = classifyCrewSupervision(
        input({
          execution: [
            { taskId: "task", threadId: worker, state, detail: null, needsAttention: true },
          ],
          ...(request
            ? { inputRequests: [{ threadId: worker, requestId: "question", ...request }] }
            : {}),
        }),
      );
      expect(result.attention[0]).toMatchObject({
        kind: state,
        responsibility,
        actor,
        underway: false,
        action: { kind: "open-thread", threadId: worker, focus: state },
      });
      if (request && state === "input")
        expect(result.attention[0]).toMatchObject({
          requestId: "question",
          action: { requestId: "question" },
        });
    }
    const active = classifyCrewSupervision(input());
    expect(active.initiatives[0]?.next).toMatchObject({
      kind: "worker-active",
      responsibility: "crew",
      underway: true,
      actor: { kind: "agent", threadId: worker },
    });
    expect(active.initiatives[0]?.progress).toMatchObject({
      accepted: 0,
      submitted: 0,
      running: 1,
      milestonesAccepted: 0,
    });
    const starting = classifyCrewSupervision(
      input({
        execution: [
          {
            taskId: "task",
            threadId: worker,
            state: "starting",
            detail: null,
            needsAttention: false,
          },
        ],
        coordinatorExecution: { threadId: coordinator, state: "starting", detail: null },
      }),
    );
    expect.soft(starting.items.find((item) => item.threadId === worker)).toMatchObject({
      label: "Worker starting",
      underway: false,
      actor: { kind: "agent", threadId: worker },
    });
    expect.soft(starting.items.find((item) => item.threadId === coordinator)).toMatchObject({
      label: "Coordinator starting",
      underway: false,
    });
    expect.soft(starting.initiatives[0]?.progress).toMatchObject({ running: 0, starting: 1 });
    expect(starting.initiatives[0]?.resume.prerequisites).toContainEqual({
      kind: "wait-worker",
      threadId: worker,
    });
    expect(starting.handover.prerequisites).toEqual(
      expect.arrayContaining([
        { kind: "wait-worker", threadId: worker },
        { kind: "stop-coordinator", threadId: coordinator },
      ]),
    );
    for (const state of ["working", "waiting"] as const) {
      const ongoing = classifyCrewSupervision(
        input({
          execution: [
            { taskId: "task", threadId: worker, state, detail: null, needsAttention: false },
          ],
          coordinatorExecution: { threadId: coordinator, state, detail: null },
        }),
      );
      expect(ongoing.items.find((item) => item.threadId === worker)).toMatchObject({
        label: state === "waiting" ? "Waiting for ongoing work" : "Worker running",
        underway: true,
      });
      expect(ongoing.items.find((item) => item.threadId === coordinator)).toMatchObject({
        label: state === "waiting" ? "Waiting for ongoing work" : "Coordinator running",
        underway: true,
      });
    }
    const reviewTask = task({
      status: "review",
      submission: {
        revision: 3,
        attemptId: "attempt",
        threadId: worker,
        artifact: { kind: "commit", ref: "a".repeat(40) },
        evidence: "Tests passed",
        createdAt: "2026-11-17T00:00:00Z",
      },
    });
    const reviewing = input({
      snapshot: snapshot({ tasks: [reviewTask] }),
      deliveries: [{ id: "notice", kind: "message", status: "delivered", threadId: coordinator }],
    });
    expect(
      classifyCrewSupervision(reviewing).attention.find((item) => item.kind === "review"),
    ).toMatchObject({
      responsibility: "unknown",
      actor: { kind: "unknown" },
      underway: false,
      submissionRevision: 3,
    });
    const assignment = {
      taskId: "task",
      submissionRevision: 3,
      threadId: coordinator,
      execution: { threadId: coordinator, state: "working" as const, detail: null },
    };
    expect(
      classifyCrewSupervision({ ...reviewing, reviewAssignments: [assignment] }).attention.find(
        (item) => item.kind === "review",
      ),
    ).toMatchObject({
      responsibility: "crew",
      underway: true,
      actor: { kind: "agent", threadId: coordinator },
    });
    expect
      .soft(
        classifyCrewSupervision({
          ...reviewing,
          reviewAssignments: [
            { ...assignment, execution: { ...assignment.execution, state: "starting" } },
          ],
        }).attention.find((item) => item.kind === "review"),
      )
      .toMatchObject({
        responsibility: "crew",
        underway: false,
        actor: { kind: "agent", threadId: coordinator },
      });
    expect(
      classifyCrewSupervision({
        ...reviewing,
        reviewAssignments: [{ ...assignment, submissionRevision: 2 }],
      }).attention.find((item) => item.kind === "review"),
    ).toMatchObject({ responsibility: "unknown", underway: false });
    expect(
      classifyCrewSupervision({
        ...reviewing,
        reviewAssignments: [{ ...assignment, execution: undefined }],
      }).attention.find((item) => item.kind === "review"),
    ).toMatchObject({ responsibility: "crew", underway: false });
  });

  it("keeps dependencies, worker completion, submission and acceptance separate", () => {
    const result = classifyCrewSupervision(
      input({
        snapshot: snapshot({
          tasks: [
            task(),
            task({
              id: "dependent",
              status: "ready",
              ownerThreadId: null,
              dependencies: ["task", "missing"],
            }),
          ],
        }),
        execution: [
          {
            taskId: "task",
            threadId: worker,
            state: "finished",
            detail: null,
            needsAttention: true,
          },
        ],
      }),
    );
    expect(result.attention.find((item) => item.kind === "worker-finished")).toMatchObject({
      responsibility: "crew",
      underway: false,
      taskId: "task",
    });
    expect(result.items.find((item) => item.kind === "dependencies")).toMatchObject({
      responsibility: "waiting",
      dependencyIds: ["task", "missing"],
      actor: { kind: "unknown" },
    });
    expect(result.initiatives[0]?.progress).toMatchObject({
      accepted: 0,
      submitted: 0,
      finished: 1,
    });
    expect(result.initiatives[0]?.status).toBe("active");
  });

  it("treats paused interruptions as normal while exposing running, pending and failed stops", () => {
    const paused = input({
      snapshot: snapshot({ initiatives: [initiative({ status: "paused" })] }),
      execution: [
        { taskId: "task", threadId: worker, state: "stopped", detail: null, needsAttention: true },
      ],
    });
    expect(classifyCrewSupervision(paused).attention).toEqual([]);
    expect(classifyCrewSupervision(paused).initiatives[0]?.pause.state).toBe("stopped");
    expect(classifyCrewSupervision(paused).initiatives[0]?.resume).toMatchObject({
      requiresExplicitAction: true,
      prerequisites: [],
    });
    const running = { ...paused, execution: input().execution };
    expect(classifyCrewSupervision(running).initiatives[0]?.pause.state).toBe("stopping");
    expect(classifyCrewSupervision(running).attention[0]).toMatchObject({
      kind: "stopping",
      label: "Stopping workers…",
      underway: true,
    });
    const starting = classifyCrewSupervision({
      ...running,
      execution: running.execution.map((execution) => ({
        ...execution,
        state: "starting" as const,
      })),
    });
    expect(starting.initiatives[0]?.pause.state).toBe("stopping");
    expect(starting.attention[0]).toMatchObject({
      kind: "stopping",
      label: "Stopping workers…",
      underway: false,
      lastKnownState: "starting",
    });
    for (const status of ["pending", "failed"] as const) {
      const result = classifyCrewSupervision({
        ...paused,
        deliveries: [{ id: "stop", threadId: worker, kind: "stop", status }],
      });
      expect(result.attention.find((item) => item.deliveryId === "stop")).toMatchObject({
        kind: status === "failed" ? "stop-failed" : "stop-pending",
      });
      expect(result.initiatives[0]?.pause.state).toBe(status === "failed" ? "failed" : "stopping");
      expect(result.initiatives[0]?.resume.prerequisites).toContainEqual({
        kind: status === "failed" ? "retry-stop" : "wait-stop",
        threadId: worker,
        deliveryId: "stop",
      });
    }
    const deliveredButRunning = classifyCrewSupervision({
      ...running,
      deliveries: [{ id: "stop", threadId: worker, kind: "stop", status: "delivered" }],
    });
    expect(deliveredButRunning.initiatives[0]?.pause.state).toBe("stopping");
    expect(deliveredButRunning.initiatives[0]?.resume.prerequisites).toContainEqual({
      kind: "wait-worker",
      threadId: worker,
    });
    const failedMessage = classifyCrewSupervision({
      ...paused,
      deliveries: [{ id: "send", threadId: worker, kind: "message", status: "failed" }],
    });
    expect(failedMessage.attention[0]).toMatchObject({
      kind: "message-failed",
      action: { kind: "resume", initiativeId: "one" },
    });
  });

  it("surfaces coordinator failures, failed messages and project-wide handover prerequisites", () => {
    const result = classifyCrewSupervision(
      input({
        coordinatorExecution: {
          threadId: coordinator,
          state: "failed",
          detail: "Provider disconnected",
        },
        deliveries: [{ id: "send", threadId: coordinator, kind: "message", status: "failed" }],
      }),
    );
    expect(result.attention).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "coordinator-failed",
          initiativeId: null,
          detail: "Provider disconnected",
        }),
        expect.objectContaining({
          kind: "message-failed",
          threadId: coordinator,
          initiativeId: null,
          action: { kind: "retry-delivery", deliveryId: "send" },
        }),
      ]),
    );
    expect(result.handover.prerequisites).toEqual(
      expect.arrayContaining([
        { kind: "pause-initiative", initiativeId: "one" },
        { kind: "wait-worker", threadId: worker },
      ]),
    );
    expect(
      classifyCrewSupervision(input({ snapshot: snapshot({ coordinatorThreadId: null }) }))
        .initiatives[0]?.resume.prerequisites,
    ).toContainEqual({ kind: "select-coordinator" });
    expect(
      classifyCrewSupervision(
        input({ snapshot: snapshot({ initiatives: [initiative({ approved: false })] }) }),
      ).initiatives[0]?.resume.prerequisites,
    ).toContainEqual({ kind: "approve-plan", initiativeId: "one" });
    const orphan = ThreadId.make("previous-worker");
    expect(
      classifyCrewSupervision(
        input({
          deliveries: [{ id: "old-stop", threadId: orphan, kind: "stop", status: "failed" }],
        }),
      ).handover.prerequisites,
    ).toContainEqual({ kind: "retry-stop", threadId: orphan, deliveryId: "old-stop" });
  });

  it("never confirms stopped or all clear from stale, disconnected or missing facts", () => {
    for (const freshness of ["stale", "disconnected", "unknown"] as const) {
      const result = classifyCrewSupervision(
        input({
          freshness,
          snapshot: snapshot({ initiatives: [initiative({ status: "paused" })] }),
          execution: [
            {
              taskId: "task",
              threadId: worker,
              state: "stopped",
              detail: null,
              needsAttention: true,
            },
          ],
          deliveries: [{ id: "stop", threadId: worker, kind: "stop", status: "failed" }],
        }),
      );
      expect(result.initiatives[0]?.pause.state).toBe("failed");
      expect(result.attention.some((item) => item.kind === "stop-failed")).toBe(true);
      expect(result.clear).toBe(false);
      expect(result.handover.prerequisites).toContainEqual({ kind: "refresh-connection" });
      expect(
        result.items.find((item) => item.kind === "execution-unknown" && item.taskId === "task"),
      ).toMatchObject({
        freshness: "last-known",
        lastKnownState: "stopped",
        underway: false,
      });
      expect(
        classifyCrewSupervision(
          input({
            freshness,
            snapshot: snapshot({ initiatives: [initiative({ status: "paused" })] }),
          }),
        ).initiatives[0]?.pause.state,
      ).toBe("unknown");
    }
    const missing = classifyCrewSupervision(
      input({
        execution: [],
        coordinatorExecution: null,
        snapshot: snapshot({ initiatives: [initiative({ status: "paused" })] }),
      }),
    );
    expect(missing.clear).toBe(false);
    expect(missing.initiatives[0]?.pause.state).toBe("unknown");
    expect(missing.initiatives[0]?.progress.executionUnknown).toBe(1);
    expect(missing.items.find((item) => item.taskId === "task")).toMatchObject({
      kind: "execution-unknown",
      freshness: "unavailable",
    });
    expect(
      classifyCrewSupervision(
        input({
          execution: [{ ...input().execution[0]!, threadId: ThreadId.make("previous-worker") }],
        }),
      ).items.some((item) => item.kind === "worker-active"),
    ).toBe(false);
    const assigning = classifyCrewSupervision(
      input({
        snapshot: snapshot({
          initiatives: [initiative({ status: "paused" })],
          tasks: [task({ ownerThreadId: null, status: "delegating" })],
        }),
        execution: [],
      }),
    );
    expect(assigning.initiatives[0]?.pause.state).toBe("unknown");
    expect(assigning.clear).toBe(false);
    expect(assigning.initiatives[0]?.progress.running).toBe(0);
    expect(assigning.initiatives[0]?.resume.prerequisites).toContainEqual({
      kind: "verify-assignment",
      taskId: "task",
    });
  });

  it("recomputes stable deduplicated project attention across initiatives and reconnects", () => {
    const other = task({
      id: "other",
      initiativeId: "two",
      ownerThreadId: ThreadId.make("other-worker"),
    });
    const facts = input({
      snapshot: snapshot({
        initiatives: [initiative(), initiative({ id: "two", title: "Second goal" })],
        tasks: [task(), other],
      }),
      execution: [
        input().execution[0]!,
        {
          taskId: "other",
          threadId: other.ownerThreadId,
          state: "input",
          detail: null,
          needsAttention: true,
        },
      ],
    });
    const result = classifyCrewSupervision(facts);
    expect(result.attention).toHaveLength(1);
    expect(result.attention[0]).toMatchObject({
      initiativeId: "two",
      initiativeTitle: "Second goal",
      taskId: "other",
    });
    expect(new Set(result.items.map((item) => item.id)).size).toBe(result.items.length);
    expect(classifyCrewSupervision(facts)).toEqual(result);
    expect(classifyCrewSupervision({ ...facts, freshness: "disconnected" }).clear).toBe(false);
    const resolved = classifyCrewSupervision({
      ...facts,
      execution: facts.execution.map((fact) => ({ ...fact, state: "working" as const })),
    });
    expect(resolved.attention).toEqual([]);
    expect(resolved.items.find((item) => item.taskId === "task")?.id).toBe(
      result.items.find((item) => item.taskId === "task")?.id,
    );
  });
});
