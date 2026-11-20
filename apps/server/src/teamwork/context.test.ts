import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId, type TeamworkSnapshot } from "@t3tools/contracts";
import { crewContext } from "./context.ts";
import { emptyTeamwork } from "./decide.ts";

it("bounds continuation context and retains sources while excluding corrected, forgotten and unrelated notes", () => {
  const coordinator = ThreadId.make("new-provider-coordinator");
  const worker = ThreadId.make("worker");
  const now = "2026-11-16T12:00:00.000Z";
  const state: TeamworkSnapshot = {
    ...emptyTeamwork(ProjectId.make("project")),
    revision: 42,
    coordinatorThreadId: coordinator,
    initiatives: [
      {
        id: "invite",
        title: "Invitations",
        brief: "Ship expiring invitations",
        mode: "swarm",
        approved: true,
        status: "paused",
        milestones: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    tasks: [
      {
        id: "api",
        initiativeId: "invite",
        title: "API",
        brief: "Implement expiry",
        criteria: "Reject expired codes",
        roleId: null,
        milestoneId: null,
        dependencies: [],
        knowledgeIds: ["expiry"],
        status: "blocked",
        ownerThreadId: worker,
        delegatedTaskId: null,
        delegationId: "attempt-2",
        evidence: "Boundary test fails",
        review: {
          threadId: ThreadId.make("reviewer"),
          decision: "changes",
          evidence: "Add exact boundary test",
          submissionRevision: 39,
        },
        submission: {
          revision: 39,
          attemptId: "attempt-2",
          artifact: { kind: "commit", ref: "a".repeat(40) },
          evidence: "Initial test results",
          threadId: worker,
          createdAt: now,
        },
        createdAt: now,
        updatedAt: now,
      },
    ],
    knowledge: [
      {
        id: "expiry",
        title: "Expiry correction",
        text: "Invitations expire after 48 hours",
        sourceRevision: 41,
        sourceThreadId: null,
        sourceTaskId: "api",
        initiativeId: "invite",
        updatedAt: now,
      },
      {
        id: "excluded",
        title: "Old expiry",
        text: "Invitations expire after 24 hours",
        excluded: true,
        sourceThreadId: null,
        sourceTaskId: null,
        updatedAt: now,
      },
      {
        id: "other",
        title: "Other branch",
        text: "UNRELATED_BRANCH_SECRET",
        initiativeId: "another-initiative",
        pinned: true,
        sourceThreadId: null,
        sourceTaskId: null,
        updatedAt: now,
      },
    ],
    board: [
      {
        id: "decision",
        initiativeId: "invite",
        authorThreadId: coordinator,
        text: "Use UTC boundaries",
        recipients: [],
        revision: 40,
        createdAt: now,
      },
    ],
  };
  const packet = crewContext(state, coordinator)!;
  const instructions =
    /<crew_coordinator_instructions>\n(.*?)\n<\/crew_coordinator_instructions>/s.exec(
      packet.text,
    )?.[1];
  assert.include(instructions, "Let work threads handle routine conversations.");
  assert.include(instructions, "attention collection in t3_crew_conversations");
  assert.include(packet.text, "48 hours");
  assert.include(packet.text, "attempt-2");
  assert.include(packet.text, "Add exact boundary test");
  assert.include(packet.text, "a".repeat(40));
  assert.notInclude(packet.text, "24 hours");
  assert.notInclude(packet.text, "UNRELATED_BRANCH_SECRET");
  assert.equal(packet.sources.find((s) => s.id === "expiry")?.revision, 41);
  assert.equal(packet.sources.find((s) => s.id === "decision")?.revision, 40);
  assert.notInclude(crewContext({ ...state, knowledge: [] }, coordinator)!.text, "48 hours");
  assert.equal(crewContext(state, ThreadId.make("unrelated-chat")), null);
  const workerPacket = crewContext(state, worker)!;
  assert.include(workerPacket.text, "48 hours");
  assert.notInclude(workerPacket.text, "<crew_coordinator_instructions>");
  const huge = {
    ...state,
    board: Array.from({ length: 60 }, (_, index) => ({
      ...state.board[0]!,
      id: `long-${index}`,
      text: "決定".repeat(6000),
    })),
  };
  const bounded = crewContext(huge, coordinator, "expiry", 2000)!;
  assert.isAtMost(Buffer.byteLength(bounded.text), 2000);
  assert.equal(bounded.bytes, Buffer.byteLength(bounded.text));
  assert.isAbove(bounded.omitted, 0);
  assert.equal(crewContext(state, coordinator, "", 100), null);
});
