import { expect, it } from "vite-plus/test";
import type { OutpostCatalog } from "@t3tools/contracts";
import { applyFleetEvents, staleFleetSessions } from "./fleet.ts";

it("applies ordered fleet changes and discards the batch when it requests a reset", () => {
  const catalog: OutpostCatalog = {
    version: 1,
    fleet_epoch: "epoch:A",
    cursor: "cursor:opaque",
    generated_at: "2026-11-16T00:00:00Z",
    name: "Outpost",
    version_name: "0.9.8",
    projects: [],
    sessions: [],
  };
  const session = {
    id: "session",
    project_id: "project",
    lifecycle_state: "running",
    launch_mode: "project_direct",
    freshness: "fresh",
    observed_at: "2026-11-16T00:00:00Z",
  };
  const batch = {
    fleet_epoch: "epoch:A",
    cursor: "cursor:next",
    heartbeat_interval_secs: 15,
    events: [
      { type: "session_upsert" as const, session },
      {
        type: "project_upsert" as const,
        project: { id: "project", path: "/remote", configuration_name: "default" },
      },
      { type: "session_removed" as const, session_id: "session" },
    ],
  };
  expect(applyFleetEvents(catalog, batch)).toMatchObject({
    cursor: "cursor:next",
    sessions: [],
    projects: [{ id: "project" }],
  });
  expect(
    applyFleetEvents(catalog, { ...batch, events: [...batch.events, { type: "reset_required" }] }),
  ).toBeNull();
  expect(applyFleetEvents(catalog, { ...batch, fleet_epoch: "epoch:B" })).toBeNull();
  const snapshot = { ...catalog, sessions: [session] };
  expect(
    staleFleetSessions(snapshot, Date.parse("2026-11-16T00:00:16Z")).sessions?.[0]?.freshness,
  ).toBe("stale");
  expect(
    staleFleetSessions(snapshot, Date.parse("2026-11-16T00:00:14Z")).sessions?.[0]?.freshness,
  ).toBe("fresh");
});
