import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import { crewTaskExecution } from "./crewExecution.ts";

describe("Crew execution state", () => {
  const task = { id: "task", ownerThreadId: ThreadId.make("worker"), status: "running" as const };
  const worker = {
    status: "completed" as const,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
  };

  it("keeps execution completion separate from submitted and accepted work", () => {
    expect(crewTaskExecution(task, worker)).toMatchObject({
      state: "finished",
      needsAttention: true,
    });
    expect(crewTaskExecution(task, { ...worker, hasPendingBackgroundTasks: true })).toMatchObject({
      state: "waiting",
      needsAttention: false,
    });
    expect(crewTaskExecution({ ...task, status: "review" }, worker)).toMatchObject({
      state: "finished",
      needsAttention: false,
    });
    expect(
      crewTaskExecution({ ...task, status: "done" }, { ...worker, status: "interrupted" }),
    ).toMatchObject({ state: "stopped", needsAttention: false });
  });

  it("surfaces requests even when a worker is still running", () => {
    expect(
      crewTaskExecution(task, { ...worker, status: "running", hasPendingUserInput: true }),
    ).toMatchObject({ state: "input", needsAttention: true });
    expect(crewTaskExecution(task, { ...worker, hasPendingApprovals: true })).toMatchObject({
      state: "approval",
      needsAttention: true,
    });
  });

  it("does not infer a crash from an unloaded thread or a lost connection", () => {
    expect(crewTaskExecution(task, null).state).toBe("unknown");
    expect(crewTaskExecution(task, "unavailable").state).toBe("unavailable");
    expect(crewTaskExecution(task, { ...worker, status: "failed" }, false)).toMatchObject({
      state: "disconnected",
      needsAttention: false,
    });
    expect(
      crewTaskExecution({ ...task, ownerThreadId: null, status: "delegating" }, null).state,
    ).toBe("starting");
  });
});
