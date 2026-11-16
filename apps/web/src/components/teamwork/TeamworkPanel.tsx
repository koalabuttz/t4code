import { randomUUID } from "../../lib/utils";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
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
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { openTeamworkDialog, teamworkDialogThreadAtom } from "./teamworkDialogState";
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
  threadId: ThreadId;
  onOpenThread: (id: ThreadId) => void;
}
export function TeamworkButton(props: Props) {
  const openThread = useAtomValue(teamworkDialogThreadAtom);
  const open =
    openThread?.threadId === props.threadId && openThread.environmentId === props.environmentId;
  const setOpen = (value: boolean) =>
    openTeamworkDialog(value ? scopeThreadRef(props.environmentId, props.threadId) : null);
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

function TeamworkPanel({ environmentId, projectId, threadId, onOpenThread }: Props) {
  const query = useEnvironmentQuery(
    serverEnvironment.teamworkLive({ environmentId, input: { projectId } }),
  );
  const permission = useAtomValue(serverEnvironment.mutateTeamwork.permissionAtom(environmentId));
  const mutate = useAtomCommand(serverEnvironment.mutateTeamwork, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<"tasks" | "board" | "knowledge" | "roles" | "history">("tasks");
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [mode, setMode] = useState<"swarm" | "teamwork">("swarm");
  const state = query.data?.snapshot;
  const act = async (action: TeamworkAction) => {
    if (!state || busy || !permission) return false;
    setBusy(true);
    setError(null);
    try {
      const result = await mutate({
        environmentId,
        input: {
          projectId,
          commandId: CommandId.make(randomUUID()),
          expectedRevision: state.revision,
          action,
        },
      });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Could not save this Crew change.");
        return false;
      }
      return true;
    } finally {
      setBusy(false);
    }
  };
  if (!state) return <p role="status">{query.error ?? "Loading crew…"}</p>;
  const initiative = state.initiatives.find((i) => i.id === selected) ?? state.initiatives.at(-1);
  const disabled = busy || !permission;
  return (
    <div className="space-y-5">
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
        {state.coordinatorThreadId !== threadId && (
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled}
            onClick={() => void act({ type: "coordinator.set", threadId })}
          >
            Use this thread
          </Button>
        )}
      </div>
      <details open={state.initiatives.length === 0}>
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
              {initiative.milestones.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center justify-between gap-3 rounded border p-3"
                >
                  <div>
                    <p className="text-sm font-medium">{m.title}</p>
                    <p className="text-xs text-muted-foreground">{m.criteria}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={disabled}
                    onClick={() =>
                      void act({
                        type: "milestone.accept",
                        initiativeId: initiative.id,
                        id: m.id,
                        accepted: !m.accepted,
                      })
                    }
                  >
                    {m.accepted ? "Reopen milestone" : "Accept milestone"}
                  </Button>
                </div>
              ))}
            </>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-1" role="tablist" aria-label="Crew views">
        {(["tasks", "board", "knowledge", "roles", "history"] as const).map((value) => (
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
                {task.status === "review" && (
                  <ReviewForm
                    disabled={disabled}
                    onReview={(decision, evidence) =>
                      act({ type: "task.review", id: task.id, decision, evidence })
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
      {tab === "board" && (
        <Board state={state} initiativeId={initiative?.id ?? null} disabled={disabled} act={act} />
      )}
      {tab === "knowledge" && <Knowledge state={state} disabled={disabled} act={act} />}
      {tab === "roles" && (
        <Roles state={state} disabled={disabled} act={act} environmentId={environmentId} />
      )}
      {tab === "history" && (
        <History environmentId={environmentId} projectId={projectId} revision={state.revision} />
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
  disabled,
  act,
}: Pick<EditorProps, "disabled" | "act"> & {
  initiative: TeamworkSnapshot["initiatives"][number];
}) {
  const [title, setTitle] = useState(initiative.title);
  const [brief, setBrief] = useState(initiative.brief);
  const [milestone, setMilestone] = useState("");
  const [criteria, setCriteria] = useState("");
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
                milestone: { id: randomUUID(), title: milestone, criteria, accepted: false },
              })
            ) {
              setMilestone("");
              setCriteria("");
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
  const [notify, setNotify] = useState(false);
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
              recipients: notify && state.coordinatorThreadId ? [state.coordinatorThreadId] : [],
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
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
          Notify coordinator
        </label>
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
function History({
  environmentId,
  projectId,
  revision,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  revision: number;
}) {
  const [before, setBefore] = useState<number | undefined>();
  const query = useEnvironmentQuery(
    serverEnvironment.teamworkHistory({
      environmentId,
      input: { projectId, beforeRevision: before ?? revision + 1 },
    }),
  );
  return (
    <div className="space-y-2">
      {query.error && <p role="alert">{query.error}</p>}
      {query.data?.events.map((event) => (
        <details key={event.revision} className="rounded border p-3">
          <summary className="cursor-pointer text-sm">
            {event.action.type.replaceAll(".", " ")} · {new Date(event.createdAt).toLocaleString()}
          </summary>
          <p className="mt-2 whitespace-pre-wrap text-sm">
            {"text" in event.action
              ? event.action.text
              : "brief" in event.action
                ? event.action.brief
                : "evidence" in event.action
                  ? event.action.evidence
                  : "role" in event.action
                    ? `${event.action.role.name}\n${event.action.role.instructions}`
                    : "milestone" in event.action
                      ? `${event.action.milestone.title}\n${event.action.milestone.criteria}`
                      : "status" in event.action
                        ? event.action.status
                        : "Saved by " +
                          (event.actorThreadId === null ? "you" : "a team participant")}
          </p>
        </details>
      ))}
      {query.data?.events.length === 40 && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => setBefore(query.data!.events.at(-1)!.revision)}
        >
          Older history
        </Button>
      )}
      {before !== undefined && (
        <Button size="sm" variant="ghost" onClick={() => setBefore(undefined)}>
          Latest history
        </Button>
      )}
    </div>
  );
}
