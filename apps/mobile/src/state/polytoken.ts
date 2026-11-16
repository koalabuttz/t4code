import { createOutpostEnvironmentAtoms } from "@t3tools/client-runtime/state/polytoken";
import { createOutpostSurfaceEnvironmentAtoms } from "@t3tools/client-runtime/state/polytoken-surfaces";
import { connectionAtomRuntime } from "../connection/runtime";
export const outpostEnvironment = createOutpostEnvironmentAtoms(connectionAtomRuntime);
export const outpostSurfaceEnvironment =
  createOutpostSurfaceEnvironmentAtoms(connectionAtomRuntime);
