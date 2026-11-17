import type {
  OrchestrationV2AppThread,
  OrchestrationV2ProviderThread,
  OrchestrationV2Subagent,
} from "@t3tools/contracts";
import type { IdAllocatorV2 } from "@t3tools/provider-core/server/IdAllocator";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import { makeSubagentChildThread } from "@t3tools/provider-core/server/subagentProjection";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Collection from "./collection.ts";
import type { Outcome } from "./AlbedoNativeOutcomes.ts";
import type * as Protocol from "./sessionProtocol.ts";
import { modelSlug } from "./models.ts";
import { driver, providerRef } from "./turnProjection.ts";

const encodeKey = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.Json)));
export const displayKey = (native: typeof Protocol.SessionSummary.Type, outcome?: Outcome) =>
  encodeKey([
    outcome?.runId ?? null,
    outcome?.state ?? null,
    native.id,
    native.name,
    native.workspace,
    native.role,
    native.parent_id,
    native.started_by,
    native.closed,
    native.provider_profile,
    native.model,
    native.effort,
    native.status.phase,
    native.status.run_id,
    native.status.interrupt_requested,
    native.status.blocking_reason?.code ?? null,
    native.status.blocking_reason?.detail ?? null,
    native.current_progress.map((item) => [
      item.call_id,
      item.name,
      item.phase,
      item.title ?? null,
    ]),
  ]);

export function project(input: {
  readonly appThread: OrchestrationV2AppThread;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly snapshot: Collection.Snapshot;
  readonly ids: IdAllocatorV2["Service"]["derive"];
  readonly now: DateTime.Utc;
  readonly changedIds?: ReadonlySet<string>;
  readonly firstSeen?: ReadonlyMap<string, DateTime.Utc>;
  readonly outcomes?: ReadonlyMap<string, Outcome>;
}): ReadonlyArray<ProviderAdapterV2Event> {
  const { appThread, providerThread, snapshot, ids, now } = input;
  const rootId = providerThread.nativeThreadRef?.nativeId;
  if (rootId == null || !snapshot.has(rootId)) return [];
  const owned = Collection.owned(snapshot, rootId);
  if (owned.length === 0) return [];
  const owner = { driver, backgroundOwnerThreadId: appThread.id };
  const nativeKey = (id: string) => `${providerThread.id}/native-agent/${id}`;
  const nodeId = (id: string) => ids.nodeFromProviderItem({ driver, nativeItemId: nativeKey(id) });
  const rootNodeId = nodeId(rootId);
  const events: ProviderAdapterV2Event[] = [
    {
      ...owner,
      type: "node.updated",
      node: {
        id: rootNodeId,
        threadId: appThread.id,
        runId: null,
        parentNodeId: null,
        rootNodeId,
        kind: "root_turn",
        status: "idle",
        countsForRun: false,
        providerThreadId: providerThread.id,
        providerTurnId: null,
        nativeItemRef: providerRef(rootId),
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: providerThread.createdAt,
        completedAt: null,
      },
    },
  ];
  for (const [index, native] of owned.entries()) {
    if (input.changedIds !== undefined && !input.changedIds.has(native.id)) continue;
    const startedAt =
      native.created_at == null
        ? (input.firstSeen?.get(native.id) ?? now)
        : DateTime.makeUnsafe(native.created_at);
    const id = nodeId(native.id);
    const outcome = input.outcomes?.get(native.id);
    const completedAt = outcome?.observedAt ?? null;
    const parentNodeId = nodeId(native.parent_id ?? native.started_by ?? rootId);
    const status: OrchestrationV2Subagent["status"] =
      outcome !== undefined
        ? outcome.state === "abandoned"
          ? "failed"
          : outcome.state
        : native.status.phase === "idle"
          ? "idle"
          : native.status.blocking_reason !== null
            ? "waiting"
            : "running";
    const model =
      native.provider_profile !== null && native.model !== null
        ? modelSlug(native.provider_profile, native.model)
        : null;
    const childThreadId =
      model === null
        ? null
        : ids.subagentThread({
            driver,
            providerInstanceId: providerThread.providerInstanceId,
            nativeThreadId: native.id,
          });
    const childProviderThreadId =
      childThreadId === null
        ? null
        : ids.providerThread({
            driver,
            providerInstanceId: providerThread.providerInstanceId,
            nativeThreadId: native.id,
          });
    if (childThreadId !== null && childProviderThreadId !== null && model !== null) {
      const child = makeSubagentChildThread({
        parentThread: appThread,
        childThreadId,
        parentNodeId: id,
        activeProviderThreadId: childProviderThreadId,
        providerInstanceId: providerThread.providerInstanceId,
        modelSelection: {
          instanceId: providerThread.providerInstanceId,
          model,
          ...(native.effort === null ? {} : { options: [{ id: "effort", value: native.effort }] }),
        },
        title: native.name || native.role || "Albedo helper",
        now: startedAt,
        createdBy: "agent",
        creationSource: "provider",
      });
      const separateWorkspace = native.workspace !== snapshot.get(rootId)?.workspace;
      events.push(
        {
          ...owner,
          type: "app_thread.created",
          createOnly: true,
          appThread: separateWorkspace
            ? { ...child, branch: null, worktreePath: native.workspace }
            : child,
        },
        {
          ...owner,
          type: "provider_thread.updated",
          providerThread: {
            id: childProviderThreadId,
            driver,
            providerInstanceId: providerThread.providerInstanceId,
            providerSessionId: providerThread.providerSessionId,
            appThreadId: childThreadId,
            ownerNodeId: id,
            nativeThreadRef: providerRef(native.id),
            nativeConversationHeadRef: null,
            status: native.status.phase === "idle" ? "idle" : "active",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt: startedAt,
            updatedAt: now,
          },
        },
      );
    }
    const progress =
      outcome !== undefined
        ? `Native turn ${outcome.state}; session remains resumable`
        : (native.status.blocking_reason?.detail ??
          (native.closed
            ? "Closed in Albedo; completion has not been reconciled"
            : native.current_progress.map((item) => item.title ?? item.name).join(" · ") ||
              (status === "idle"
                ? "Idle in Albedo; no completion outcome confirmed"
                : `Albedo: ${native.status.phase}`)));
    events.push(
      {
        ...owner,
        type: "node.updated",
        node: {
          id,
          threadId: appThread.id,
          runId: null,
          parentNodeId,
          rootNodeId,
          kind: "subagent",
          status,
          countsForRun: false,
          providerThreadId: childProviderThreadId,
          providerTurnId: null,
          nativeItemRef: providerRef(native.id),
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt,
          completedAt,
        },
      },
      {
        ...owner,
        type: "subagent.updated",
        subagent: {
          id,
          threadId: appThread.id,
          runId: null,
          parentNodeId,
          origin: "provider_native",
          createdBy: "agent",
          driver,
          providerInstanceId: providerThread.providerInstanceId,
          providerThreadId: childProviderThreadId,
          childThreadId,
          nativeTaskRef: providerRef(native.id),
          prompt: native.role,
          title: native.name || "Albedo helper",
          model,
          status,
          progress,
          result: null,
          startedAt,
          completedAt,
          updatedAt: now,
        },
      },
      {
        ...owner,
        type: "turn_item.updated",
        turnItem: {
          id: ids.turnItemFromProviderItem({ driver, nativeItemId: nativeKey(native.id) }),
          threadId: appThread.id,
          runId: null,
          nodeId: id,
          providerThreadId: providerThread.id,
          providerTurnId: null,
          nativeItemRef: providerRef(native.id),
          parentItemId: null,
          ordinal: native.created_at == null ? index : DateTime.toEpochMillis(startedAt),
          status,
          title: native.name || "Albedo helper",
          startedAt,
          completedAt,
          updatedAt: now,
          type: "subagent",
          subagentId: id,
          childThreadId,
          prompt: native.role,
          result: null,
          progress,
          origin: "provider_native",
          driver,
          providerInstanceId: providerThread.providerInstanceId,
        },
      },
    );
  }
  return events;
}
