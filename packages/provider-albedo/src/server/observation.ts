import type {
  OrchestrationV2PendingBackgroundTask,
  ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";
import type { Session } from "./sessionProtocol.ts";

const jobsUnresolved = (native: Session) =>
  native.kernel.state === "lost" ||
  (native.kernel.state !== "none" && native.kernel.live_job_count === null);

export function pending(native: Session) {
  return (
    native.status.phase !== "idle" ||
    native.pending_inputs.length > 0 ||
    (native.kernel.live_job_count ?? 0) > 0 ||
    jobsUnresolved(native)
  );
}

export function statuses(native: Session, managed: boolean) {
  return [
    {
      key: "albedo.kernel",
      text: `Python: ${native.kernel.state}${native.kernel.stale ? " (restart required)" : ""}`,
    },
    {
      key: "albedo.jobs",
      text:
        native.kernel.live_job_count === null
          ? "Native background job count unavailable"
          : `Native background jobs: ${native.kernel.live_job_count}`,
    },
    ...(!managed && native.status.phase !== "idle"
      ? [{ key: "albedo.execution", text: "Albedo is running native work outside a T3 turn" }]
      : []),
    ...(native.status.blocking_reason === null
      ? []
      : [{ key: "albedo.blocked", text: native.status.blocking_reason.detail }]),
  ];
}

export function tasks(native: Session): ReadonlyArray<OrchestrationV2PendingBackgroundTask> {
  const jobs = native.kernel.running_jobs ?? [];
  return [
    ...(native.status.phase !== "idle" || native.pending_inputs.length > 0
      ? [
          {
            taskId: "albedo:native-execution",
            kind: "background_task" as const,
            description: "Native Albedo execution or queued input",
          },
        ]
      : []),
    ...jobs.map((job): OrchestrationV2PendingBackgroundTask => ({
      taskId: job.id,
      kind: job.kind === "cell" ? "background_task" : "command",
      description:
        job.command || (job.kind === "cell" ? "Native Python cell" : "Native Albedo job"),
      command: job.command,
      ...(job.parent_id === null ? {} : { parentTaskId: job.parent_id }),
    })),
    ...((native.kernel.live_job_count ?? 0) > jobs.length || jobsUnresolved(native)
      ? [
          {
            taskId: "albedo:unresolved-jobs",
            kind: "background_task" as const,
            description: "Native background work is not fully reported; check Albedo",
          },
        ]
      : []),
  ];
}

export function context(native: Session): ThreadTokenUsageSnapshot | null {
  const usage = native.usage;
  if (usage.prompt_tokens === null) return null;
  return {
    usedTokens: usage.prompt_tokens + (usage.completion_tokens ?? 0),
    lastInputTokens: usage.prompt_tokens,
    ...(usage.context_window_tokens === null || usage.context_window_tokens === 0
      ? {}
      : { maxTokens: usage.context_window_tokens }),
    ...(usage.cached_prompt_tokens === null
      ? {}
      : { lastCachedInputTokens: usage.cached_prompt_tokens }),
    ...(usage.completion_tokens === null ? {} : { lastOutputTokens: usage.completion_tokens }),
  };
}
