import { useState } from "react";
import { useAtomRefresh } from "@effect/atom-react";
import { View } from "react-native";
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
import { AppText, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";

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
    <View className="gap-2">
      <AppText selectable>
        {artifact.kind === "commit" ? "Commit" : "Content SHA-256"}: {artifact.ref}
      </AppText>
      <AppText selectable>
        Location: {artifact.path ?? "Repository commit (no file path recorded)"}
      </AppText>
      {artifact.kind === "content" ? (
        <>
          {onOpenContent && (
            <Button label="Open content path" onPress={() => onOpenContent(artifact.path)} />
          )}
          <AppText>
            {onOpenContent
              ? "The file viewer opens the current file; check that it still matches the recorded SHA-256."
              : "Content preview is unavailable here. Inspect the recorded path in the project or worker workspace and verify its SHA-256."}
          </AppText>
        </>
      ) : (
        <>
          <AppText>
            Exact commit changes are unavailable in this view. Inspect them in the project or worker
            repository:
          </AppText>
          <AppText selectable>git show {artifact.ref}</AppText>
        </>
      )}
    </View>
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
    <View className="gap-3">
      <AppText className="font-t3-semibold">{crewReviewLabel(task)}</AppText>
      {task.submission && (
        <>
          <CrewArtifactDetails artifact={task.submission.artifact} onOpenContent={onOpenContent} />
          <AppText>
            Attempt: {task.submission.attemptId} · Submitted: {task.submission.createdAt}
          </AppText>
          <AppText selectable>Submission evidence: {task.submission.evidence}</AppText>
          {artifactsEnabled ? (
            <CrewArtifactStatus
              key={task.submission.revision}
              environmentId={environmentId}
              input={{ projectId, artifactTaskId: task.id }}
            />
          ) : (
            <AppText>Artifact availability checks are unavailable on this environment.</AppText>
          )}
        </>
      )}
      {task.review && (
        <AppText selectable>
          Recorded review (
          {task.review.submissionRevision === undefined
            ? "revision unspecified"
            : `submission ${task.review.submissionRevision}`}
          ): {task.review.decision === "approve" ? "approved" : "changes requested"}.{" "}
          {task.review.evidence}
        </AppText>
      )}
      {task.status === "done" && <AppText>{crewDeliveryNotice}</AppText>}
    </View>
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
    <View className="gap-2">
      <Button
        label="Check latest artifact availability"
        disabled={query.isPending}
        onPress={() => {
          setRequested(true);
          refresh();
        }}
      />
      {requested && (
        <AppText>
          {query.isPending
            ? "Checking artifact…"
            : (query.error ??
              (query.data?.artifact
                ? `Latest saved artifact: ${query.data.artifact.status}. ${query.data.artifact.detail}`
                : "Checking artifact…"))}
        </AppText>
      )}
    </View>
  );
}

export function CrewLimits({ initiative, disabled, act }: Props) {
  const [policy, setPolicy] = useState(
    initiative.policy ?? { maxConcurrent: 4, maxAttempts: 3, maxSubmissions: 4 },
  );
  return (
    <View className="gap-2">
      <AppText className="font-t3-semibold">Execution limits</AppText>
      {(
        [
          ["maxConcurrent", "Concurrent assignments"],
          ["maxAttempts", "Attempts per task"],
          ["maxSubmissions", "Submissions per task"],
        ] as const
      ).map(([field, label]) => (
        <View key={field}>
          <AppText>{label}</AppText>
          <AppTextInput
            accessibilityLabel={label}
            keyboardType="number-pad"
            value={String(policy[field])}
            onChangeText={(value) => setPolicy({ ...policy, [field]: Number(value) })}
          />
        </View>
      ))}
      <Button
        label="Save limits"
        disabled={
          disabled ||
          Object.values(policy).some((n) => !Number.isInteger(n) || n < 1 || n > 20) ||
          policy.maxConcurrent > 16
        }
        onPress={() => void act({ type: "initiative.policy", id: initiative.id, policy })}
      />
    </View>
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
    <View className="gap-2 rounded-2xl bg-secondary p-4">
      <AppText className="font-t3-semibold">{milestone.title}</AppText>
      <AppText>{milestone.criteria}</AppText>
      {!!milestone.dependencies?.length && (
        <AppText>
          Starts after verified milestones:{" "}
          {milestone.dependencies
            .map((id) => initiative.milestones.find((m) => m.id === id)?.title ?? id)
            .join(", ")}
        </AppText>
      )}
      {milestone.verification && (
        <View className="gap-2">
          <AppText className="font-t3-semibold">
            {milestone.accepted
              ? "Accepted integrated result"
              : "Previously verified integrated result (milestone reopened)"}
          </AppText>
          <CrewArtifactDetails
            artifact={milestone.verification.artifact}
            onOpenContent={onOpenContent}
          />
          <AppText>Verified: {milestone.verification.createdAt}</AppText>
          <AppText selectable>Verification evidence: {milestone.verification.evidence}</AppText>
          <AppText>Included accepted submissions:</AppText>
          {milestone.verification.submissions.length ? (
            milestone.verification.submissions.map((included) => (
              <AppText key={included.taskId}>
                {crewIncludedSubmissionLabel(included, tasks)}
              </AppText>
            ))
          ) : (
            <AppText>No task submissions were recorded in this verification.</AppText>
          )}
          {artifactsEnabled && environmentId && projectId && (
            <CrewArtifactStatus
              key={`${milestone.verification.createdAt}:${milestone.verification.artifact.ref}`}
              environmentId={environmentId}
              input={{ projectId, initiativeId: initiative.id, artifactMilestoneId: milestone.id }}
            />
          )}
        </View>
      )}
      {!milestone.accepted && requiresVerification && (
        <>
          <AppText>
            Provide the combined result explicitly. Worker submissions are not automatically
            integrated artifacts. New verification evidence is required even when reusing an
            artifact.
          </AppText>
          {choices.length > 0 ? (
            <View className="gap-2">
              <AppText>Previously verified integrated artifacts</AppText>
              {choices.map((choice) => (
                <View key={choice.milestoneId} className="gap-2">
                  <AppText selectable>
                    {choice.title}: {choice.artifact.kind} {choice.artifact.ref}
                    {choice.artifact.path ? ` · ${choice.artifact.path}` : ""}
                  </AppText>
                  <Button
                    label={`Use artifact from ${choice.title}`}
                    disabled={disabled}
                    onPress={() => {
                      setKind(choice.artifact.kind);
                      setRef(choice.artifact.ref);
                      setPath(choice.artifact.path ?? "");
                    }}
                  />
                </View>
              ))}
            </View>
          ) : (
            <AppText>
              No previously verified integrated artifacts are recorded. Enter the combined result
              below.
            </AppText>
          )}
          <View className="flex-row gap-2">
            {(["commit", "content"] as const).map((value) => (
              <Button
                key={value}
                label={value === "commit" ? "Commit" : "Content SHA-256"}
                tone={kind === value ? "primary" : "secondary"}
                accessibilityLabel={`${value === "commit" ? "Commit" : "Content SHA-256"}${kind === value ? ", selected" : ""}`}
                disabled={disabled}
                onPress={() => setKind(value)}
              />
            ))}
          </View>
          <AppTextInput
            accessibilityLabel={`Integrated ${kind === "commit" ? "commit" : "content SHA-256"} for ${milestone.title}`}
            placeholder={
              kind === "commit"
                ? "Full commit SHA (40 or 64 lowercase hex characters)"
                : "Content SHA-256 (64 lowercase hex characters)"
            }
            value={ref}
            onChangeText={setRef}
            maxLength={64}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!disabled}
          />
          <AppTextInput
            accessibilityLabel={`Integrated artifact path for ${milestone.title}`}
            placeholder={
              kind === "content"
                ? "Required content path in the project or verifier workspace"
                : "Optional path within the commit"
            }
            value={path}
            onChangeText={setPath}
            maxLength={2000}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!disabled}
          />
          {(ref || path) && !artifact && (
            <AppText accessibilityRole="alert">
              {kind === "content"
                ? "Enter a full SHA-256 and a content path."
                : "Enter a valid full commit SHA."}
            </AppText>
          )}
          <AppTextInput
            accessibilityLabel={`Verification evidence for ${milestone.title}`}
            placeholder="What did you test after combining the work?"
            value={evidence}
            onChangeText={setEvidence}
            multiline
            maxLength={12000}
            editable={!disabled}
          />
        </>
      )}
      <Button
        label={milestone.accepted ? "Reopen milestone" : "Accept verified milestone"}
        disabled={
          disabled ||
          (!milestone.accepted && requiresVerification && (!artifact || !evidence.trim()))
        }
        onPress={() =>
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
      />
      <AppText>{crewDeliveryNotice}</AppText>
    </View>
  );
}
