import { createFileRoute } from "@tanstack/react-router";
import { CrewWorkspace } from "../components/teamwork/CrewWorkspace";

export const Route = createFileRoute("/_chat/projects/$projectKey/crew")({
  component: CrewWorkspace,
});
