import { type OutpostCatalog, OutpostFleetEvents, OutpostSession } from "@t3tools/contracts";

export function applyFleetEvents(
  catalog: OutpostCatalog,
  batch: typeof OutpostFleetEvents.Type,
): OutpostCatalog | null {
  if (batch.fleet_epoch !== catalog.fleet_epoch) return null;
  let next = catalog;
  for (const event of batch.events ?? []) {
    switch (event.type) {
      case "reset_required":
        return null;
      case "epoch_started":
        if (event.fleet_epoch !== catalog.fleet_epoch) return null;
        break;
      case "catalog_snapshot":
        if (event.catalog.fleet_epoch !== catalog.fleet_epoch) return null;
        next = event.catalog;
        break;
      case "project_upsert":
        next = {
          ...next,
          projects: [
            ...(next.projects ?? []).filter((p) => p.id !== event.project.id),
            event.project,
          ],
        };
        break;
      case "project_removed":
        next = {
          ...next,
          projects: (next.projects ?? []).filter((p) => p.id !== event.project_id),
        };
        break;
      case "session_upsert":
      case "summary_changed":
        next = {
          ...next,
          sessions: [
            ...(next.sessions ?? []).filter((s) => s.id !== event.session.id),
            event.session,
          ],
        };
        break;
      case "session_removed":
        next = {
          ...next,
          sessions: (next.sessions ?? []).filter((s) => s.id !== event.session_id),
        };
        break;
      case "heartbeat":
        break;
    }
  }
  return { ...next, cursor: batch.cursor };
}

export function staleFleetSessions(catalog: OutpostCatalog, now: number): OutpostCatalog {
  return {
    ...catalog,
    sessions: catalog.sessions?.map((session): OutpostSession => {
      if (session.lifecycle_state !== "running") return session;
      const observed = session.observed_at ? Date.parse(session.observed_at) : NaN;
      return Number.isFinite(observed) && now - observed <= 15_000
        ? session
        : { ...session, freshness: "stale" };
    }),
  };
}
