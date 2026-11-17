import { useState } from "react";
import { View } from "react-native";
import type {
  EnvironmentId,
  TeamworkAction,
  TeamworkInitiative,
  TeamworkHistoryInput,
} from "@t3tools/contracts";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { AppText, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";

type Props = {
  initiative: TeamworkInitiative;
  disabled: boolean;
  act: (action: TeamworkAction) => Promise<boolean>;
};

export function CrewArtifactStatus({
  environmentId,
  input,
}: {
  environmentId: EnvironmentId;
  input: typeof TeamworkHistoryInput.Type;
}) {
  const [requested, setRequested] = useState(false);
  const query = useEnvironmentQuery(
    requested ? serverEnvironment.teamworkHistory({ environmentId, input }) : null,
  );
  return (
    <View className="gap-2">
      <Button
        label="Check artifact availability"
        disabled={query.isPending}
        onPress={() => {
          setRequested(true);
          if (requested) query.refresh();
        }}
      />
      {requested && (
        <AppText>
          {query.error ??
            (query.data?.artifact
              ? `${query.data.artifact.status}: ${query.data.artifact.detail}`
              : "Checking artifact…")}
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
}: Props & { milestone: TeamworkInitiative["milestones"][number]; requiresVerification: boolean }) {
  const [ref, setRef] = useState("");
  const [evidence, setEvidence] = useState("");
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
        <AppText>
          Verified {milestone.verification.artifact.ref}: {milestone.verification.evidence}
        </AppText>
      )}
      {!milestone.accepted && requiresVerification && (
        <>
          <AppTextInput
            accessibilityLabel={`Integrated commit for ${milestone.title}`}
            placeholder="Full commit SHA of the integrated result"
            value={ref}
            onChangeText={setRef}
            maxLength={64}
            autoCapitalize="none"
          />
          <AppTextInput
            accessibilityLabel={`Verification evidence for ${milestone.title}`}
            placeholder="What did you test after combining the work?"
            value={evidence}
            onChangeText={setEvidence}
            multiline
            maxLength={12000}
          />
        </>
      )}
      <Button
        label={milestone.accepted ? "Reopen milestone" : "Accept verified milestone"}
        disabled={
          disabled ||
          (!milestone.accepted &&
            requiresVerification &&
            (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(ref) || !evidence.trim()))
        }
        onPress={() =>
          void act({
            type: "milestone.accept",
            initiativeId: initiative.id,
            id: milestone.id,
            accepted: !milestone.accepted,
            ...(!milestone.accepted && requiresVerification
              ? { artifact: { kind: "commit", ref }, evidence }
              : {}),
          })
        }
      />
    </View>
  );
}
