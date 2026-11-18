import { TeamworkArtifact, type TeamworkTask } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isArtifact = Schema.is(TeamworkArtifact);

export function parseCrewArtifact(
  kind: "commit" | "content",
  ref: string,
  path: string,
): typeof TeamworkArtifact.Type | null {
  const artifact = { kind, ref: ref.trim(), ...(path.trim() ? { path: path.trim() } : {}) };
  return isArtifact(artifact) ? artifact : null;
}

export function crewReviewLabel(task: {
  status: TeamworkTask["status"];
  submission?: { revision: number } | null | undefined;
  review: { decision: "approve" | "changes"; submissionRevision?: number | undefined } | null;
}) {
  const submission = task.submission;
  if (!submission) return "No immutable submission recorded.";
  if (task.review && task.review.submissionRevision !== submission.revision) {
    const previous =
      task.review.submissionRevision === undefined
        ? "has no submission revision"
        : `is for submission ${task.review.submissionRevision}`;
    return `Submission ${submission.revision} needs fresh review; recorded review ${previous}.`;
  }
  if (task.review?.decision === "changes")
    return `Changes requested for submission ${submission.revision}`;
  if (task.status === "done" && task.review?.decision === "approve")
    return `Accepted submission ${submission.revision}`;
  return `Submission ${submission.revision} needs review`;
}

export function crewIncludedSubmissionLabel(
  included: { taskId: string; revision: number },
  tasks: readonly {
    id: string;
    title: string;
    submission?: { revision: number } | null | undefined;
  }[],
) {
  const task = tasks.find((item) => item.id === included.taskId);
  const current = task?.submission?.revision;
  return `${task?.title ?? included.taskId} · included submission ${included.revision}${current === undefined ? " · current submission unavailable" : current !== included.revision ? ` · replaced by submission ${current}` : ""}`;
}

export function crewIntegratedArtifacts(initiative: {
  milestones: readonly {
    id: string;
    title: string;
    verification?: { artifact: typeof TeamworkArtifact.Type } | null | undefined;
  }[];
}) {
  return initiative.milestones.flatMap((milestone) =>
    milestone.verification
      ? [
          {
            milestoneId: milestone.id,
            title: milestone.title,
            artifact: milestone.verification.artifact,
          },
        ]
      : [],
  );
}

export const crewDeliveryNotice =
  "Task acceptance and integrated milestone acceptance are separate. Integration, merge and publication remain outstanding unless recorded verification evidence confirms them.";
