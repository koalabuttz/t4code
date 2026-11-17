import { CommandId, EnvironmentId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { CrewConsultation, CrewConversationPage } from "@t3tools/contracts/crewConversation";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";
import { scopedProjectKey } from "../environment/index.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { scopeThreadShell } from "./models.ts";
import {
  crewCandidateThread,
  crewHandoffMessageId,
  crewDraftBrief,
  crewDraftMode,
  crewDraftTitle,
  crewFilters,
  crewMessageDraft,
  crewLiveFreshness,
  crewOriginThread,
  crewReturnContext,
  crewScrollOffset,
  crewSelectedInitiative,
  crewSelectedTask,
  crewSelectedView,
  prepareCrewEntry,
  readCrewCommand,
  readCrewTimelineMetadata,
  resolveCrewCoordinator,
} from "./crew.ts";

const project = { environmentId: EnvironmentId.make("env-a"), projectId: v2ThreadShell.projectId };
const origin = scopeThreadShell(project.environmentId, v2ThreadShell);
const other = { ...origin, id: ThreadId.make("other") };

it("loads visible exchanges across bounded selections and pages, rejects other scopes and abandons obsolete reads", async () => {
  const records = Array.from({ length: 205 }, (_, index): CrewConsultation => ({
    id: String(index).padStart(3, "0"),
    origin: {
      conversation: { ...project, threadId: origin.id },
      messageId: MessageId.make(`question-${index}`),
      runId: null,
      actor: "user",
      sender: null,
    },
    destination: { ...project, threadId: other.id },
    deliveryId: CommandId.make(`delivery-${index}`),
    context: { sources: [], attachments: [], replyTo: null },
    replyTo: null,
    progress: { state: "queued" },
    createdAt: "2026-11-17T00:00:00Z",
    updatedAt: "2026-11-17T00:00:00Z",
  }));
  const empty: CrewConversationPage = {
    scope: project,
    revision: 1,
    consultations: [],
    handoffs: [],
    attention: [],
    workstreams: [],
    taskLinks: [],
    nextCursor: null,
  };
  const ids = records.map((record) => record.origin.messageId);
  const handoff = { origin: records[0]!.origin, explanation: records[1]!.origin };
  expect(crewHandoffMessageId(handoff, ids)).toBe(handoff.explanation.messageId);
  expect(crewHandoffMessageId(handoff, [handoff.origin.messageId])).toBe(handoff.origin.messageId);
  expect(crewHandoffMessageId(handoff, [])).toBeNull();
  const result = await readCrewTimelineMetadata(
    project,
    origin.id,
    [...ids, ids[0]!],
    async (query) => {
      expect(query.messageIds?.length).toBeLessThanOrEqual(100);
      if (query.collection !== "consultations") return empty;
      const matching = records.filter(
        (record) =>
          query.messageIds?.includes(record.origin.messageId) && record.id > (query.cursor ?? ""),
      );
      const selected = matching.slice(0, 50);
      return {
        ...empty,
        consultations: selected,
        nextCursor: matching.length > 50 ? selected.at(-1)!.id : null,
      };
    },
    new AbortController().signal,
  );
  expect(result.consultations.sort((a, b) => a.id.localeCompare(b.id))).toEqual(records);
  await expect(
    readCrewTimelineMetadata(
      project,
      origin.id,
      ids.slice(0, 1),
      async () => ({ ...empty, scope: { ...project, environmentId: EnvironmentId.make("other") } }),
      new AbortController().signal,
    ),
  ).rejects.toThrow("another project");
  const controller = new AbortController();
  let reads = 0;
  await expect(
    readCrewTimelineMetadata(
      project,
      origin.id,
      ids,
      async () => {
        reads++;
        controller.abort();
        return { ...empty, consultations: records.slice(0, 1), nextCursor: records[0]!.id };
      },
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(reads).toBe(1);
});

it("uses received live subscription data while waiting for the next update", () => {
  const live = { data: { revision: 7 }, error: null, isSuccess: true, isPending: true };
  expect(crewLiveFreshness(true, live)).toBe("current");
  expect(crewLiveFreshness(false, live)).toBe("disconnected");
  expect(crewLiveFreshness(true, { ...live, error: "Subscription failed" })).toBe("stale");
  expect(crewLiveFreshness(true, { ...live, data: null, isSuccess: false })).toBe("unknown");
  expect(crewLiveFreshness(true, { ...live, data: { revision: 8 } })).toBe("current");
});

describe("Crew coordinator selection", () => {
  it("reuses the project coordinator ahead of both origin and a chosen candidate", () => {
    expect(
      resolveCrewCoordinator({
        project,
        threads: [origin, other],
        coordinatorThreadId: other.id,
        originThreadId: origin.id,
        candidateThreadId: origin.id,
      }),
    ).toMatchObject({ threadId: other.id, source: "coordinator" });
    expect(
      resolveCrewCoordinator({
        project,
        threads: [origin],
        coordinatorThreadId: other.id,
        originThreadId: origin.id,
      }),
    ).toMatchObject({ threadId: other.id, source: "coordinator", reason: expect.any(String) });
  });

  it("uses an eligible origin and allows an explicit eligible choice", () => {
    expect(
      resolveCrewCoordinator({
        project,
        threads: [other, origin],
        coordinatorThreadId: null,
        originThreadId: origin.id,
      }),
    ).toMatchObject({ threadId: origin.id, source: "origin", reason: null });
    expect(
      resolveCrewCoordinator({
        project,
        threads: [other, origin],
        coordinatorThreadId: null,
        originThreadId: origin.id,
        candidateThreadId: other.id,
      }),
    ).toMatchObject({ threadId: other.id, source: "candidate" });
  });

  it.each([
    ["missing", []],
    ["deleted", [{ ...origin, deletedAt: "2026-11-17T00:00:00Z" }]],
    ["wrong project", [{ ...origin, projectId: ProjectId.make("another") }]],
    ["wrong environment", [{ ...origin, environmentId: EnvironmentId.make("another") }]],
    [
      "provider child",
      [
        {
          ...origin,
          source: {
            ...origin.source,
            creationSource: "provider",
            lineage: {
              ...origin.lineage,
              parentThreadId: other.id,
              relationshipToParent: "subagent",
            },
          },
        },
      ],
    ],
  ] as const)(
    "explains an ineligible %s origin without choosing an arbitrary thread",
    (_name, threads) => {
      expect(
        resolveCrewCoordinator({
          project,
          threads: [...threads, other],
          coordinatorThreadId: null,
          originThreadId: origin.id,
        }),
      ).toMatchObject({ threadId: null, source: "none", reason: expect.any(String) });
    },
  );

  it("requires a choice when opened from project navigation and does not fall back from a stale choice", () => {
    expect(
      resolveCrewCoordinator({ project, threads: [other], coordinatorThreadId: null }).threadId,
    ).toBeNull();
    expect(
      resolveCrewCoordinator({
        project,
        threads: [origin],
        coordinatorThreadId: null,
        originThreadId: origin.id,
        candidateThreadId: other.id,
      }).threadId,
    ).toBeNull();
  });
});

describe("Crew local continuity", () => {
  it("preserves a brief on empty entry and keeps a suggested title editable across navigation", () => {
    const registry = AtomRegistry.make();
    const key = scopedProjectKey(project);
    prepareCrewEntry(registry, project, {
      threadId: origin.id,
      brief: "\n  Repair the deployment\nKeep the release history",
    });
    expect(registry.get(crewDraftTitle(key))).toBe("Repair the deployment");
    registry.set(crewDraftTitle(key), "Release recovery");
    prepareCrewEntry(registry, project, { brief: "" });
    expect(registry.get(crewDraftBrief(key))).toBe(
      "\n  Repair the deployment\nKeep the release history",
    );
    expect(registry.get(crewDraftTitle(key))).toBe("Release recovery");
    expect(registry.get(crewOriginThread(key))).toBe(origin.id);
    registry.set(crewDraftBrief(key), "A revised goal");
    expect(registry.get(crewDraftTitle(key))).toBe("Release recovery");
    registry.set(crewDraftTitle(key), null);
    expect(registry.get(crewDraftTitle(key))).toBe("A revised goal");
    prepareCrewEntry(registry, project, { threadId: other.id });
    expect(registry.get(crewOriginThread(key))).toBe(other.id);
    expect(
      resolveCrewCoordinator({
        project,
        threads: [origin, other],
        coordinatorThreadId: null,
        originThreadId: registry.get(crewOriginThread(key)),
        candidateThreadId: registry.get(crewCandidateThread(key)),
      }),
    ).toMatchObject({ threadId: other.id, source: "origin" });
    expect(registry.get(crewDraftBrief(key))).toBe("A revised goal");
    registry.dispose();
  });

  it("retains initiative, task, view, filters, scroll and communication draft in the project and environment scope", () => {
    const registry = AtomRegistry.make();
    const key = scopedProjectKey(project);
    registry.set(crewSelectedInitiative(key), "initiative");
    registry.set(crewSelectedTask(key), "task");
    registry.set(crewSelectedView(key), "board");
    registry.set(crewDraftMode(key), "teamwork");
    registry.set(crewFilters(key), { query: "review", status: "review", ownerThreadId: origin.id });
    registry.set(crewScrollOffset(key), 425);
    registry.set(crewMessageDraft(key), {
      text: "Please inspect this result",
      recipients: [origin.id],
      intent: "ask",
    });
    registry.set(crewReturnContext(key), {
      threadId: origin.id,
      taskId: "task",
      kind: "approval",
      requestId: "request",
    });
    prepareCrewEntry(registry, project, {});
    expect(registry.get(crewSelectedInitiative(key))).toBe("initiative");
    expect(registry.get(crewSelectedTask(key))).toBe("task");
    expect(registry.get(crewSelectedView(key))).toBe("board");
    expect(registry.get(crewDraftMode(key))).toBe("teamwork");
    expect(registry.get(crewFilters(key)).query).toBe("review");
    expect(registry.get(crewScrollOffset(key))).toBe(425);
    expect(registry.get(crewMessageDraft(key)).text).toBe("Please inspect this result");
    expect(registry.get(crewReturnContext(key))?.requestId).toBe("request");
    for (const otherKey of [
      scopedProjectKey({ ...project, environmentId: EnvironmentId.make("env-b") }),
      scopedProjectKey({ ...project, projectId: ProjectId.make("project-b") }),
    ]) {
      expect(registry.get(crewSelectedInitiative(otherKey))).toBeNull();
      expect(registry.get(crewSelectedTask(otherKey))).toBeNull();
      expect(registry.get(crewScrollOffset(otherKey))).toBe(0);
      expect(registry.get(crewMessageDraft(otherKey)).text).toBe("");
    }
    registry.set(crewCandidateThread(key), other.id);
    expect(registry.get(crewOriginThread(key))).toBeNull();
    registry.dispose();
  });

  it.each([
    ["/crew", ""],
    [" /SWARM  Build a tool\nwith history ", "Build a tool\nwith history"],
    ["/crew launch", "launch"],
  ])("keeps parsing %s", (text, brief) => {
    expect(readCrewCommand(text)).toEqual({ brief });
  });
  it.each(["/crews", "/swarmish", "ordinary text"])("does not consume %s", (text) => {
    expect(readCrewCommand(text)).toBeNull();
  });
});
