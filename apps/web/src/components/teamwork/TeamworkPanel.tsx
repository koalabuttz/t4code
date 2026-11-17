import { randomUUID } from "../../lib/utils";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAtom, useAtomValue } from "@effect/atom-react";
import {
  crewDraftBrief,
  crewDraftTitle,
  crewDraftMode,
  crewOriginThread,
  crewCandidateThread,
  crewSelectedTask,
  crewFilters,
  crewReturnContext,
  crewScrollOffset,
  resolveCrewCoordinator,
  isCrewCoordinatorCandidate,
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
import { CrewTaskArtifact, CrewLimits, CrewMilestone } from "./CrewVerification";
import { CrewOverview } from "./CrewOverview";
import { CrewCommunication } from "./CrewCommunication";
import { classifyCrewSupervision, type CrewSupervisionItem } from "@t3tools/shared/crewSupervision";
import { crewPrerequisiteLabel, crewSupervisionFacts } from "./crewPanel.logic";
import { useProject, useQuietThreadShells } from "../../state/entities";
import { crewSupervisionShells } from "./crewPanelState";
import { useEnvironmentScope } from "../../state/session";
import { useDiffPanelStore } from "../../diffPanelStore";
import { useRightPanelStore } from "../../rightPanelStore";
import { observeResize } from "../../lib/observeResize";
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
  const returnContext = useAtomValue(crewReturnContext(scopedProjectKey(props)));
  if (!config?.environment.capabilities.projectTeamwork) return null;
  return (
    <>
      {returnContext?.threadId === props.threadId && (
        <Button
          size="sm"
          variant="outline"
          title={
            returnContext.kind === "conversation"
              ? "Return to the saved Crew work, filters and position"
              : `Crew ${returnContext.kind}${returnContext.requestId ? ` ${returnContext.requestId}` : ""}; respond in this conversation, then return to Crew`
          }
          onClick={() =>
            void navigate({
              to: "/projects/$projectKey/crew",
              params: { projectKey: scopedProjectKey(props) },
            })
          }
        >
          Return to crew
        </Button>
      )}
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
          <DialogPanel
            ref={(element) => {
              const viewport = element?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
              if (!element || !viewport) return;
              const key = scopedProjectKey(props);
              const restore = () => {
                viewport.scrollTop = appAtomRegistry.get(crewScrollOffset(key));
              };
              const save = () => {
                const saved = appAtomRegistry.get(crewScrollOffset(key));
                if (
                  saved > viewport.scrollHeight - viewport.clientHeight &&
                  viewport.scrollTop === viewport.scrollHeight - viewport.clientHeight
                )
                  return;
                appAtomRegistry.set(crewScrollOffset(key), viewport.scrollTop);
              };
              restore();
              const stop = observeResize(element, restore);
              viewport.addEventListener("scroll", save);
              return () => {
                stop();
                viewport.removeEventListener("scroll", save);
              };
            }}
          >
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
    selectedTab === "overview" ||
    (selectedTab === "context" && !query.data?.capabilities?.includes("context"))
      ? "tasks"
      : selectedTab;
  const [title, setTitle] = useAtom(crewDraftTitle(projectKey));
  const [brief, setBrief] = useAtom(crewDraftBrief(projectKey));
  const [mode, setMode] = useAtom(crewDraftMode(projectKey));
  const [selectedTask, setSelectedTask] = useAtom(crewSelectedTask(projectKey));
  const [filters, setFilters] = useAtom(crewFilters(projectKey));
  const originThreadId = useAtomValue(crewOriginThread(projectKey));
  const [candidateThreadId, setCandidateThreadId] = useAtom(crewCandidateThread(projectKey));
  const threads = useQuietThreadShells().filter(
    (thread) => thread.environmentId === environmentId && thread.projectId === projectId,
  );
  const project = useProject({ environmentId, projectId });
  const canRead = useEnvironmentScope(environmentId, "filesystem:read");
  const shells = useAtomValue(crewSupervisionShells(projectKey));
  const setupRef = useRef<HTMLDetailsElement>(null);
  const recoveryRef = useRef<HTMLDetailsElement>(null);
  const revealTaskRef = useRef<string | null>(null);
  const state = query.data?.snapshot;
  const familyIds = JSON.stringify(
    [
      ...new Set(
        [
          state?.coordinatorThreadId,
          ...(state?.tasks.map((task) => task.ownerThreadId) ?? []),
          ...(state?.tasks.map((task) => task.submission?.threadId) ?? []),
          ...(state?.initiatives.flatMap((entry) =>
            entry.milestones.map((milestone) => milestone.verification?.threadId),
          ) ?? []),
          ...(query.data?.deliveries.map((delivery) => delivery.threadId) ?? []),
        ].filter((id): id is ThreadId => id != null),
      ),
    ].sort(),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribe to existing worker families so supervision receives live shells even when their cards are hidden.
  useEffect(() => {
    const ids = JSON.parse(familyIds) as ThreadId[];
    const release = ids.map((id) => threadFamilies.mount(appAtomRegistry, environmentId, id));
    return () => release.forEach((stop) => stop());
  }, [environmentId, familyIds]);
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
  const selection = resolveCrewCoordinator({
    project: { environmentId, projectId },
    threads,
    coordinatorThreadId: state.coordinatorThreadId,
    originThreadId: originThreadId ?? threadId,
    candidateThreadId,
  });
  const coordinator = threads.find((thread) => thread.id === selection.threadId);
  const handoverThreadId = candidateThreadId ?? threadId;
  const chosenCandidate = state.coordinatorThreadId ? handoverThreadId : selection.threadId;
  const candidateIsWorker =
    chosenCandidate !== null && state.tasks.some((task) => task.ownerThreadId === chosenCandidate);
  const facts = crewSupervisionFacts(state, shells ?? []);
  const supervision = classifyCrewSupervision({
    snapshot: state,
    ...facts,
    deliveries: query.data?.deliveries ?? [],
    freshness: !connected ? "disconnected" : query.error || query.isPending ? "stale" : "current",
  });
  const summary = supervision.initiatives.find((entry) => entry.initiativeId === initiative?.id);
  const openConversation = (
    id: ThreadId,
    context?: {
      taskId?: string | null;
      kind?: "conversation" | "question" | "approval";
      requestId?: string | null;
    },
  ) => {
    const task = state.tasks.find((entry) => entry.id === context?.taskId);
    if (task) setSelected(task.initiativeId);
    else if (!selected && initiative) setSelected(initiative.id);
    if (context?.taskId) setSelectedTask(context.taskId);
    appAtomRegistry.set(crewReturnContext(projectKey), {
      threadId: id,
      taskId: context?.taskId ?? selectedTask,
      kind: context?.kind ?? "conversation",
      requestId: context?.requestId ?? null,
    });
    onOpenThread(id);
  };
  const reveal = (element: HTMLDetailsElement | null) => {
    if (!element) return;
    element.open = true;
    element.scrollIntoView({ block: "start" });
  };
  const attentionAction = (item: CrewSupervisionItem) => {
    const action = item.action;
    if (!action) return;
    if (item.initiativeId) setSelected(item.initiativeId);
    switch (action.kind) {
      case "open-thread":
        openConversation(action.threadId, {
          taskId: item.taskId,
          kind:
            action.focus === "approval"
              ? "approval"
              : action.focus === "input"
                ? "question"
                : "conversation",
          requestId: action.requestId ?? null,
        });
        break;
      case "open-task":
        revealTaskRef.current = action.taskId;
        setSelectedTask(action.taskId);
        setTab("tasks");
        setFilters({ query: "", status: null, ownerThreadId: null });
        break;
      case "retry-delivery":
        void act({ type: "delivery.retry", id: action.deliveryId });
        break;
      case "approve-plan":
        reveal(recoveryRef.current);
        break;
      case "resume":
        reveal(recoveryRef.current);
        break;
      case "select-coordinator":
        reveal(setupRef.current);
        break;
      case "refresh-connection":
        query.refresh();
        break;
    }
  };
  const artifactActions = (sourceId: ThreadId | null | undefined) => {
    const source = threads.find((thread) => thread.id === sourceId && thread.deletedAt === null);
    if (!source || !canRead) return {};
    const sourceRef = scopeThreadRef(environmentId, source.id);
    return {
      onOpenCommit: (sha: string) => {
        useDiffPanelStore.getState().selectCommit(sourceRef, sha);
        useRightPanelStore.getState().open(sourceRef, "diff");
        openConversation(source.id);
      },
      onOpenContent: (path: string) => {
        useRightPanelStore.getState().openFile(sourceRef, path);
        openConversation(source.id);
      },
    };
  };
  const artifactLocation = (sourceId: ThreadId | null | undefined) => {
    const source = threads.find((thread) => thread.id === sourceId && thread.deletedAt === null);
    return source
      ? `${source.title} · ${source.worktreePath ?? project?.workspaceRoot ?? "Workspace path unavailable"}`
      : "Source conversation or workspace unavailable";
  };
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
      {state.initiatives.length > 0 && (
        <label className="block text-sm">
          Initiative{" "}
          <select
            aria-label="Selected initiative"
            className="max-w-full rounded border bg-background px-2 py-1"
            value={initiative?.id}
            onChange={(event) => {
              setSelected(event.target.value);
              setSelectedTask(null);
            }}
          >
            {state.initiatives.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.title} · {entry.status}
              </option>
            ))}
          </select>
        </label>
      )}
      <CrewOverview
        supervision={supervision}
        state={state}
        initiativeId={initiative?.id ?? null}
        disabled={disabled}
        onAction={attentionAction}
        onStart={() => reveal(setupRef.current)}
        threadTitle={(id) =>
          threads.find((thread) => thread.id === id)?.title ?? `Conversation ${id}`
        }
      />
      <details ref={setupRef} open={state.initiatives.length === 0 || !!brief.trim()}>
        <summary className="cursor-pointer text-sm font-medium">
          Setup and start another initiative
        </summary>
        <div className="mt-3 space-y-3">
          <label className="block text-sm">
            {state.coordinatorThreadId
              ? "Conversation for explicit handover"
              : "Coordinator candidate"}
            <select
              aria-label="Crew coordinator candidate"
              className="mt-1 block w-full rounded border bg-background p-2"
              value={
                candidateThreadId ??
                (state.coordinatorThreadId ? (threadId ?? "") : (selection.threadId ?? ""))
              }
              onChange={(event) =>
                setCandidateThreadId(
                  threads.find((thread) => thread.id === event.target.value)?.id ?? null,
                )
              }
            >
              <option value="">Choose a project conversation</option>
              {threads
                .filter((thread) =>
                  isCrewCoordinatorCandidate({ environmentId, projectId }, thread),
                )
                .map((thread) => (
                  <option key={thread.id} value={thread.id}>
                    {thread.title}
                  </option>
                ))}
            </select>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">Project coordinator</span>
            {state.coordinatorThreadId ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => openConversation(state.coordinatorThreadId!)}
              >
                Open coordinator
              </Button>
            ) : (
              <span className="text-sm text-muted-foreground">
                Choose a thread to lead this project.
              </span>
            )}
            {!state.coordinatorThreadId && selection.threadId !== null && (
              <Button
                size="sm"
                variant="secondary"
                disabled={disabled || candidateIsWorker || !!selection.reason}
                onClick={() => void act({ type: "coordinator.set", threadId: selection.threadId! })}
              >
                Choose this coordinator
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
          {selection.reason && (
            <p role="status" className="text-sm">
              {selection.reason}
            </p>
          )}
          {candidateIsWorker && (
            <p role="status" className="text-sm">
              An assigned worker cannot also coordinate this project. Choose a separate project
              conversation.
            </p>
          )}
          <p className="text-sm">
            Coordinator: {coordinator?.title ?? "Unavailable or not chosen"} · Model:{" "}
            {coordinator?.modelSelection.model ?? "Unknown"}
          </p>
          <p className="text-sm">
            New initiative: up to 4 concurrent assignments. Workers use separate worktrees by
            default; the coordinator uses{" "}
            {coordinator?.worktreePath ?? project?.workspaceRoot ?? "its project workspace"}. Each
            assignment records its actual workspace.
          </p>
          <p className="text-xs text-muted-foreground">
            Concurrency, attempts and submissions limit execution. They do not set a spending limit.
          </p>
          {query.data?.capabilities?.includes("context") && (
            <p className="text-xs text-muted-foreground">
              To continue with a fresh coordinator, pause the crew, choose a conversation, and use
              that thread. Assignments and reviews stay on the board. Resume initiatives explicitly.
            </p>
          )}
          <details open={state.initiatives.length === 0 || brief.trim().length > 0}>
            <summary className="cursor-pointer text-sm font-medium">Start an initiative</summary>
            <form
              className="mt-3 space-y-3"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!state.coordinatorThreadId || selection.reason || !coordinator) return;
                const id = randomUUID();
                if (await act({ type: "initiative.create", id, title, brief, mode })) {
                  setSelected(id);
                  setBrief("");
                  setTitle(null);
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
                  disabled={
                    disabled ||
                    !state.coordinatorThreadId ||
                    !!selection.reason ||
                    !coordinator ||
                    !title.trim() ||
                    !brief.trim()
                  }
                >
                  Create initiative
                </Button>
              </div>
            </form>
          </details>
        </div>
      </details>
      {state.initiatives.length > 0 && (
        <div className="space-y-3">
          {initiative && (
            <>
              <details ref={recoveryRef}>
                <summary className="cursor-pointer text-sm font-medium">
                  Plan, execution limits and recovery
                </summary>
                <div className="mt-3 space-y-3">
                  <InitiativeEditor
                    key={`${initiative.id}:${initiative.updatedAt}`}
                    initiative={initiative}
                    supportsDependencies={
                      query.data?.capabilities?.includes("submissions") ?? false
                    }
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
                            void act({
                              type: "initiative.status",
                              id: initiative.id,
                              status: "paused",
                            })
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
                        disabled={
                          disabled ||
                          !initiative.approved ||
                          (summary?.resume.prerequisites.length ?? 0) > 0
                        }
                        onClick={() =>
                          void act({
                            type: "initiative.status",
                            id: initiative.id,
                            status: "active",
                          })
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
                          onClick={() =>
                            void act({ type: "initiative.archive", id: initiative.id })
                          }
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
                  {!!summary?.resume.prerequisites.length &&
                    ["paused", "completed", "cancelled"].includes(initiative.status) && (
                      <div className="space-y-1 text-sm">
                        <p>Before resume or reopen:</p>
                        <ul>
                          {[
                            ...new Set(summary.resume.prerequisites.map(crewPrerequisiteLabel)),
                          ].map((label) => (
                            <li key={label}>{label}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  <section className="space-y-2" aria-label="Coordinator handover">
                    <p className="text-sm font-medium">Explicit coordinator handover</p>
                    <p className="text-sm">
                      Pause the crew and confirm workers and coordinator have stopped. Assignments,
                      submissions, reviews and history remain; initiatives resume only when you
                      choose Resume.
                    </p>
                    {supervision.handover.prerequisites.length > 0 && (
                      <ul className="space-y-1 text-sm">
                        {[
                          ...new Set(supervision.handover.prerequisites.map(crewPrerequisiteLabel)),
                        ].map((label) => (
                          <li key={label}>{label}</li>
                        ))}
                      </ul>
                    )}
                    {query.data?.capabilities?.includes("context") && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={disabled}
                        onClick={() => void act({ type: "coordinator.pause" })}
                      >
                        Pause crew for handover
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        disabled ||
                        candidateIsWorker ||
                        !handoverThreadId ||
                        handoverThreadId === state.coordinatorThreadId ||
                        !threads.some(
                          (thread) =>
                            thread.id === handoverThreadId &&
                            isCrewCoordinatorCandidate({ environmentId, projectId }, thread),
                        ) ||
                        supervision.handover.prerequisites.length > 0
                      }
                      onClick={() =>
                        handoverThreadId &&
                        void act({ type: "coordinator.set", threadId: handoverThreadId })
                      }
                    >
                      Hand over to selected conversation
                    </Button>
                    {(!handoverThreadId || handoverThreadId === state.coordinatorThreadId) && (
                      <p className="text-xs">
                        Choose a different eligible project conversation under Setup to hand over.
                      </p>
                    )}
                  </section>
                  {query.data?.capabilities?.includes("submissions") && (
                    <CrewLimits
                      key={`${initiative.id}:${JSON.stringify(initiative.policy)}`}
                      initiative={initiative}
                      disabled={disabled}
                      act={act}
                    />
                  )}
                </div>
              </details>
              <details open={initiative.status === "completed"}>
                <summary className="cursor-pointer text-sm font-medium">
                  Integrated results and milestone verification
                </summary>
                <div className="mt-3 space-y-3">
                  <p className="text-sm">
                    Task acceptance and integrated milestone verification are separate. Check the
                    combined output and record any remaining integration, merge or publication work
                    in its evidence.
                  </p>
                  {initiative.milestones.map((m) => (
                    <CrewMilestone
                      key={`${initiative.id}:${m.id}:${m.accepted}`}
                      initiative={initiative}
                      milestone={m}
                      disabled={disabled}
                      requiresVerification={
                        query.data?.capabilities?.includes("submissions") ?? false
                      }
                      act={act}
                      tasks={state.tasks}
                      environmentId={environmentId}
                      projectId={projectId}
                      artifactsEnabled={query.data?.capabilities?.includes("artifacts") ?? false}
                      {...artifactActions(m.verification?.threadId)}
                    />
                  ))}
                  {initiative.milestones.length === 0 && (
                    <p className="text-sm">No integrated milestone verification is recorded.</p>
                  )}
                </div>
              </details>
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
          key={selectedTask ?? "coordinator"}
          environmentId={environmentId}
          state={state}
          preview={query.data.context ?? null}
          onOpenThread={openConversation}
          initialThreadId={
            state.tasks.find((task) => task.id === selectedTask)?.ownerThreadId ?? undefined
          }
        />
      )}
      {tab === "tasks" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="Filter Crew tasks"
              placeholder="Filter tasks"
              value={filters.query}
              onChange={(event) => setFilters({ ...filters, query: event.target.value })}
            />
            <select
              aria-label="Task acceptance filter"
              className="rounded border bg-background p-2 text-sm"
              value={filters.status ?? ""}
              onChange={(event) => setFilters({ ...filters, status: event.target.value || null })}
            >
              <option value="">All acceptance states</option>
              {["ready", "delegating", "running", "blocked", "review", "done", "cancelled"].map(
                (status) => (
                  <option key={status}>{status}</option>
                ),
              )}
            </select>
            <select
              aria-label="Task owner filter"
              className="rounded border bg-background p-2 text-sm"
              value={filters.ownerThreadId ?? ""}
              onChange={(event) =>
                setFilters({
                  ...filters,
                  ownerThreadId:
                    threads.find((thread) => thread.id === event.target.value)?.id ?? null,
                })
              }
            >
              <option value="">All owners</option>
              {threads
                .filter((thread) => state.tasks.some((task) => task.ownerThreadId === thread.id))
                .map((thread) => (
                  <option key={thread.id} value={thread.id}>
                    {thread.title}
                  </option>
                ))}
            </select>
          </div>
          {selectedTask && (
            <p className="text-sm">
              Selected work:{" "}
              {state.tasks.find((task) => task.id === selectedTask)?.title ?? selectedTask}{" "}
              <Button size="sm" variant="ghost" onClick={() => setSelectedTask(null)}>
                Clear selection
              </Button>
            </p>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            {state.tasks
              .filter((t) => t.initiativeId === initiative?.id)
              .filter(
                (task) =>
                  (!filters.status || task.status === filters.status) &&
                  (!filters.ownerThreadId || task.ownerThreadId === filters.ownerThreadId) &&
                  `${task.title} ${task.brief}`.toLowerCase().includes(filters.query.toLowerCase()),
              )
              .map((task) => (
                <div
                  key={task.id}
                  ref={(element) => {
                    if (!element || revealTaskRef.current !== task.id) return;
                    revealTaskRef.current = null;
                    element.scrollIntoView({ block: "start" });
                  }}
                  className={`space-y-2 rounded-lg border p-4 ${selectedTask === task.id ? "border-primary" : ""}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="font-medium">
                      <button type="button" onClick={() => setSelectedTask(task.id)}>
                        {task.title}
                      </button>
                    </h3>
                    <span className="text-xs text-muted-foreground">{task.status}</span>
                  </div>
                  <p className="whitespace-pre-wrap text-sm">{task.brief}</p>
                  <p className="text-sm text-muted-foreground">Accept when: {task.criteria}</p>
                  <CrewWorkerStatus
                    environmentId={environmentId}
                    task={task}
                    attention={supervision.attention.some((item) => item.taskId === task.id)}
                  />
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
                      onClick={() => {
                        setSelectedTask(task.id);
                        openConversation(task.ownerThreadId!, { taskId: task.id });
                      }}
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
                  <CrewTaskArtifact
                    task={task}
                    environmentId={environmentId}
                    projectId={projectId}
                    artifactsEnabled={query.data?.capabilities?.includes("artifacts") ?? false}
                    {...artifactActions(task.submission?.threadId ?? task.ownerThreadId)}
                  />
                  {task.submission && (
                    <p className="break-all text-xs text-muted-foreground">
                      Result workspace:{" "}
                      {artifactLocation(task.submission.threadId ?? task.ownerThreadId)}
                    </p>
                  )}
                  {task.ownerThreadId && query.data?.capabilities?.includes("context") && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setSelectedTask(task.id);
                        setTab("context");
                      }}
                    >
                      Inspect delivered worker context
                    </Button>
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
                      key={`${task.id}:${task.submission?.revision ?? "legacy"}`}
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
                  <details>
                    <summary className="cursor-pointer text-sm">Assignment recovery</summary>
                    <p className="mt-2 text-sm">
                      Reset requests a worker stop and clears the current assignment, submission and
                      review. Use Request changes to retain the worker and its submitted result. A
                      replacement must wait for the previous worker and its stop delivery to finish;
                      unresolved dependencies or verified dependent milestones may also need
                      attention.
                    </p>
                    <div className="mt-2 flex gap-2">
                      {task.status !== "ready" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={disabled}
                          onClick={() =>
                            void act({ type: "task.reset", id: task.id, status: "ready" })
                          }
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
                  </details>
                  {["ready", "cancelled"].includes(task.status) && (
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
        </div>
      )}
      {tab === "conversations" && (
        <div className="space-y-3">
          {state.coordinatorThreadId && (
            <Button variant="outline" onClick={() => openConversation(state.coordinatorThreadId!)}>
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
                <CrewWorkerStatus
                  environmentId={environmentId}
                  task={task}
                  attention={supervision.attention.some((item) => item.taskId === task.id)}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setSelectedTask(task.id);
                    openConversation(task.ownerThreadId!, { taskId: task.id });
                  }}
                >
                  Open conversation
                </Button>
              </div>
            ))}
        </div>
      )}
      {tab === "board" && (
        <CrewCommunication
          state={state}
          projectKey={projectKey}
          initiativeId={initiative?.id ?? null}
          deliveries={query.data?.deliveries ?? []}
          disabled={disabled}
          act={act}
          onResume={() => reveal(recoveryRef.current)}
        />
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
          onOpenThread={openConversation}
        />
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
