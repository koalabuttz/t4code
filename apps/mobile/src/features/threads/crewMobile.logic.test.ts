import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  CommandId,
  MessageId,
  NodeId,
  RunId,
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
  mobileCrewDraftAfterSave,
  mobileCrewMessageDeliveries,
  mobileCrewRecipients,
  mobileCrewSupervision,
  mobileCrewReturnedAnswer,
  mobileCrewReturnEnvelope,
  mobileCrewPendingAttention,
  mobileCrewRequestState,
  mobileCrewWorkstreamGroups,
  retainMobileCrewTimelineMetadata,
} from "./crewMobile.logic";
import type { CrewConsultation, CrewHandoff } from "@t3tools/contracts/crewConversation";

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
  it("attributes only the exact delivered return in the originating conversation", () => {
    const conversation = {
      environmentId: EnvironmentId.make("env"),
      projectId: ProjectId.make("project-test"),
      threadId: ThreadId.make("origin"),
    };
    const destination = { ...conversation, threadId: ThreadId.make("specialist") };
    const question = {
      conversation,
      messageId: MessageId.make("question"),
      runId: null,
      actor: "user" as const,
      sender: null,
    };
    const response = {
      ...question,
      conversation: destination,
      messageId: MessageId.make("answer"),
      actor: "agent" as const,
    };
    const now = "2026-11-17T00:00:00Z";
    const consultation = {
      id: "example",
      origin: question,
      destination,
      deliveryId: CommandId.make("exact-delivery"),
      context: { replyTo: null, sources: [], attachments: [] },
      replyTo: null,
      progress: {
        state: "answered",
        exchange: {
          request: { ...question, conversation: destination },
          response,
          responseId: response.messageId,
        },
      },
      createdAt: now,
      updatedAt: now,
    } satisfies CrewConsultation;
    const text = `Crew consultation example answered. From specialist. Canonical source: ${JSON.stringify(response)}\nThe answer.`;
    const returned = { id: "exact-delivery:return", text, senderThreadId: destination.threadId };

    const explanation = { ...question, messageId: MessageId.make("explanation") };
    const handoff = {
      id: "handoff",
      origin: question,
      explanation,
      destination,
      context: consultation.context,
      consultationId: consultation.id,
      ownership: { state: "discussion-only" },
      state: "ready",
      createdAt: now,
      updatedAt: now,
    } satisfies CrewHandoff;
    const initial = {
      messageIds: [question.messageId],
      consultations: [consultation],
      handoffs: [handoff],
    };
    const next = { messageIds: [MessageId.make("neighbor")], consultations: [], handoffs: [] };
    const scrolled = retainMobileCrewTimelineMetadata(initial, next);
    expect(scrolled.consultations).toEqual([consultation]);
    expect(scrolled.handoffs).toEqual([handoff]);
    expect(
      retainMobileCrewTimelineMetadata(scrolled, {
        ...next,
        messageIds: [explanation.messageId],
      }).handoffs,
    ).toEqual([]);
    const longPage = {
      ...next,
      messageIds: Array.from({ length: 200 }, (_, i) => MessageId.make(`row-${i}`)),
    };
    expect(
      retainMobileCrewTimelineMetadata(retainMobileCrewTimelineMetadata(initial, longPage), next)
        .consultations,
    ).toEqual([]);
    const selectedIds = [question.messageId, ...longPage.messageIds, ...next.messageIds];
    const incremented = retainMobileCrewTimelineMetadata(
      retainMobileCrewTimelineMetadata(initial, longPage),
      next,
      selectedIds,
    );
    expect(selectedIds.filter((id) => !incremented.messageIds.includes(id))).toEqual([]);
    expect(incremented.consultations).toEqual([consultation]);
    expect(incremented.handoffs).toEqual([handoff]);

    expect(mobileCrewReturnedAnswer(conversation, consultation, returned)).toBe("The answer.");
    expect(mobileCrewReturnedAnswer(destination, consultation, returned)).toBeNull();
    expect(mobileCrewReturnEnvelope(returned)?.consultationId).toBe("example");
    expect(
      mobileCrewReturnedAnswer(conversation, consultation, {
        ...returned,
        text: text.replace('"messageId":"answer"', '"messageId":"different-answer"'),
      }),
    ).toBeNull();
    expect(
      mobileCrewReturnedAnswer(
        { ...conversation, environmentId: EnvironmentId.make("other") },
        consultation,
        returned,
      ),
    ).toBeNull();
    expect(
      mobileCrewReturnedAnswer(conversation, consultation, { ...returned, id: "old:return" }),
    ).toBeNull();
    expect(
      mobileCrewReturnedAnswer(conversation, consultation, {
        ...returned,
        senderThreadId: conversation.threadId,
      }),
    ).toBeNull();
    expect(
      mobileCrewReturnedAnswer(
        conversation,
        { ...consultation, progress: { state: "queued" } },
        returned,
      ),
    ).toBeNull();
  });

  it("continues past historical attention and ignores resolved and wrong-coordinator requests", () => {
    const conversation = {
      environmentId: EnvironmentId.make("env"),
      projectId: ProjectId.make("project"),
      threadId: ThreadId.make("work"),
    };
    const target = { ...conversation, threadId: coordinator };
    const when = "2026-11-17T00:00:00Z";
    const attention = {
      id: "request:201",
      source: {
        conversation,
        messageId: MessageId.make("question"),
        actor: "user" as const,
        runId: null,
        sender: null,
      },
      coordinator: target,
      reason: "question" as const,
      correlationId: null,
      pendingRequest: {
        requestId: RuntimeRequestId.make("question"),
        runId: RunId.make("run"),
        responder: "user-only" as const,
      },
      progress: { state: "pending" as const },
      createdAt: when,
      updatedAt: when,
    };
    const page = { revision: 2, scope: target };
    expect(
      mobileCrewPendingAttention(target, 2, {
        ...page,
        attention: [{ ...attention, pendingRequest: null }],
        nextCursor: "request:200",
      }),
    ).toEqual({ requests: [], nextCursor: "request:200" });
    expect(
      mobileCrewPendingAttention(target, 2, {
        ...page,
        attention: [attention, { ...attention, id: "request:202", coordinator: conversation }],
        nextCursor: null,
      }),
    ).toEqual({ requests: [attention], nextCursor: null });
    expect(
      mobileCrewPendingAttention(target, 3, {
        ...page,
        attention: [attention],
        nextCursor: null,
      }),
    ).toBeNull();
  });

  it("does not select an unrelated request when the linked one resolves or points to a different run", () => {
    const requestId = RuntimeRequestId.make("A");
    const runId = RunId.make("run-A");
    const nodeId = NodeId.make("node");
    const target = { requestId, runId };
    const a = { id: requestId, nodeId, status: "pending" as const };
    const b = { ...a, id: RuntimeRequestId.make("B") };
    expect(
      mobileCrewRequestState(
        target,
        { runtimeRequests: [a, b], nodes: [{ id: nodeId, runId }] },
        true,
      ),
    ).toEqual({ kind: "pending", requestId });
    expect(
      mobileCrewRequestState(
        target,
        { runtimeRequests: [{ ...a, status: "resolved" }, b], nodes: [{ id: nodeId, runId }] },
        true,
      ),
    ).toEqual({ kind: "unavailable" });
    expect(
      mobileCrewRequestState(
        target,
        { runtimeRequests: [a, b], nodes: [{ id: nodeId, runId: RunId.make("other") }] },
        true,
      ),
    ).toEqual({ kind: "unavailable" });
    expect(mobileCrewRequestState({ requestId }, null, false)).toEqual({ kind: "unavailable" });
    expect(mobileCrewRequestState(target, null, false)).toEqual({ kind: "loading" });
  });

  it("keeps a replacement under its linked workstream and treats offline execution as unconfirmed", () => {
    const initial = data();
    const scope = {
      environmentId: EnvironmentId.make("environment-test"),
      projectId: initial.snapshot.projectId,
    };
    const replacement = ThreadId.make("replacement");
    const original = makeThreadShellFixture({ id: worker, ...scope });
    const working = presentThreadShell(
      scope.environmentId,
      makeRawThreadShell({ id: replacement, status: "running" }),
    );
    const read = {
      ...initial,
      snapshot: { ...initial.snapshot, tasks: [task({ ownerThreadId: replacement })] },
    };
    const workstream = { ...scope, threadId: worker };
    const input = {
      scope,
      workstreams: [
        {
          conversation: workstream,
          title: "Android",
          status: "open" as const,
          linkedAt: "2026-11-17T00:00:00Z",
          updatedAt: "2026-11-17T00:00:00Z",
        },
      ],
      links: [{ workstream, taskId: "work", initiativeId: "one" }],
      threads: [original, working],
      supervision: mobileCrewSupervision(read, [original, working], "current"),
      freshness: "current" as const,
      search: "andROid",
    };
    expect(mobileCrewWorkstreamGroups(input)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Working",
          rows: [
            expect.objectContaining({
              workstream: expect.objectContaining({ conversation: workstream }),
            }),
          ],
        }),
      ]),
    );
    const unconfirmed = mobileCrewWorkstreamGroups({ ...input, freshness: "disconnected" });
    expect(unconfirmed[0]?.rows[0]?.detail).toBe("Execution is unconfirmed");
    expect(
      mobileCrewWorkstreamGroups({ ...input, search: "Desktop" }).every(
        (group) => group.rows.length === 0,
      ),
    ).toBe(true);
  });

  it("keeps a resolved workstream in Resolved when the live shell omits its idle worker", () => {
    const initial = data();
    const scope = {
      environmentId: EnvironmentId.make("environment-test"),
      projectId: initial.snapshot.projectId,
    };
    const conversation = { ...scope, threadId: worker };
    const settled = { ...initial.snapshot, tasks: [task({ status: "done" })] };
    const input = {
      scope,
      workstreams: [
        {
          conversation,
          title: "Android",
          status: "resolved" as const,
          linkedAt: "2026-11-17T00:00:00Z",
          updatedAt: "2026-11-17T00:00:00Z",
        },
      ],
      links: [{ workstream: conversation, taskId: "work", initiativeId: "one" }],
      threads: [],
      supervision: mobileCrewSupervision({ ...initial, snapshot: settled }, [], "current"),
      freshness: "current" as const,
      search: "",
    };
    const section = (groups: ReturnType<typeof mobileCrewWorkstreamGroups>) =>
      groups.find((group) => group.rows.length > 0)?.title;
    expect(section(mobileCrewWorkstreamGroups(input))).toBe("Resolved");
    const search = mobileCrewWorkstreamGroups({
      ...input,
      search: "Andriod",
      workstreams: [
        ...input.workstreams,
        {
          ...input.workstreams[0]!,
          title: "Andriod",
          conversation: { ...conversation, environmentId: EnvironmentId.make("other") },
        },
        {
          ...input.workstreams[0]!,
          title: "Andriod",
          status: "unlinked",
          conversation: { ...conversation, threadId: ThreadId.make("unlinked") },
        },
      ],
    });
    expect(search.flatMap((group) => group.rows.map((row) => row.workstream.conversation))).toEqual(
      [conversation],
    );
    expect(section(mobileCrewWorkstreamGroups({ ...input, freshness: "disconnected" }))).toBe(
      "Needs you",
    );
    const failedStop = {
      id: "stop",
      kind: "stop" as const,
      status: "failed" as const,
      threadId: worker,
      taskId: "work",
      initiativeId: "one",
    };
    const supervision = mobileCrewSupervision(
      { ...initial, snapshot: settled, deliveries: [failedStop] },
      [],
      "current",
    );
    expect(section(mobileCrewWorkstreamGroups({ ...input, supervision }))).toBe("Needs you");
  });

  it("clears only an unchanged saved quiet note and preserves in-flight edits or unconfirmed sends", () => {
    const submitted = { text: "Original note", recipients: [worker], intent: "note" as const };
    expect(mobileCrewDraftAfterSave(submitted, submitted, true)).toEqual({
      ...submitted,
      text: "",
    });
    for (const current of [
      { ...submitted, text: "New note typed during save" },
      { ...submitted, intent: "ask" as const },
      { ...submitted, recipients: [coordinator] },
    ]) {
      expect(mobileCrewDraftAfterSave(current, submitted, true)).toBe(current);
    }
    for (const saved of [false, undefined]) {
      expect(mobileCrewDraftAfterSave(submitted, submitted, saved)).toBe(submitted);
    }
    const question = { ...submitted, intent: "ask" as const };
    expect(mobileCrewDraftAfterSave(question, question, true)).toBe(question);
  });

  it("correlates each recipient's delivery to its board revision rather than their latest project message", () => {
    const projectId = ProjectId.make("project-test");
    const entry = {
      id: "question-one",
      revision: 7,
      initiativeId: "one",
      text: "First question",
      recipients: [worker, coordinator],
      authorThreadId: null,
      createdAt: "2026-11-17T00:00:00Z",
    };
    const matching = {
      id: `${projectId}:7:0`,
      threadId: worker,
      kind: "message" as const,
      status: "failed" as const,
    };
    const deliveries: TeamworkReadResult["deliveries"] = [
      { ...matching, id: `${projectId}:8:0`, status: "delivered" },
      { ...matching, id: `${projectId}:70:0`, status: "pending" },
      { ...matching, id: "other-project:7:0", status: "delivered" },
      { ...matching, id: `${projectId}:7:1`, kind: "stop" },
      matching,
    ];
    expect(mobileCrewMessageDeliveries(projectId, entry, deliveries)).toEqual([
      { threadId: worker, delivery: matching },
      { threadId: coordinator, delivery: null },
    ]);
    const secondInitiativeMessage = {
      ...entry,
      id: "question-two",
      initiativeId: "two",
      revision: 8,
    };
    expect(
      mobileCrewMessageDeliveries(projectId, secondInitiativeMessage, deliveries)[0]?.delivery,
    ).toEqual(deliveries[0]);
    expect(
      mobileCrewMessageDeliveries(projectId, { ...entry, revision: undefined }, deliveries),
    ).toEqual([
      { threadId: worker, delivery: null },
      { threadId: coordinator, delivery: null },
    ]);
    for (const status of ["pending", "delivered", "failed", "cancelled"] as const) {
      const delivery = { ...matching, status };
      expect(mobileCrewMessageDeliveries(projectId, entry, [delivery])[0]?.delivery).toEqual(
        delivery,
      );
    }
  });
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
