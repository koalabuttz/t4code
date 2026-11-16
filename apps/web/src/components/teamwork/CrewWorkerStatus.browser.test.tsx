import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { EnvironmentId, ThreadId, type TeamworkTask } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentShellStatus } from "../../state/shell";
import { threadFamilies } from "../../state/threads";
import { CrewWorkerStatus } from "./CrewWorkerStatus";

vi.mock(import("../../state/entities"), () => ({ useQuietThreadShell: vi.fn() }));
vi.mock(import("../../state/shell"), () => ({ useEnvironmentShellStatus: vi.fn() }));
vi.mock("../../state/threads", () => ({ threadFamilies: { mount: vi.fn() } }));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));

function setup() {
  vi.clearAllMocks();
  const registry = AtomRegistry.make();
  const worker = Atom.make<ReturnType<typeof useQuietThreadShell>>(null).pipe(Atom.keepAlive);
  const row = {
    lineage: { rootThreadId: ThreadId.make("previous-coordinator") },
    runtime: { status: "completed" },
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingBackgroundTasks: [],
  } as unknown as NonNullable<ReturnType<typeof useQuietThreadShell>>;
  vi.mocked(useEnvironmentShellStatus).mockReturnValue("live");
  vi.mocked(useQuietThreadShell).mockImplementation(function useWorker() {
    return useAtomValue(worker);
  });
  vi.mocked(threadFamilies.mount).mockImplementation((_registry, _environmentId, threadId) => {
    if (threadId === "idle-worker") registry.set(worker, row);
    return () => registry.set(worker, null);
  });
  return { registry, [Symbol.dispose]: () => registry.dispose() };
}

it("keeps an idle worker mounted when its original coordinator is discovered", async () => {
  using fixture = setup();
  const environmentId = EnvironmentId.make("crew-environment");
  const task = {
    id: "implementation",
    ownerThreadId: ThreadId.make("idle-worker"),
    status: "review",
  } as TeamworkTask;
  await using screen = await render(
    <RegistryContext.Provider value={fixture.registry}>
      <CrewWorkerStatus environmentId={environmentId} task={task} />
    </RegistryContext.Provider>,
  );

  await expect.element(screen.getByText("Worker finished")).toBeInTheDocument();
  await screen.rerender(
    <RegistryContext.Provider value={fixture.registry}>
      <CrewWorkerStatus environmentId={environmentId} task={{ ...task, status: "done" }} />
    </RegistryContext.Provider>,
  );
  await expect.element(screen.getByText("Worker finished")).toBeInTheDocument();
  await screen.unmount();
});
