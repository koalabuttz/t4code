import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  RuntimeRequestId,
  ThreadId,
  type TeamworkReadResult,
  type TeamworkTask,
} from "@t3tools/contracts";
import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import { makeRawThreadShell, makeThreadShellFixture } from "../../test-fixtures";
import {
  mobileCrewArtifactWorkspace,
  mobileCrewRecipients,
  mobileCrewSupervision,
} from "./crewMobile.logic";

const worker = ThreadId.make("worker");
const coordinator = ThreadId.make("coordinator");
const task = (overrides: Partial<TeamworkTask> = {}): TeamworkTask => ({
  id: "work",
  initiativeId: "one",
  title: "Work",
  brief: "Deliver",
  criteria: "Verified",
  roleId: null,
  milestoneId: null,
  dependencies: [],
  knowledgeIds: [],
  status: "running",
  ownerThreadId: worker,
  delegatedTaskId: null,
  delegationId: null,
  evidence: "",
  review: null,
  createdAt: "2026-11-17T00:00:00Z",
  updatedAt: "2026-11-17T00:00:00Z",
  ...overrides,
});
const data = (): TeamworkReadResult => ({
  snapshot: {
    projectId: ProjectId.make("project-test"),
    revision: 1,
    coordinatorThreadId: coordinator,
    initiatives: ["one", "two"].map((id) => ({
      id,
      title: id,
      brief: "Goal",
      mode: "swarm",
      status: "active",
      approved: true,
      milestones: [],
      createdAt: "2026-11-17T00:00:00Z",
      updatedAt: "2026-11-17T00:00:00Z",
    })),
    tasks: [task()],
    board: [],
    roles: [],
    knowledge: [],
  },
  deliveries: [],
});

describe("mobile Crew source adaptation", () => {
  it("takes question identity and human-only ownership only from the current shell request", () => {
    for (const userOnly of [false, true]) {
      const source = makeRawThreadShell({
        id: worker,
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("current-question"),
          kind: "user_input",
          userOnly,
          createdAt: makeRawThreadShell().createdAt,
        },
      });
      const shell = makeThreadShellFixture({ id: worker, source, hasPendingUserInput: true });
      const result = mobileCrewSupervision(data(), [shell], "current");
      expect(
        result.items.find((item) => item.taskId === "work" && item.kind === "input"),
      ).toMatchObject({
        responsibility: userOnly ? "human" : "unknown",
        requestId: "current-question",
        action: {
          kind: "open-thread",
          threadId: worker,
          requestId: "current-question",
          focus: "input",
        },
      });
    }
    const staleSummary = makeThreadShellFixture({ id: worker, hasPendingUserInput: true });
    expect(
      mobileCrewSupervision(data(), [staleSummary], "current").items.find(
        (item) => item.kind === "input",
      ),
    ).toMatchObject({ responsibility: "unknown", actor: { kind: "unknown" } });
  });

  it("uses subscribed shells across initiatives and preserves global failures and connection uncertainty", () => {
    const initial = data();
    const second = ThreadId.make("second-worker");
    const read: TeamworkReadResult = {
      ...initial,
      snapshot: {
        ...initial.snapshot,
        tasks: [task(), task({ id: "second", initiativeId: "two", ownerThreadId: second })],
      },
      deliveries: [
        { id: "orphan", threadId: ThreadId.make("orphan"), kind: "message", status: "failed" },
      ],
    };
    const shells = [
      presentThreadShell(
        EnvironmentId.make("environment-test"),
        makeRawThreadShell({ id: coordinator, status: "failed" }),
      ),
      makeThreadShellFixture({ id: worker, hasPendingApprovals: true }),
      makeThreadShellFixture({ id: second, hasPendingUserInput: true }),
    ];
    const result = mobileCrewSupervision(read, shells, "current");
    expect(result.attention).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "coordinator-failed", initiativeId: null }),
        expect.objectContaining({ kind: "approval", initiativeId: "one" }),
        expect.objectContaining({ kind: "input", initiativeId: "two" }),
        expect.objectContaining({ kind: "message-failed", initiativeId: null }),
      ]),
    );
    const disconnected = mobileCrewSupervision(read, shells, "disconnected");
    expect(disconnected.clear).toBe(false);
    expect(disconnected.initiatives.map((initiative) => initiative.progress.running)).toEqual([
      null,
      null,
    ]);
    expect(disconnected.items.find((item) => item.taskId === "work")).toMatchObject({
      freshness: "last-known",
      responsibility: "unknown",
    });
  });

  it("excludes completed, cancelled and other-initiative recipients and deduplicates shared workers", () => {
    const snapshot = {
      ...data().snapshot,
      tasks: [
        task(),
        task({ id: "duplicate" }),
        task({ id: "other", initiativeId: "two", ownerThreadId: ThreadId.make("other") }),
        task({ id: "done", status: "done", ownerThreadId: ThreadId.make("done") }),
        task({ id: "cancelled", status: "cancelled", ownerThreadId: ThreadId.make("cancelled") }),
      ],
    };
    const shells = [coordinator, worker].map((id) => makeThreadShellFixture({ id }));
    expect(mobileCrewRecipients(snapshot, "one", shells)).toEqual([coordinator, worker]);
    expect(mobileCrewRecipients(snapshot, "one", [shells[0]!])).toEqual([coordinator]);
  });

  it("resolves artifact content in its recorded source workspace and refuses missing sources", () => {
    const shells = [makeThreadShellFixture({ id: worker, worktreePath: "/worktrees/submission" })];
    expect(mobileCrewArtifactWorkspace(worker, shells, "/project")).toBe("/worktrees/submission");
    expect(mobileCrewArtifactWorkspace(ThreadId.make("missing"), shells, "/project")).toBeNull();
    expect(mobileCrewArtifactWorkspace(null, shells, "/project")).toBe("/project");
  });
});
