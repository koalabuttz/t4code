import { useState } from "react";
import type {
  EnvironmentId,
  TeamworkAction,
  TeamworkInitiative,
  TeamworkHistoryInput,
} from "@t3tools/contracts";
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
    <div className="space-y-2">
      <Button
        size="sm"
        variant="outline"
        disabled={query.isPending}
        onClick={() => {
          setRequested(true);
          if (requested) query.refresh();
        }}
      >
        Check artifact availability
      </Button>
      {requested && (
        <p className="text-xs" role="status">
          {query.error ??
            (query.data?.artifact
              ? `${query.data.artifact.status}: ${query.data.artifact.detail}`
              : "Checking artifact…")}
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
}: Props & {
  milestone: TeamworkInitiative["milestones"][number];
  requiresVerification: boolean;
}) {
  const [ref, setRef] = useState("");
  const [evidence, setEvidence] = useState("");
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
        <p className="break-all whitespace-pre-wrap text-sm">
          Verified {milestone.verification.artifact.ref}: {milestone.verification.evidence}
        </p>
      )}
      {!milestone.accepted && requiresVerification && (
        <>
          <Input
            aria-label={`Integrated commit for ${milestone.title}`}
            placeholder="Full commit SHA of the integrated result"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            maxLength={64}
          />
          <Textarea
            aria-label={`Verification evidence for ${milestone.title}`}
            placeholder="What did you test after combining the accepted work?"
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
            maxLength={12000}
          />
        </>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={
          disabled ||
          (!milestone.accepted &&
            requiresVerification &&
            (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(ref) || !evidence.trim()))
        }
        onClick={() =>
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
      >
        {milestone.accepted ? "Reopen milestone" : "Accept verified milestone"}
      </Button>
    </div>
  );
}
