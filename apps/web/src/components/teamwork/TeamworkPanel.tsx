import { randomUUID } from "../../lib/utils";
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAtom, useAtomValue } from "@effect/atom-react";
import {
  crewDraftBrief,
  crewSelectedInitiative,
  crewSelectedView,
} from "@t3tools/client-runtime/state/crew";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import {
  CommandId,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  type TeamworkAction,
  type TeamworkSnapshot,
  type ModelSelection,
  type TeamworkTask,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentShellStatus } from "../../state/shell";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { openTeamworkDialog, teamworkDialogThreadAtom } from "./teamworkDialogState";
import { CrewWorkerStatus } from "./CrewWorkerStatus";
import { CrewHistory } from "./CrewHistory";
import { CrewContextView } from "./CrewContextView";
import { CrewArtifactStatus, CrewLimits, CrewMilestone } from "./CrewVerification";
import { threadFamilies } from "../../state/threads";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "../ui/dialog";

interface Props {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId | null;
  onOpenThread: (id: ThreadId) => void;
}
export function TeamworkButton(props: Props) {
  const navigate = useNavigate();
  const openThread = useAtomValue(teamworkDialogThreadAtom);
  const open =
    openThread?.threadId === props.threadId && openThread.environmentId === props.environmentId;
  const setOpen = (value: boolean) =>
    openTeamworkDialog(
      value && props.threadId ? scopeThreadRef(props.environmentId, props.threadId) : null,
    );
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  if (!config?.environment.capabilities.projectTeamwork) return null;
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Crew
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="w-[min(96vw,72rem)] max-w-6xl">
          <DialogHeader>
            <DialogTitle>Project crew</DialogTitle>
            <DialogDescription>
              Coordinate work, review results, and retain what the project learns.
            </DialogDescription>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setOpen(false);
                void navigate({
                  to: "/projects/$projectKey/crew",
                  params: { projectKey: scopedProjectKey(props) },
                });
              }}
            >
              Open workspace
            </Button>
          </DialogHeader>
          <DialogPanel>
            {open ? (
              <TeamworkPanel
                {...props}
                onOpenThread={(id) => {
                  setOpen(false);
                  props.onOpenThread(id);
                }}
              />
            ) : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}

export function TeamworkPanel({ environmentId, projectId, threadId, onOpenThread }: Props) {
  const query = useEnvironmentQuery(
    serverEnvironment.teamworkLive({ environmentId, input: { projectId } }),
  );
  const permission = useAtomValue(serverEnvironment.mutateTeamwork.permissionAtom(environmentId));
  const connected = useEnvironmentShellStatus(environmentId) === "live";
  const mutate = useAtomCommand(serverEnvironment.mutateTeamwork, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projectKey = scopedProjectKey({ environmentId, projectId });
  const [selected, setSelected] = useAtom(crewSelectedInitiative(projectKey));
  const [selectedTab, setTab] = useAtom(crewSelectedView(projectKey));
  const tab =
    selectedTab === "context" && !query.data?.capabilities?.includes("context")
      ? "tasks"
      : selectedTab;
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useAtom(crewDraftBrief(projectKey));
  const [mode, setMode] = useState<"swarm" | "teamwork">("swarm");
  const state = query.data?.snapshot;
  const coordinatorThreadId = state?.coordinatorThreadId;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Retain the coordinator's worker shells while its Crew view is open.
  useEffect(() => {
    if (coordinatorThreadId == null) return;
    return threadFamilies.mount(appAtomRegistry, environmentId, coordinatorThreadId);
  }, [environmentId, coordinatorThreadId]);
  const act = async (action: TeamworkAction) => {
    if (!state || busy || !permission || !connected) return false;
    setBusy(true);
    setError(null);
    const result = await mutate({
      environmentId,
      input: {
        projectId,
        commandId: CommandId.make(randomUUID()),
        expectedRevision: state.revision,
        action,
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not save this Crew change.");
      return false;
    }
    return true;
  };
  if (!state) return <p role="status">{query.error ?? "Loading crew…"}</p>;
  const initiative = state.initiatives.find((i) => i.id === selected) ?? state.initiatives.at(-1);
  const disabled = busy || !permission || !connected;
  return (
    <div className="space-y-5">
      {!connected && (
        <p role="status">
          Disconnected. Crew changes will be available when this environment reconnects.
        </p>
      )}
      {(error || query.error) && (
        <p role="alert" className="text-destructive">
          {error ?? query.error}
        </p>
      )}
      {!permission && (
        <p className="text-sm text-muted-foreground">You have read-only access to this crew.</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Project coordinator</span>
        {state.coordinatorThreadId ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onOpenThread(state.coordinatorThreadId!)}
          >
            Open coordinator
          </Button>
        ) : (
          <span className="text-sm text-muted-foreground">
            Choose a thread to lead this project.
          </span>
        )}
        {threadId !== null && state.coordinatorThreadId !== threadId && (
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled}
            onClick={() => void act({ type: "coordinator.set", threadId })}
          >
            Use this thread
          </Button>
        )}
        {state.coordinatorThreadId && query.data?.capabilities?.includes("context") && (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => void act({ type: "coordinator.pause" })}
          >
            Pause crew for handover
          </Button>
        )}
      </div>
      {query.data?.capabilities?.includes("context") && (
        <p className="text-xs text-muted-foreground">
          To continue with a fresh coordinator, pause the crew, choose a conversation, and use that
          thread. Assignments and reviews stay on the board. Resume initiatives explicitly.
        </p>
      )}
      <details open={state.initiatives.length === 0 || brief.trim().length > 0}>
        <summary className="cursor-pointer text-sm font-medium">Start an initiative</summary>
        <form
          className="mt-3 space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const id = randomUUID();
            if (await act({ type: "initiative.create", id, title, brief, mode })) {
              setSelected(id);
              setTitle("");
              setBrief("");
            }
          }}
        >
          <Input
            aria-label="Initiative title"
            placeholder="What outcome do you want?"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={160}
            required
          />
          <Textarea
            aria-label="Initiative brief"
            placeholder="Describe the outcome, constraints, and what success looks like."
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            maxLength={12000}
            required
          />
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-sm">
              Swarm{" "}
              <select
                aria-label="Swarm start"
                value={mode}
                onChange={(e) => setMode(e.target.value as "swarm" | "teamwork")}
                className="rounded border bg-background px-2 py-1"
              >
                <option value="swarm">Start now</option>
                <option value="teamwork">Require plan approval</option>
              </select>
            </label>
            <Button
              type="submit"
              size="sm"
              disabled={disabled || !state.coordinatorThreadId || !title.trim() || !brief.trim()}
            >
              Create initiative
            </Button>
          </div>
        </form>
      </details>
      {state.initiatives.length > 0 && (
        <div className="space-y-3">
          <label className="text-sm">
            Initiative{" "}
            <select
              aria-label="Selected initiative"
              value={initiative?.id}
              onChange={(e) => setSelected(e.target.value)}
              className="max-w-full rounded border bg-background px-2 py-1"
            >
              {state.initiatives.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.title} · {i.status}
                </option>
              ))}
            </select>
          </label>
          {initiative && (
            <>
              <p className="whitespace-pre-wrap text-sm">{initiative.brief}</p>
              <InitiativeEditor
                key={`${initiative.id}:${initiative.updatedAt}`}
                initiative={initiative}
                supportsDependencies={query.data?.capabilities?.includes("submissions") ?? false}
                disabled={disabled}
                act={act}
              />
              <div className="flex flex-wrap gap-2">
                {initiative.status === "draft" && (
                  <Button
                    size="sm"
                    disabled={disabled}
                    onClick={() => void act({ type: "initiative.approve", id: initiative.id })}
                  >
                    Approve brief and start
                  </Button>
                )}
                {initiative.status === "active" && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={disabled}
                      onClick={() =>
                        void act({ type: "initiative.status", id: initiative.id, status: "paused" })
                      }
                    >
                      Pause workers
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={disabled}
                      onClick={() =>
                        void act({
                          type: "initiative.status",
                          id: initiative.id,
                          status: "completed",
                        })
                      }
                    >
                      Complete initiative
                    </Button>
                  </>
                )}
                {["paused", "completed", "cancelled"].includes(initiative.status) && (
                  <Button
                    size="sm"
                    disabled={disabled || !initiative.approved}
                    onClick={() =>
                      void act({ type: "initiative.status", id: initiative.id, status: "active" })
                    }
                  >
                    {initiative.status === "paused" ? "Resume" : "Reopen"}
                  </Button>
                )}
                {query.data?.capabilities?.includes("archive") &&
                  ["completed", "cancelled"].includes(initiative.status) && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={disabled}
                      onClick={() => void act({ type: "initiative.archive", id: initiative.id })}
                    >
                      Archive initiative
                    </Button>
                  )}
                {!["completed", "cancelled"].includes(initiative.status) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() =>
                      void act({
                        type: "initiative.status",
                        id: initiative.id,
                        status: "cancelled",
                      })
                    }
                  >
                    Cancel initiative
                  </Button>
                )}
                {initiative.mode === "swarm" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() =>
                      void act({
                        type: "initiative.edit",
                        id: initiative.id,
                        title: initiative.title,
                        brief: initiative.brief,
                        mode: "teamwork",
                      })
                    }
                  >
                    Require plan approval
                  </Button>
                )}
              </div>
              {query.data?.capabilities?.includes("submissions") && (
                <CrewLimits
                  key={`${initiative.id}:${JSON.stringify(initiative.policy)}`}
                  initiative={initiative}
                  disabled={disabled}
                  act={act}
                />
              )}
              {initiative.milestones.map((m) => (
                <CrewMilestone
                  key={`${initiative.id}:${m.id}:${m.accepted}`}
                  initiative={initiative}
                  milestone={m}
                  disabled={disabled}
                  requiresVerification={query.data?.capabilities?.includes("submissions") ?? false}
                  act={act}
                />
              ))}
            </>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-1" role="tablist" aria-label="Crew views">
        {(["tasks", "conversations", "board", "knowledge", "context", "roles", "history"] as const)
          .filter((value) => value !== "context" || query.data?.capabilities?.includes("context"))
          .map((value) => (
            <Button
              key={value}
              size="sm"
              variant={tab === value ? "secondary" : "ghost"}
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
            >
              {value[0]!.toUpperCase() + value.slice(1)}
            </Button>
          ))}
      </div>
      {tab === "context" && query.data?.capabilities?.includes("context") && (
        <CrewContextView
          environmentId={environmentId}
          state={state}
          preview={query.data.context ?? null}
          onOpenThread={onOpenThread}
        />
      )}
      {tab === "tasks" && (
        <div className="grid gap-3 md:grid-cols-2">
          {state.tasks
            .filter((t) => t.initiativeId === initiative?.id)
            .map((task) => (
              <div key={task.id} className="space-y-2 rounded-lg border p-4">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-medium">{task.title}</h3>
                  <span className="text-xs text-muted-foreground">{task.status}</span>
                </div>
                <p className="whitespace-pre-wrap text-sm">{task.brief}</p>
                <p className="text-sm text-muted-foreground">Accept when: {task.criteria}</p>
                <CrewWorkerStatus environmentId={environmentId} task={task} />
                {task.dependencies.length > 0 && (
                  <p className="text-xs">
                    Depends on:{" "}
                    {task.dependencies
                      .map((id) => state.tasks.find((t) => t.id === id)?.title ?? id)
                      .join(", ")}
                  </p>
                )}
                {task.ownerThreadId && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onOpenThread(task.ownerThreadId!)}
                  >
                    Open worker
                  </Button>
                )}
                {task.evidence && (
                  <details open={task.status === "review"}>
                    <summary className="cursor-pointer text-sm">Result evidence</summary>
                    <p className="mt-2 whitespace-pre-wrap text-sm">{task.evidence}</p>
                  </details>
                )}
                {task.review && (
                  <p className="text-sm">
                    Review: {task.review.decision}. {task.review.evidence}
                  </p>
                )}
                {task.submission && (
                  <p className="break-all text-xs text-muted-foreground">
                    Submission {task.submission.revision} · {task.submission.artifact.kind}{" "}
                    {task.submission.artifact.ref}
                    {task.submission.artifact.path ? ` · ${task.submission.artifact.path}` : ""}
                  </p>
                )}
                {task.submission && query.data?.capabilities?.includes("artifacts") && (
                  <CrewArtifactStatus
                    key={task.submission.revision}
                    environmentId={environmentId}
                    input={{ projectId, artifactTaskId: task.id }}
                  />
                )}
                {task.status === "review" &&
                  query.data?.capabilities?.includes("submissions") &&
                  !task.submission && (
                    <p className="text-sm">
                      Ask the worker to resubmit an immutable artifact before reviewing this older
                      result.
                    </p>
                  )}
                {task.status === "review" && (
                  <ReviewForm
                    disabled={
                      disabled ||
                      (query.data?.capabilities?.includes("submissions") === true &&
                        !task.submission)
                    }
                    onReview={(decision, evidence) =>
                      act({
                        type: "task.review",
                        id: task.id,
                        decision,
                        evidence,
                        ...(task.submission
                          ? { submissionRevision: task.submission.revision }
                          : {}),
                      })
                    }
                  />
                )}
                <div className="flex gap-2">
                  {task.status !== "ready" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={disabled}
                      onClick={() => void act({ type: "task.reset", id: task.id, status: "ready" })}
                    >
                      Reset assignment
                    </Button>
                  )}
                  {task.status !== "cancelled" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={disabled}
                      onClick={() =>
                        void act({ type: "task.reset", id: task.id, status: "cancelled" })
                      }
                    >
                      Cancel task
                    </Button>
                  )}
                </div>
                {!["delegating", "running"].includes(task.status) && (
                  <TaskForm
                    key={`${task.id}:${task.updatedAt}`}
                    state={state}
                    initiativeId={task.initiativeId}
                    disabled={disabled}
                    act={act}
                    existing={task}
                  />
                )}
              </div>
            ))}
          {initiative && (
            <TaskForm
              key={initiative.id}
              state={state}
              initiativeId={initiative.id}
              disabled={disabled}
              act={act}
            />
          )}
        </div>
      )}
      {tab === "conversations" && (
        <div className="space-y-3">
          {state.coordinatorThreadId && (
            <Button variant="outline" onClick={() => onOpenThread(state.coordinatorThreadId!)}>
              Coordinator conversation
            </Button>
          )}
          {state.tasks
            .filter((task) => task.initiativeId === initiative?.id && task.ownerThreadId !== null)
            .map((task) => (
              <div key={task.id} className="space-y-2 rounded border p-3">
                <p className="font-medium">
                  {state.roles.find((role) => role.id === task.roleId)?.name ?? "Worker"} ·{" "}
                  {task.title}
                </p>
                <CrewWorkerStatus environmentId={environmentId} task={task} />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onOpenThread(task.ownerThreadId!)}
                >
                  Open conversation
                </Button>
              </div>
            ))}
        </div>
      )}
      {tab === "board" && (
        <Board state={state} initiativeId={initiative?.id ?? null} disabled={disabled} act={act} />
      )}
      {tab === "knowledge" && <Knowledge state={state} disabled={disabled} act={act} />}
      {tab === "roles" && (
        <Roles state={state} disabled={disabled} act={act} environmentId={environmentId} />
      )}
      {tab === "history" && (
        <CrewHistory
          environmentId={environmentId}
          projectId={projectId}
          revision={state.revision}
          archiveEnabled={query.data?.capabilities?.includes("archive") ?? false}
          artifactsEnabled={query.data?.capabilities?.includes("artifacts") ?? false}
          disabled={disabled}
          act={act}
          onOpenThread={onOpenThread}
        />
      )}
      {query.data?.deliveries.some((d) => d.status === "failed") && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Delivery needs attention</p>
          {query.data.deliveries
            .filter((d) => d.status === "failed")
            .map((d) => (
              <div key={d.id} className="flex items-center gap-2">
                <span className="text-sm">
                  {d.kind === "stop" ? "Worker stop" : "Team message"} could not be delivered.
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => void act({ type: "delivery.retry", id: d.id })}
                >
                  Retry
                </Button>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

type EditorProps = {
  state: TeamworkSnapshot;
  disabled: boolean;
  act: (action: TeamworkAction) => Promise<boolean>;
};
function ReviewForm({
  disabled,
  onReview,
}: {
  disabled: boolean;
  onReview: (decision: "approve" | "changes", evidence: string) => Promise<boolean>;
}) {
  const [evidence, setEvidence] = useState("");
  return (
    <div className="space-y-2">
      <Textarea
        aria-label="Review evidence"
        placeholder="What did you independently verify?"
        value={evidence}
        onChange={(e) => setEvidence(e.target.value)}
        maxLength={12000}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={disabled || !evidence.trim()}
          onClick={() => void onReview("approve", evidence)}
        >
          Approve result
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || !evidence.trim()}
          onClick={() => void onReview("changes", evidence)}
        >
          Request changes
        </Button>
      </div>
    </div>
  );
}
function InitiativeEditor({
  initiative,
  supportsDependencies,
  disabled,
  act,
}: Pick<EditorProps, "disabled" | "act"> & {
  initiative: TeamworkSnapshot["initiatives"][number];
  supportsDependencies: boolean;
}) {
  const [title, setTitle] = useState(initiative.title);
  const [brief, setBrief] = useState(initiative.brief);
  const [milestone, setMilestone] = useState("");
  const [criteria, setCriteria] = useState("");
  const [dependencies, setDependencies] = useState<readonly string[]>([]);
  return (
    <details>
      <summary className="cursor-pointer text-sm">Edit brief and milestones</summary>
      <div className="mt-3 space-y-3">
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act({
              type: "initiative.edit",
              id: initiative.id,
              title,
              brief,
              mode: initiative.mode,
            });
          }}
        >
          <Input
            aria-label="Edit initiative title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={160}
            required
          />
          <Textarea
            aria-label="Edit initiative brief"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            maxLength={12000}
            required
          />
          <p className="text-xs text-muted-foreground">
            Changing the brief stops workers and requires a fresh approval or resume.
          </p>
          <Button size="sm" type="submit" disabled={disabled}>
            Save brief
          </Button>
        </form>
        <form
          className="space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (
              await act({
                type: "milestone.save",
                initiativeId: initiative.id,
                milestone: {
                  id: randomUUID(),
                  title: milestone,
                  criteria,
                  accepted: false,
                  ...(supportsDependencies ? { dependencies } : {}),
                },
              })
            ) {
              setMilestone("");
              setCriteria("");
              setDependencies([]);
            }
          }}
        >
          <Input
            aria-label="Milestone title"
            placeholder="Milestone"
            value={milestone}
            onChange={(e) => setMilestone(e.target.value)}
            maxLength={160}
            required
          />
          <Textarea
            aria-label="Milestone criteria"
            placeholder="Acceptance criteria"
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
            maxLength={12000}
            required
          />
          {supportsDependencies && initiative.milestones.length > 0 && (
            <fieldset className="space-y-1">
              <legend className="text-sm">Wait for verified milestones</legend>
              {initiative.milestones.map((m) => (
                <label key={m.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={dependencies.includes(m.id)}
                    onChange={(e) =>
                      setDependencies(
                        e.target.checked
                          ? [...dependencies, m.id]
                          : dependencies.filter((id) => id !== m.id),
                      )
                    }
                  />
                  {m.title}
                </label>
              ))}
            </fieldset>
          )}
          <Button size="sm" type="submit" disabled={disabled}>
            Add milestone
          </Button>
        </form>
      </div>
    </details>
  );
}
function TaskForm({
  state,
  initiativeId,
  disabled,
  act,
  existing,
}: EditorProps & { initiativeId: string; existing?: TeamworkTask }) {
  const [title, setTitle] = useState(existing?.title ?? "");
  const [brief, setBrief] = useState(existing?.brief ?? "");
  const [criteria, setCriteria] = useState(existing?.criteria ?? "");
  const [roleId, setRoleId] = useState(existing?.roleId ?? "");
  const [milestoneId, setMilestoneId] = useState(existing?.milestoneId ?? "");
  const [dependencies, setDependencies] = useState<readonly string[]>(existing?.dependencies ?? []);
  const [knowledgeIds, setKnowledgeIds] = useState<readonly string[]>(existing?.knowledgeIds ?? []);
  return (
    <details className="rounded-lg border p-4">
      <summary className="cursor-pointer text-sm font-medium">
        {existing ? "Edit task" : "Add a task"}
      </summary>
      <form
        className="mt-3 space-y-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (
            await act({
              type: existing ? "task.edit" : "task.create",
              id: existing?.id ?? randomUUID(),
              initiativeId,
              title,
              brief,
              criteria,
              roleId: roleId || null,
              milestoneId: milestoneId || null,
              dependencies,
              knowledgeIds,
            })
          ) {
            if (!existing) {
              setTitle("");
              setBrief("");
              setCriteria("");
              setDependencies([]);
              setKnowledgeIds([]);
            }
          }
        }}
      >
        <Input
          aria-label="Task title"
          placeholder="Task title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={160}
          required
        />
        <Textarea
          aria-label="Task brief"
          placeholder="Bounded assignment"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          maxLength={12000}
          required
        />
        <Textarea
          aria-label="Acceptance criteria"
          placeholder="Evidence required for acceptance"
          value={criteria}
          onChange={(e) => setCriteria(e.target.value)}
          maxLength={12000}
          required
        />
        <select
          aria-label="Worker role"
          className="rounded border bg-background p-2 text-sm"
          value={roleId}
          onChange={(e) => setRoleId(e.target.value)}
        >
          <option value="">Inherit coordinator model</option>
          {state.roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Task milestone"
          className="rounded border bg-background p-2 text-sm"
          value={milestoneId}
          onChange={(e) => setMilestoneId(e.target.value)}
        >
          <option value="">No milestone</option>
          {state.initiatives
            .find((i) => i.id === initiativeId)
            ?.milestones.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
        </select>
        <fieldset className="space-y-1 text-sm">
          <legend>Wait for tasks</legend>
          {state.tasks
            .filter((t) => t.initiativeId === initiativeId && t.id !== existing?.id)
            .map((t) => (
              <label key={t.id} className="flex gap-2">
                <input
                  type="checkbox"
                  checked={dependencies.includes(t.id)}
                  onChange={(e) =>
                    setDependencies(
                      e.target.checked
                        ? [...dependencies, t.id]
                        : dependencies.filter((id) => id !== t.id),
                    )
                  }
                />
                {t.title}
              </label>
            ))}
        </fieldset>
        <fieldset className="space-y-1 text-sm">
          <legend>Knowledge to include</legend>
          {state.knowledge.map((k) => (
            <label key={k.id} className="flex gap-2">
              <input
                type="checkbox"
                checked={knowledgeIds.includes(k.id)}
                onChange={(e) =>
                  setKnowledgeIds(
                    e.target.checked
                      ? [...knowledgeIds, k.id]
                      : knowledgeIds.filter((id) => id !== k.id),
                  )
                }
              />
              {k.title}
            </label>
          ))}
        </fieldset>
        <div>
          <Button type="submit" size="sm" disabled={disabled}>
            {existing ? "Save task" : "Add task"}
          </Button>
        </div>
      </form>
    </details>
  );
}
function Board({
  state,
  initiativeId,
  disabled,
  act,
}: EditorProps & { initiativeId: string | null }) {
  const [text, setText] = useState("");
  const [recipients, setRecipients] = useState<readonly ThreadId[]>([]);
  const members = [
    ...(state.coordinatorThreadId ? [{ id: state.coordinatorThreadId, label: "Coordinator" }] : []),
    ...state.tasks
      .filter(
        (task) =>
          task.initiativeId === initiativeId &&
          task.ownerThreadId !== null &&
          !["done", "cancelled"].includes(task.status),
      )
      .map((task) => ({
        id: task.ownerThreadId!,
        label: `${state.roles.find((role) => role.id === task.roleId)?.name ?? "Worker"}: ${task.title}`,
      })),
  ];
  const active = state.initiatives.find((i) => i.id === initiativeId)?.status === "active";
  const activeRecipients = active
    ? recipients.filter((id) => members.some((member) => member.id === id))
    : [];
  return (
    <div className="space-y-3">
      {state.board
        .filter((b) => b.initiativeId === initiativeId)
        .map((b) => (
          <div key={b.id} className="rounded border p-3">
            <p className="text-xs text-muted-foreground">
              {b.authorThreadId === null
                ? "You"
                : b.authorThreadId === state.coordinatorThreadId
                  ? "Coordinator"
                  : (state.tasks.find((t) => t.ownerThreadId === b.authorThreadId)?.title ??
                    "Worker")}{" "}
              · {new Date(b.createdAt).toLocaleString()}
            </p>
            <p className="whitespace-pre-wrap text-sm">{b.text}</p>
          </div>
        ))}
      <form
        className="space-y-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (
            await act({
              type: "board.post",
              initiativeId,
              text,
              recipients: activeRecipients,
            })
          )
            setText("");
        }}
      >
        <Textarea
          aria-label="Team board message"
          placeholder="Share a decision, question, or update"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={12000}
          required
        />
        <fieldset className="space-y-2">
          <legend className="text-sm">Notify teammates (leave empty for a quiet update)</legend>
          {members.map((member) => (
            <label key={member.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={activeRecipients.includes(member.id)}
                disabled={
                  disabled ||
                  !active ||
                  (!activeRecipients.includes(member.id) && activeRecipients.length >= 8)
                }
                onChange={(event) =>
                  setRecipients(
                    event.target.checked
                      ? [...activeRecipients, member.id]
                      : activeRecipients.filter((id) => id !== member.id),
                  )
                }
              />
              {member.label}
            </label>
          ))}
        </fieldset>
        <Button type="submit" size="sm" disabled={disabled || !text.trim()}>
          Post update
        </Button>
      </form>
    </div>
  );
}
function Knowledge({ state, disabled, act }: EditorProps) {
  const [id, setId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  return (
    <div className="space-y-3">
      {state.knowledge.map((k) => (
        <div key={k.id} className="space-y-2 rounded border p-3">
          <p className="font-medium">{k.title}</p>
          <p className="whitespace-pre-wrap text-sm">{k.text}</p>
          <p className="text-xs text-muted-foreground">
            Source: {k.sourceThreadId ? "Agent contribution" : "You"} ·{" "}
            {new Date(k.updatedAt).toLocaleString()}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => {
                setId(k.id);
                setTitle(k.title);
                setText(k.text);
              }}
            >
              Correct
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => void act({ type: "knowledge.forget", id: k.id })}
            >
              Forget
            </Button>
          </div>
        </div>
      ))}
      <form
        className="space-y-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (
            await act({
              type: "knowledge.save",
              id: id ?? randomUUID(),
              title,
              text,
              sourceTaskId: null,
            })
          ) {
            setId(null);
            setTitle("");
            setText("");
          }
        }}
      >
        <Input
          aria-label="Knowledge title"
          placeholder="Knowledge title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          maxLength={160}
        />
        <Textarea
          aria-label="Project knowledge"
          placeholder="A useful fact, decision, or constraint to retain"
          value={text}
          onChange={(e) => setText(e.target.value)}
          required
          maxLength={12000}
        />
        <Button type="submit" size="sm" disabled={disabled}>
          {id ? "Save correction" : "Remember"}
        </Button>
      </form>
    </div>
  );
}
function Roles({
  state,
  disabled,
  act,
  environmentId,
}: EditorProps & { environmentId: EnvironmentId }) {
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [modelSelection, setModelSelection] = useState<ModelSelection | null>(null);
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? [];
  const choices = providers.flatMap((provider) =>
    provider.models.map((model) => ({
      key: `${provider.instanceId}/${model.slug}`,
      label: `${provider.displayName ?? provider.instanceId} · ${model.name ?? model.slug}`,
      selection: { instanceId: provider.instanceId, model: model.slug },
    })),
  );
  return (
    <div className="space-y-3">
      {state.roles.map((r) => (
        <div key={r.id} className="space-y-2 rounded border p-3">
          <p className="font-medium">{r.name}</p>
          <p className="whitespace-pre-wrap text-sm">{r.instructions}</p>
          <p className="text-xs text-muted-foreground">
            {r.modelSelection?.model ?? "Inherits coordinator model"}
          </p>
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => {
              setEditingId(r.id);
              setName(r.name);
              setInstructions(r.instructions);
              setModelSelection(r.modelSelection);
            }}
          >
            Edit role
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => void act({ type: "role.remove", id: r.id })}
          >
            Remove role
          </Button>
        </div>
      ))}
      <form
        className="space-y-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (
            await act({
              type: "role.save",
              role: { id: editingId ?? randomUUID(), name, instructions, modelSelection },
            })
          ) {
            setName("");
            setInstructions("");
            setEditingId(null);
            setModelSelection(null);
          }
        }}
      >
        <Input
          aria-label="Role name"
          placeholder="Reviewer, builder, researcher…"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={160}
          required
        />
        <Textarea
          aria-label="Role instructions"
          placeholder="Responsibilities and working instructions"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          maxLength={12000}
          required
        />
        <label className="block text-sm">
          Worker model
          <select
            aria-label="Role model"
            className="mt-1 w-full rounded border bg-background p-2"
            value={modelSelection ? `${modelSelection.instanceId}/${modelSelection.model}` : ""}
            onChange={(e) =>
              setModelSelection(
                choices.find((choice) => choice.key === e.target.value)?.selection ?? null,
              )
            }
          >
            <option value="">Inherit coordinator model</option>
            {modelSelection &&
              !choices.some(
                (choice) => choice.key === `${modelSelection.instanceId}/${modelSelection.model}`,
              ) && (
                <option value={`${modelSelection.instanceId}/${modelSelection.model}`}>
                  {modelSelection.model} (saved selection)
                </option>
              )}
            {choices.map((choice) => (
              <option key={choice.key} value={choice.key}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" size="sm" disabled={disabled}>
          Save role
        </Button>
      </form>
    </div>
  );
}
