import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { readCrewProjectFootprint } from "./crew-project-footprints";

const query = vi.hoisted(() => vi.fn<() => unknown>());
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createEnvironmentRpcSubscriptionAtomFamily: () => () => ({}),
  executeAtomQuery: query,
}));

const scope = {
  environmentId: EnvironmentId.make("environment"),
  projectId: ProjectId.make("project"),
};
const coordinator = ThreadId.make("coordinator");

it.each([
  { coordinatorThreadId: null, initiatives: [], hasCrew: false },
  { coordinatorThreadId: coordinator, initiatives: [], hasCrew: true },
  { coordinatorThreadId: null, initiatives: [{ status: "completed" }], hasCrew: true },
  { coordinatorThreadId: null, initiatives: [{ status: "paused" }], hasCrew: true },
])(
  "recognizes a persisted coordinator or initiative footprint",
  async ({ coordinatorThreadId, initiatives, hasCrew }) => {
    query.mockResolvedValueOnce({
      _tag: "Success",
      value: { snapshot: { projectId: scope.projectId, coordinatorThreadId, initiatives } },
    });
    await expect(readCrewProjectFootprint(scope, new AbortController().signal)).resolves.toEqual({
      coordinatorThreadId,
      hasCrew,
    });
  },
);

it("leaves failed and mismatched reads unknown", async () => {
  query.mockResolvedValueOnce({ _tag: "Failure" }).mockResolvedValueOnce({
    _tag: "Success",
    value: { snapshot: { projectId: ProjectId.make("other"), coordinatorThreadId: coordinator } },
  });
  const signal = new AbortController().signal;
  await expect(readCrewProjectFootprint(scope, signal)).resolves.toBeNull();
  await expect(readCrewProjectFootprint(scope, signal)).resolves.toBeNull();
});
