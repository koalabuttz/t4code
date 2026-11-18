import {
  createEnvironmentRpcSubscriptionAtomFamily,
  executeAtomQuery,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type ScopedProjectRef, type ThreadId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";

const readTeamworkOnce = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "mobile:crew-project-footprint",
  tag: WS_METHODS.teamworkSubscribe,
  completeWhen: () => true,
  idleTtlMs: 0,
});

export interface CrewProjectFootprint {
  readonly hasCrew: boolean;
  readonly coordinatorThreadId: ThreadId | null;
}

function hasCrewProjectFootprint(snapshot: {
  readonly coordinatorThreadId: ThreadId | null;
  readonly initiatives: readonly unknown[];
}): boolean {
  return snapshot.coordinatorThreadId !== null || snapshot.initiatives.length > 0;
}

export async function readCrewProjectFootprint(
  scope: ScopedProjectRef,
  signal: AbortSignal,
): Promise<CrewProjectFootprint | null> {
  const { environmentId, projectId } = scope;
  const result = await executeAtomQuery(
    appAtomRegistry,
    readTeamworkOnce({ environmentId, input: { projectId } }),
    { signal, reportFailure: false },
  );
  if (result._tag !== "Success" || result.value.snapshot.projectId !== projectId) return null;
  const { snapshot } = result.value;
  return {
    hasCrew: hasCrewProjectFootprint(snapshot),
    coordinatorThreadId: snapshot.coordinatorThreadId,
  };
}
