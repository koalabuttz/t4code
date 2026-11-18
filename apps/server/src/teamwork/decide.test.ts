import { assert, it } from "@effect/vitest";
import {
  NodeId,
  ProjectId,
  ThreadId,
  type TeamworkAction,
  type TeamworkSnapshot,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import { decideTeamwork, emptyTeamwork } from "./decide.ts";

const coordinator = ThreadId.make("coordinator");
const builder = ThreadId.make("builder");
const now = "2026-11-16T12:00:00.000Z";
function apply(state: TeamworkSnapshot, action: TeamworkAction, actor: ThreadId | null = null) {
  return Result.getOrThrow(decideTeamwork(state, action, actor, now, `command-${state.revision}`));
}
function setup(mode: "swarm" | "teamwork" = "swarm") {
  const state = apply(emptyTeamwork(ProjectId.make("project")), {
    type: "coordinator.set",
    threadId: coordinator,
  }).snapshot;
  return apply(state, {
    type: "initiative.create",
    id: "initiative",
    title: "Invitations",
    brief: "Implement expiring invitations",
    mode,
  }).snapshot;
}
const createTask = (
  id: string,
  dependencies: string[] = [],
): Extract<TeamworkAction, { type: "task.create" }> => ({
  type: "task.create",
  id,
  initiativeId: "initiative",
  title: id,
  brief: "Implement the API",
  criteria: "Expired invitations are rejected",
  roleId: null,
  milestoneId: null,
  dependencies,
  knowledgeIds: [],
});
function assign(state: TeamworkSnapshot, id: string, owner = builder) {
  const reserved = apply(
    state,
    { type: "task.reserve", id, delegationId: id },
    coordinator,
  ).snapshot;
  return apply(
    reserved,
    {
      type: "task.assign",
      id,
      delegationId: id,
      threadId: owner,
      delegatedTaskId: NodeId.make(id),
    },
    coordinator,
  ).snapshot;
}

it("requires user approval before Teamwork execution and invalidates approval when its brief changes", () => {
  let state = apply(setup("teamwork"), createTask("api")).snapshot;
  assert.isTrue(
    Result.isFailure(
      decideTeamwork(
        state,
        { type: "task.reserve", id: "api", delegationId: "attempt" },
        coordinator,
        now,
        "reserve",
      ),
    ),
  );
  assert.isTrue(
    Result.isFailure(
      decideTeamwork(
        state,
        { type: "initiative.approve", id: "initiative" },
        coordinator,
        now,
        "approve",
      ),
    ),
  );
  state = apply(state, { type: "initiative.approve", id: "initiative" }).snapshot;
  state = assign(state, "api");
  const changed = apply(state, {
    type: "initiative.edit",
    id: "initiative",
    title: "Invitations",
    brief: "Require single-use invitations too",
    mode: "teamwork",
  });
  assert.equal(changed.snapshot.initiatives[0]?.status, "draft");
  assert.isFalse(changed.snapshot.initiatives[0]!.approved);
  assert.deepEqual(
    changed.intents.map((i) => [i.kind, i.threadId]),
    [["stop", builder]],
  );
});

it("keeps results under review until another participant approves and then unlocks dependencies", () => {
  let state = apply(setup(), createTask("api")).snapshot;
  state = apply(state, createTask("ui", ["api"])).snapshot;
  state = assign(state, "api");
  assert.isTrue(
    Result.isFailure(
      decideTeamwork(
        state,
        { type: "task.reserve", id: "ui", delegationId: "ui" },
        coordinator,
        now,
        "early",
      ),
    ),
  );
  state = apply(
    state,
    {
      type: "task.report",
      id: "api",
      status: "review",
      evidence: "Expiry and single-use integration tests pass; commit abc123.",
      attemptId: "api",
      artifact: { kind: "commit", ref: "a".repeat(40) },
    },
    builder,
  ).snapshot;
  const firstSubmission = state.revision;
  const rejectAssignedEdit = (snapshot: TeamworkSnapshot) => {
    assert.isTrue(
      Result.isFailure(
        decideTeamwork(
          snapshot,
          { ...createTask("api"), type: "task.edit", criteria: "Also reject invalid timestamps" },
          coordinator,
          now,
          "edit-assigned-task",
        ),
      ),
    );
  };
  rejectAssignedEdit(state);
  assert.equal(state.tasks[0]?.submission?.revision, firstSubmission);
  assert.isTrue(
    Result.isFailure(
      decideTeamwork(
        state,
        {
          type: "task.review",
          id: "api",
          submissionRevision: firstSubmission,
          decision: "approve",
          evidence: "I wrote it",
        },
        builder,
        now,
        "self",
      ),
    ),
  );
  state = apply(
    state,
    {
      type: "task.review",
      id: "api",
      submissionRevision: firstSubmission,
      decision: "changes",
      evidence: "Add the boundary-expiry test.",
    },
    coordinator,
  ).snapshot;
  rejectAssignedEdit(state);
  state = apply(
    state,
    {
      type: "task.report",
      id: "api",
      attemptId: "api",
      status: "review",
      artifact: { kind: "commit", ref: "b".repeat(40) },
      evidence: "Boundary-expiry test passes on the revised commit.",
    },
    builder,
  ).snapshot;
  assert.isTrue(
    Result.isFailure(
      decideTeamwork(
        state,
        {
          type: "task.review",
          id: "api",
          submissionRevision: firstSubmission,
          decision: "approve",
          evidence: "Approval of the old commit",
        },
        coordinator,
        now,
        "old-review",
      ),
    ),
  );
  state = apply(
    state,
    {
      type: "task.review",
      id: "api",
      submissionRevision: state.revision,
      decision: "approve",
      evidence: "Independently reproduced rejection of expired invitations.",
    },
    coordinator,
  ).snapshot;
  rejectAssignedEdit(state);
  state = assign(state, "ui", ThreadId.make("ui-worker"));
  assert.equal(state.tasks.find((t) => t.id === "ui")?.status, "running");
  assert.isTrue(
    Result.isFailure(
      decideTeamwork(
        state,
        { type: "task.reset", id: "api", status: "ready" },
        null,
        now,
        "invalidate-prerequisite",
      ),
    ),
  );
  assert.isTrue(
    Result.isFailure(
      decideTeamwork(
        state,
        { type: "initiative.status", id: "initiative", status: "completed" },
        coordinator,
        now,
        "premature",
      ),
    ),
  );
});

it("rejects cyclic dependencies and prevents workers changing another assignment", () => {
  let state = apply(setup(), createTask("api")).snapshot;
  state = apply(state, createTask("ui", ["api"])).snapshot;
  const definition = createTask("api", ["ui"]);
  assert.isTrue(
    Result.isFailure(
      decideTeamwork(state, { ...definition, type: "task.edit" }, coordinator, now, "cycle"),
    ),
  );
  state = assign(state, "api");
  assert.isTrue(
    Result.isFailure(
      decideTeamwork(
        state,
        { type: "task.report", id: "ui", status: "review", evidence: "Claim someone else's work" },
        builder,
        now,
        "impersonate",
      ),
    ),
  );
});

it("stops a worker attached after pause and disallows messages that would restart it", () => {
  let state = apply(setup(), createTask("api")).snapshot;
  state = apply(
    state,
    { type: "task.reserve", id: "api", delegationId: "attempt" },
    coordinator,
  ).snapshot;
  state = apply(state, { type: "initiative.status", id: "initiative", status: "paused" }).snapshot;
  const attached = apply(
    state,
    {
      type: "task.assign",
      id: "api",
      delegationId: "attempt",
      threadId: builder,
      delegatedTaskId: NodeId.make("child"),
    },
    coordinator,
  );
  assert.equal(attached.snapshot.tasks[0]?.status, "blocked");
  assert.deepEqual(
    attached.intents.map((i) => i.kind),
    ["stop"],
  );
  assert.isTrue(
    Result.isFailure(
      decideTeamwork(
        attached.snapshot,
        { type: "board.post", initiativeId: "initiative", text: "Continue", recipients: [builder] },
        coordinator,
        now,
        "wake",
      ),
    ),
  );
});

it("preserves work when promoting a swarm and invalidates completed milestone gates on reopened work", () => {
  let state = apply(setup(), {
    type: "milestone.save",
    initiativeId: "initiative",
    milestone: { id: "api", title: "API", criteria: "Expiry tested", accepted: false },
  }).snapshot;
  state = apply(state, { ...createTask("api"), milestoneId: "api" } as TeamworkAction).snapshot;
  state = apply(state, {
    type: "milestone.save",
    initiativeId: "initiative",
    milestone: {
      id: "release",
      title: "Release",
      criteria: "Integration passes",
      accepted: false,
      dependencies: ["api"],
    },
  }).snapshot;
  state = apply(state, { ...createTask("release"), milestoneId: "release" }).snapshot;
  assert.isTrue(
    Result.isFailure(
      decideTeamwork(
        state,
        { type: "task.reserve", id: "release", delegationId: "early" },
        coordinator,
        now,
        "before-integration",
      ),
    ),
  );
  assert.isTrue(
    Result.isFailure(
      decideTeamwork(
        state,
        {
          type: "milestone.save",
          initiativeId: "initiative",
          milestone: {
            id: "api",
            title: "API",
            criteria: "Cycle",
            accepted: false,
            dependencies: ["release"],
          },
        },
        coordinator,
        now,
        "milestone-cycle",
      ),
    ),
  );
  state = assign(state, "api");
  state = apply(
    state,
    {
      type: "task.report",
      id: "api",
      attemptId: "api",
      status: "review",
      artifact: { kind: "commit", ref: "a".repeat(40) },
      evidence: "Tests pass",
    },
    builder,
  ).snapshot;
  state = apply(state, {
    type: "task.review",
    id: "api",
    decision: "approve",
    evidence: "Verified independently",
    submissionRevision: state.revision,
  }).snapshot;
  assert.isTrue(
    Result.isFailure(
      decideTeamwork(
        state,
        { type: "milestone.accept", initiativeId: "initiative", id: "api", accepted: true },
        coordinator,
        now,
        "unverified-integration",
      ),
    ),
  );
  state = apply(state, {
    type: "milestone.accept",
    initiativeId: "initiative",
    id: "api",
    accepted: true,
    artifact: { kind: "commit", ref: "b".repeat(40) },
    evidence: "Integrated API and client tests pass at this commit.",
  }).snapshot;
  state = assign(state, "release", ThreadId.make("release-worker"));
  assert.isTrue(
    Result.isFailure(
      decideTeamwork(
        state,
        { type: "task.reset", id: "api", status: "ready" },
        null,
        now,
        "invalidate-milestone",
      ),
    ),
  );
  assert.isTrue(
    Result.isFailure(
      decideTeamwork(
        state,
        { ...createTask("another-api"), milestoneId: "api" },
        null,
        now,
        "expand-milestone",
      ),
    ),
  );
  state = apply(state, { type: "task.reset", id: "release", status: "cancelled" }).snapshot;
  state = apply(state, {
    type: "milestone.accept",
    initiativeId: "initiative",
    id: "release",
    accepted: true,
    artifact: { kind: "commit", ref: "c".repeat(40) },
    evidence: "Release work was cancelled; integration verified.",
  }).snapshot;
  state = apply(state, {
    type: "initiative.status",
    id: "initiative",
    status: "completed",
  }).snapshot;
  state = apply(state, {
    type: "milestone.accept",
    initiativeId: "initiative",
    id: "release",
    accepted: false,
  }).snapshot;
  state = apply(state, { type: "task.reset", id: "api", status: "ready" }).snapshot;
  assert.equal(state.initiatives[0]?.status, "paused");
  assert.isFalse(state.initiatives[0]!.milestones[0]!.accepted);
  const promoted = apply(state, {
    type: "initiative.edit",
    id: "initiative",
    title: "Invitations",
    brief: "Ship invitations across platforms",
    mode: "teamwork",
  }).snapshot;
  assert.equal(promoted.tasks.length, 2);
  assert.equal(promoted.initiatives[0]?.status, "draft");
});

it("preserves assignments and reviews across a paused coordinator handover", () => {
  let state = apply(setup(), createTask("api")).snapshot;
  state = assign(state, "api");
  const paused = apply(state, { type: "coordinator.pause" });
  assert.equal(paused.snapshot.initiatives[0]?.status, "paused");
  assert.deepEqual(
    paused.intents.map((intent) => intent.threadId),
    [builder, coordinator],
  );
  state = apply(paused.snapshot, {
    type: "coordinator.set",
    threadId: ThreadId.make("fresh-coordinator"),
  }).snapshot;
  assert.equal(state.tasks[0]?.ownerThreadId, builder);
  assert.equal(state.tasks[0]?.delegationId, "api");
  assert.equal(state.tasks[0]?.attemptCount, 1);
  assert.isTrue(
    Result.isFailure(
      decideTeamwork(
        state,
        { type: "task.reserve", id: "api", delegationId: "duplicate" },
        coordinator,
        now,
        "old-coordinator",
      ),
    ),
  );
  const resumed = apply(state, { type: "initiative.status", id: "initiative", status: "active" });
  assert.equal(resumed.snapshot.tasks[0]?.delegationId, "api");
  assert.deepEqual(
    resumed.intents.map((intent) => intent.threadId),
    [ThreadId.make("fresh-coordinator")],
  );
});

it("bounds assignment retries and submissions and rejects stale attempts and terminal updates", () => {
  let state = apply(setup(), {
    type: "initiative.policy",
    id: "initiative",
    policy: { maxConcurrent: 1, maxAttempts: 2, maxSubmissions: 1 },
  }).snapshot;
  state = apply(state, createTask("api")).snapshot;
  state = apply(state, createTask("other")).snapshot;
  state = assign(state, "api");
  const rejected = (action: TeamworkAction, actor: ThreadId | null = coordinator) =>
    assert.isTrue(Result.isFailure(decideTeamwork(state, action, actor, now, "rejected")));
  rejected({ type: "task.reserve", id: "other", delegationId: "other" });
  rejected(
    {
      type: "task.report",
      id: "api",
      attemptId: "previous",
      status: "blocked",
      evidence: "Late report",
    },
    builder,
  );
  state = apply(state, { type: "initiative.status", id: "initiative", status: "paused" }).snapshot;
  rejected(
    {
      type: "task.report",
      id: "api",
      attemptId: "api",
      status: "running",
      evidence: "Continue while paused",
    },
    builder,
  );
  state = apply(state, { type: "initiative.status", id: "initiative", status: "active" }).snapshot;
  const report = {
    type: "task.report",
    id: "api",
    attemptId: "api",
    status: "review",
    artifact: { kind: "commit", ref: "a".repeat(40) },
    evidence: "Implementation tested",
  } as const;
  state = apply(state, report, builder).snapshot;
  const reviewed = apply(
    state,
    {
      type: "task.review",
      id: "api",
      submissionRevision: state.revision,
      decision: "changes",
      evidence: "Boundary case missing",
    },
    coordinator,
  );
  state = reviewed.snapshot;
  assert.deepEqual(reviewed.intents, []);
  rejected(report, builder);
  state = apply(state, { type: "task.reset", id: "api", status: "ready" }).snapshot;
  state = apply(state, { type: "task.reserve", id: "api", delegationId: "replacement" }).snapshot;
  state = apply(state, {
    type: "task.assign",
    id: "api",
    delegationId: "replacement",
    threadId: builder,
    delegatedTaskId: NodeId.make("replacement"),
  }).snapshot;
  rejected(report, builder);
  state = apply(state, { type: "task.reset", id: "api", status: "ready" }).snapshot;
  rejected({ type: "task.reserve", id: "api", delegationId: "third" });
  assert.equal(state.tasks[0]?.attemptCount, 2);
  state = apply(state, {
    type: "initiative.status",
    id: "initiative",
    status: "cancelled",
  }).snapshot;
  rejected(
    {
      type: "task.report",
      id: "api",
      attemptId: "replacement",
      status: "review",
      evidence: "Late result",
      artifact: { kind: "commit", ref: "b".repeat(40) },
    },
    builder,
  );
});
