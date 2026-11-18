import { OutpostSurfaceRequestInput, WS_METHODS } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  createEnvironmentRpcStreamCommand,
} from "./runtime.ts";

export const parseOutpostSurfaceRequest = Schema.decodeUnknownSync(OutpostSurfaceRequestInput);

export function createOutpostSurfaceEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const request = createEnvironmentRpcStreamCommand(runtime, {
    label: "outpost:surface-request",
    tag: WS_METHODS.outpostSurfaceRequest,
  });
  return {
    changes: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "outpost:surfaces",
      tag: WS_METHODS.outpostSurfacesSubscribe,
      idleTtlMs: 0,
    }),
    read: createEnvironmentRpcCommand(runtime, {
      label: "outpost:surface-read",
      tag: WS_METHODS.outpostSurfaceDocument,
    }),
    request,
  };
}
