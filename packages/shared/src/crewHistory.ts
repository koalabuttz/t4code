import type { TeamworkAction } from "@t3tools/contracts";

export function crewHistoryText(action: TeamworkAction): string {
  if ("text" in action) return action.text;
  if ("brief" in action) return `${action.title}\n${action.brief}`;
  if ("evidence" in action && action.evidence !== undefined) return action.evidence;
  if ("role" in action) return `${action.role.name}\n${action.role.instructions}`;
  if ("milestone" in action) return `${action.milestone.title}\n${action.milestone.criteria}`;
  if ("status" in action) return `Status: ${action.status}`;
  if ("accepted" in action) return action.accepted ? "Milestone accepted" : "Milestone reopened";
  if (action.type === "initiative.archive") return "Archived with its tasks and evidence.";
  if (action.type === "initiative.restore")
    return "Restored paused. Resume explicitly to continue work.";
  return "Saved to project history.";
}
