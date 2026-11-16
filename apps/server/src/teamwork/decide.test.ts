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
    },
    builder,
  ).snapshot;
  assert.isTrue(
    Result.isFailure(
      decideTeamwork(
        state,
        { type: "task.review", id: "api", decision: "approve", evidence: "I wrote it" },
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
      decision: "approve",
      evidence: "Independently reproduced rejection of expired invitations.",
    },
    coordinator,
  ).snapshot;
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
  state = assign(state, "api");
  state = apply(
    state,
    { type: "task.report", id: "api", status: "review", evidence: "Tests pass" },
    builder,
  ).snapshot;
  state = apply(state, {
    type: "task.review",
    id: "api",
    decision: "approve",
    evidence: "Verified independently",
  }).snapshot;
  state = apply(state, {
    type: "milestone.accept",
    initiativeId: "initiative",
    id: "api",
    accepted: true,
  }).snapshot;
  state = apply(state, {
    type: "initiative.status",
    id: "initiative",
    status: "completed",
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
  assert.equal(promoted.tasks.length, 1);
  assert.equal(promoted.initiatives[0]?.status, "draft");
});
