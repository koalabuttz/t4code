import { useState } from "react";
import { useAtomRefresh } from "@effect/atom-react";
import type {
  EnvironmentId,
  TeamworkAction,
  TeamworkInitiative,
  TeamworkHistoryInput,
  TeamworkArtifact,
  TeamworkTask,
  ProjectId,
} from "@t3tools/contracts";
import {
  crewDeliveryNotice,
  crewIncludedSubmissionLabel,
  crewIntegratedArtifacts,
  crewReviewLabel,
  parseCrewArtifact,
} from "@t3tools/shared/crewArtifacts";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

type Props = {
  initiative: TeamworkInitiative;
  disabled: boolean;
  act: (action: TeamworkAction) => Promise<boolean>;
};

function CrewArtifactDetails({
  artifact,
  onOpenContent,
}: {
  artifact: typeof TeamworkArtifact.Type;
  onOpenContent?: ((path: string) => void) | undefined;
}) {
  return (
    <div className="space-y-2 break-all text-sm">
      <p>
        {artifact.kind === "commit" ? "Commit" : "Content SHA-256"}: <code>{artifact.ref}</code>
      </p>
      <p>Location: {artifact.path ?? "Repository commit (no file path recorded)"}</p>
      {artifact.kind === "content" ? (
        <>
          {onOpenContent && (
            <Button size="sm" variant="outline" onClick={() => onOpenContent(artifact.path)}>
              Open content path
            </Button>
          )}
          <p className="text-xs text-muted-foreground">
            {onOpenContent
              ? "The file viewer opens the current file; check that it still matches the recorded SHA-256."
              : "Content preview is unavailable here. Inspect the recorded path in the project or worker workspace and verify its SHA-256."}
          </p>
        </>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Exact commit changes are unavailable in this view. Inspect them in the project or worker
            repository:
          </p>
          <code>git show {artifact.ref}</code>
        </>
      )}
    </div>
  );
}

/** @public */
export function CrewTaskArtifact({
  task,
  environmentId,
  projectId,
  artifactsEnabled = false,
  onOpenContent,
}: {
  task: TeamworkTask;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  artifactsEnabled?: boolean;
  onOpenContent?: ((path: string) => void) | undefined;
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">{crewReviewLabel(task)}</p>
      {task.submission && (
        <>
          <CrewArtifactDetails artifact={task.submission.artifact} onOpenContent={onOpenContent} />
          <p className="text-xs">
            Attempt: {task.submission.attemptId} · Submitted: {task.submission.createdAt}
          </p>
          <p className="whitespace-pre-wrap text-sm">
            Submission evidence: {task.submission.evidence}
          </p>
          {artifactsEnabled ? (
            <CrewArtifactStatus
              key={task.submission.revision}
              environmentId={environmentId}
              input={{ projectId, artifactTaskId: task.id }}
            />
          ) : (
            <p className="text-xs">
              Artifact availability checks are unavailable on this environment.
            </p>
          )}
        </>
      )}
      {task.review && (
        <p className="whitespace-pre-wrap text-sm">
          Recorded review (
          {task.review.submissionRevision === undefined
            ? "revision unspecified"
            : `submission ${task.review.submissionRevision}`}
          ): {task.review.decision === "approve" ? "approved" : "changes requested"}.{" "}
          {task.review.evidence}
        </p>
      )}
      {task.status === "done" && (
        <p className="text-xs text-muted-foreground">{crewDeliveryNotice}</p>
      )}
    </div>
  );
}

export function CrewArtifactStatus({
  environmentId,
  input,
}: {
  environmentId: EnvironmentId;
  input: typeof TeamworkHistoryInput.Type;
}) {
  const [requested, setRequested] = useState(false);
  const artifactQuery = serverEnvironment.teamworkHistory({ environmentId, input });
  const refresh = useAtomRefresh(artifactQuery);
  const query = useEnvironmentQuery(requested ? artifactQuery : null);
  return (
    <div className="space-y-2">
      <Button
        size="sm"
        variant="outline"
        disabled={query.isPending}
        onClick={() => {
          setRequested(true);
          refresh();
        }}
      >
        Check latest artifact availability
      </Button>
      {requested && (
        <p className="text-xs" role="status">
          {query.isPending
            ? "Checking artifact…"
            : (query.error ??
              (query.data?.artifact
                ? `Latest saved artifact: ${query.data.artifact.status}. ${query.data.artifact.detail}`
                : "Checking artifact…"))}
        </p>
      )}
    </div>
  );
}

export function CrewLimits({ initiative, disabled, act }: Props) {
  const [policy, setPolicy] = useState(
    initiative.policy ?? { maxConcurrent: 4, maxAttempts: 3, maxSubmissions: 4 },
  );
  return (
    <details>
      <summary className="cursor-pointer text-sm">Execution limits</summary>
      <form
        className="mt-3 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void act({ type: "initiative.policy", id: initiative.id, policy });
        }}
      >
        {(
          [
            ["maxConcurrent", "Concurrent assignments", 16],
            ["maxAttempts", "Attempts per task", 20],
            ["maxSubmissions", "Submissions per task", 20],
          ] as const
        ).map(([field, label, max]) => (
          <label key={field} className="text-sm">
            {label}
            <Input
              aria-label={label}
              type="number"
              min={1}
              max={max}
              required
              value={policy[field]}
              onChange={(e) => setPolicy({ ...policy, [field]: Number(e.target.value) })}
            />
          </label>
        ))}
        <Button type="submit" size="sm" disabled={disabled}>
          Save limits
        </Button>
      </form>
    </details>
  );
}

export function CrewMilestone({
  initiative,
  milestone,
  disabled,
  requiresVerification,
  act,
  tasks = [],
  environmentId,
  projectId,
  artifactsEnabled = false,
  onOpenContent,
}: Props & {
  milestone: TeamworkInitiative["milestones"][number];
  requiresVerification: boolean;
  tasks?: readonly TeamworkTask[];
  environmentId?: EnvironmentId;
  projectId?: ProjectId;
  artifactsEnabled?: boolean;
  onOpenContent?: ((path: string) => void) | undefined;
}) {
  const [kind, setKind] = useState<"commit" | "content">("commit");
  const [ref, setRef] = useState("");
  const [path, setPath] = useState("");
  const [evidence, setEvidence] = useState("");
  const artifact = parseCrewArtifact(kind, ref, path);
  const choices = crewIntegratedArtifacts(initiative);
  return (
    <div className="space-y-3 rounded border p-3">
      <p className="text-sm font-medium">{milestone.title}</p>
      <p className="text-xs text-muted-foreground">{milestone.criteria}</p>
      {!!milestone.dependencies?.length && (
        <p className="text-xs text-muted-foreground">
          Starts after verified milestones:{" "}
          {milestone.dependencies
            .map((id) => initiative.milestones.find((m) => m.id === id)?.title ?? id)
            .join(", ")}
        </p>
      )}
      {milestone.verification && (
        <div className="space-y-2">
          <p className="text-sm font-medium">
            {milestone.accepted
              ? "Accepted integrated result"
              : "Previously verified integrated result (milestone reopened)"}
          </p>
          <CrewArtifactDetails
            artifact={milestone.verification.artifact}
            onOpenContent={onOpenContent}
          />
          <p className="text-xs">Verified: {milestone.verification.createdAt}</p>
          <p className="whitespace-pre-wrap text-sm">
            Verification evidence: {milestone.verification.evidence}
          </p>
          <p className="text-sm">Included accepted submissions:</p>
          {milestone.verification.submissions.length ? (
            <ul className="list-inside list-disc text-sm">
              {milestone.verification.submissions.map((included) => (
                <li key={included.taskId}>{crewIncludedSubmissionLabel(included, tasks)}</li>
              ))}
            </ul>
          ) : (
            <p className="text-xs">No task submissions were recorded in this verification.</p>
          )}
          {artifactsEnabled && environmentId && projectId && (
            <CrewArtifactStatus
              key={`${milestone.verification.createdAt}:${milestone.verification.artifact.ref}`}
              environmentId={environmentId}
              input={{ projectId, initiativeId: initiative.id, artifactMilestoneId: milestone.id }}
            />
          )}
        </div>
      )}
      {!milestone.accepted && requiresVerification && (
        <>
          <p className="text-xs text-muted-foreground">
            Provide the combined result explicitly. Worker submissions are not automatically
            integrated artifacts. New verification evidence is required even when reusing an
            artifact.
          </p>
          {choices.length > 0 ? (
            <div className="space-y-2">
              <p className="text-sm">Previously verified integrated artifacts</p>
              {choices.map((choice) => (
                <div key={choice.milestoneId} className="space-y-2">
                  <p className="break-all text-xs">
                    {choice.title}: {choice.artifact.kind} {choice.artifact.ref}
                    {choice.artifact.path ? ` · ${choice.artifact.path}` : ""}
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={disabled}
                    onClick={() => {
                      setKind(choice.artifact.kind);
                      setRef(choice.artifact.ref);
                      setPath(choice.artifact.path ?? "");
                    }}
                  >
                    Use artifact from {choice.title}
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs">
              No previously verified integrated artifacts are recorded. Enter the combined result
              below.
            </p>
          )}
          <div className="flex gap-2" role="group" aria-label="Integrated artifact kind">
            {(["commit", "content"] as const).map((value) => (
              <Button
                key={value}
                size="sm"
                variant={kind === value ? "secondary" : "outline"}
                aria-pressed={kind === value}
                disabled={disabled}
                onClick={() => setKind(value)}
              >
                {value === "commit" ? "Commit" : "Content SHA-256"}
              </Button>
            ))}
          </div>
          <Input
            aria-label={`Integrated ${kind === "commit" ? "commit" : "content SHA-256"} for ${milestone.title}`}
            placeholder={
              kind === "commit"
                ? "Full commit SHA (40 or 64 lowercase hex characters)"
                : "Content SHA-256 (64 lowercase hex characters)"
            }
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            maxLength={64}
            disabled={disabled}
          />
          <Input
            aria-label={`Integrated artifact path for ${milestone.title}`}
            placeholder={
              kind === "content"
                ? "Required content path in the project or verifier workspace"
                : "Optional path within the commit"
            }
            value={path}
            onChange={(e) => setPath(e.target.value)}
            maxLength={2000}
            disabled={disabled}
          />
          {(ref || path) && !artifact && (
            <p className="text-xs" role="status">
              {kind === "content"
                ? "Enter a full SHA-256 and a content path."
                : "Enter a valid full commit SHA."}
            </p>
          )}
          <Textarea
            aria-label={`Verification evidence for ${milestone.title}`}
            placeholder="What did you test after combining the accepted work?"
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
            maxLength={12000}
            disabled={disabled}
          />
        </>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={
          disabled ||
          (!milestone.accepted && requiresVerification && (!artifact || !evidence.trim()))
        }
        onClick={() =>
          void act({
            type: "milestone.accept",
            initiativeId: initiative.id,
            id: milestone.id,
            accepted: !milestone.accepted,
            ...(!milestone.accepted && requiresVerification && artifact
              ? { artifact, evidence: evidence.trim() }
              : {}),
          })
        }
      >
        {milestone.accepted ? "Reopen milestone" : "Accept verified milestone"}
      </Button>
      <p className="text-xs text-muted-foreground">{crewDeliveryNotice}</p>
    </div>
  );
}
