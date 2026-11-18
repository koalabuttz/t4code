import { EnvironmentId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { CrewConversationQuery } from "@t3tools/contracts/crewConversation";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const readPage = vi.hoisted(() => vi.fn());
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  executeAtomQuery: (_registry: unknown, input: CrewConversationQuery) => readPage(input),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    crewConversations: (request: { input: CrewConversationQuery }) => request.input,
  },
}));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/query", () => ({}));
vi.mock("../../state/shell", () => ({}));
vi.mock("../../state/threads", () => ({}));
vi.mock("../../state/use-atom-command", () => ({}));
vi.mock("../../lib/uuid", () => ({}));

import { useCrewTimelineMetadata } from "./use-crew-project";

it("prunes a drained selection without querying and reloads only an evicted ID", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  readPage.mockReset().mockImplementation(async (input: CrewConversationQuery) => ({
    _tag: "Success",
    value: { scope: input.scope, consultations: [], handoffs: [], nextCursor: null },
  }));

  const scope = {
    environmentId: EnvironmentId.make("native"),
    projectId: ProjectId.make("crew"),
  };
  const threadId = ThreadId.make("worker");
  const queued = Array.from({ length: 230 }, (_, i) =>
    MessageId.make(`queue-${i.toString().padStart(3, "0")}`),
  );
  const container = document.createElement("div");
  const root = createRoot(container);

  function Probe({ selection }: { selection: readonly MessageId[] }) {
    const timeline = useCrewTimelineMetadata(scope, threadId, 1, selection);
    return <output>{timeline.data?.messageIds.join(",")}</output>;
  }
  const render = (selection: readonly MessageId[]) =>
    act(async () => root.render(<Probe selection={selection} />));

  try {
    await render(queued);
    expect(container.textContent?.split(",")).toEqual(queued);
    const readsBeforeDrain = readPage.mock.calls.length;

    await render([queued[0]!]);
    expect(container.textContent?.split(",")).toEqual([queued[0], ...queued.slice(-200)]);
    expect(readPage).toHaveBeenCalledTimes(readsBeforeDrain);

    await render([queued[0]!, queued[1]!]);
    expect(readPage.mock.calls.slice(readsBeforeDrain).map(([input]) => input.messageIds)).toEqual([
      [queued[1]],
      [queued[1]],
    ]);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
