import { createFileRoute } from "@tanstack/react-router";
import { CrewWorkspace } from "../components/teamwork/CrewWorkspace";
import type { CrewDestination, CrewSettingsSection } from "../components/teamwork/crewChatState";

export const Route = createFileRoute("/_chat/projects/$projectKey/crew")({
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    view?: Exclude<CrewDestination, "chat">;
    section?: CrewSettingsSection;
    handoff?: string;
  } => ({
    ...(search.view === "threads" || search.view === "results" || search.view === "settings"
      ? { view: search.view }
      : {}),
    ...(search.section === "project" ||
    search.section === "crew" ||
    search.section === "memory" ||
    search.section === "advanced"
      ? { section: search.section }
      : {}),
    ...(typeof search.handoff === "string" && search.handoff.length <= 120
      ? { handoff: search.handoff }
      : {}),
  }),
  component: CrewWorkspace,
});
