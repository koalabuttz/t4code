import { useLayoutEffect, useRef, useState } from "react";
import {
  Link,
  Navigate,
  useNavigate,
  useParams,
  useRouterState,
  useSearch,
} from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import {
  parseScopedProjectKey,
  scopeThreadRef,
  scopedProjectKey,
} from "@t3tools/client-runtime/environment";
import {
  crewDraftBrief,
  crewCandidateThread,
  crewOriginThread,
  crewScrollOffset,
  isCrewCoordinatorCandidate,
} from "@t3tools/client-runtime/state/crew";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  ThreadId,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Option from "effect/Option";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useProject, useQuietThreadShell } from "../../state/entities";
import { useEnvironmentShellStatus } from "../../state/shell";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { threadEnvironment, useEnvironmentThread } from "../../state/threads";
import { useEnvironmentScope } from "../../state/session";
import { isThreadRouteSnapshotAuthoritative } from "../../threadRoutes";
import { useComposerDraftStore, useThreadHasUnsentDraft } from "../../composerDraftStore";
import { resolveProjectDefaultProviderModelSelection } from "../../providerInstances";
import { cn, randomUUID } from "../../lib/utils";
import { observeResize } from "../../lib/observeResize";
import { SidebarInset, useSidebar } from "../ui/sidebar";
import { Button } from "../ui/button";
import { CrewNavigation } from "./CrewChatControls";
import { CrewThreads } from "./CrewThreads";
import { TeamworkPanel } from "./TeamworkPanel";
import {
  crewThreadRoute,
  readCrewCoordinatorCandidate,
  readCrewForConfirmation,
  useCrewCollection,
  useCrewProject,
} from "./crewChatState";
import { establishCrewCoordinator } from "./crewChat.logic";

const route = "/_chat/projects/$projectKey/crew";

export function CrewWorkspace() {
  const { projectKey } = useParams({ from: route });
  const scope = parseScopedProjectKey(projectKey);
  return scope ? (
    <ProjectCrew key={projectKey} scope={scope} />
  ) : (
    <SidebarInset>
      <p className="p-6">This Crew link does not identify a project and environment.</p>
    </SidebarInset>
  );
}

function ProjectCrew({ scope }: { scope: ScopedProjectRef }) {
  const { view = "chat", section = "project", handoff } = useSearch({ from: route });
  const navigate = useNavigate();
  const originHref = useRouterState({ select: (state) => state.location.href });
  const source = useRouterState({ select: (state) => state.location.state.crewSource });
  const sidebar = useSidebar();
  const project = useProject(scope);
  const projectKey = scopedProjectKey(scope);
  const { config, enabled, query, snapshot } = useCrewProject(scope);
  const coordinatorId = snapshot?.coordinatorThreadId ?? null;
  const ref = coordinatorId ? scopeThreadRef(scope.environmentId, coordinatorId) : null;
  const shell = useQuietThreadShell(ref);
  const detail = useEnvironmentThread(
    view === "chat" && !shell && ref ? ref.environmentId : null,
    view === "chat" && !shell ? coordinatorId : null,
  );
  const detailThread = Option.getOrNull(detail.data)?.thread;
  const shellStatus = useEnvironmentShellStatus(scope.environmentId);
  const available =
    (shell?.deletedAt === null && shell.projectId === scope.projectId) ||
    (detail.status !== "deleted" && detailThread?.projectId === scope.projectId);
  const scrollRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const scrollKey = `${projectKey}:${view}:${view === "settings" ? section : ""}`;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Restore the view's DOM scroll position after navigation.
  useLayoutEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
    const element = scrollRef.current;
    if (!element) return;
    const restore = () => {
      element.scrollTop = appAtomRegistry.get(crewScrollOffset(scrollKey));
    };
    restore();
    return element.firstElementChild
      ? observeResize(element.firstElementChild, restore)
      : undefined;
  }, [scrollKey]);

  if (view === "chat" && ref && available && enabled && project)
    return <OpenCoordinator scope={scope} threadId={ref.threadId} />;

  return (
    <SidebarInset
      ref={scrollRef}
      className="h-svh overflow-y-auto scrollbar-gutter-both md:h-dvh"
      onScroll={(event) => {
        const element = event.currentTarget;
        const atom = crewScrollOffset(scrollKey);
        const max = element.scrollHeight - element.clientHeight;
        if (appAtomRegistry.get(atom) > max && element.scrollTop === max) return;
        appAtomRegistry.set(atom, element.scrollTop);
      }}
    >
      <div
        className={cn(
          "mx-auto w-full max-w-5xl space-y-5 p-5 sm:p-6",
          (sidebar.isMobile || sidebar.state === "collapsed") && "pt-14 sm:pt-14",
        )}
      >
        <header className="space-y-2">
          <h1 ref={headingRef} tabIndex={-1} className="text-xl font-semibold outline-none">
            {project?.title ?? "Project Crew"}
          </h1>
          {enabled && project ? (
            <CrewNavigation
              scope={scope}
              view={view}
              coordinatorThreadId={available ? coordinatorId : null}
            />
          ) : null}
          {source?.projectKey === projectKey && source.originHref !== originHref ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void navigate({ href: source.originHref })}
            >
              Return to origin
            </Button>
          ) : null}
        </header>
        {!config ? (
          <p role="status">Connect to this environment to open its project chat.</p>
        ) : !enabled ? (
          <p role="status">This server does not support Crew.</p>
        ) : !project ? (
          <p role="status">This project is unavailable in the selected environment.</p>
        ) : !snapshot ? (
          <p role="status">{query.error ?? "Loading project chat…"}</p>
        ) : view === "chat" ? (
          coordinatorId ? (
            <div className="space-y-2 text-sm">
              <p role="status">
                {shellStatus !== "live"
                  ? "Offline. Coordinator availability is unconfirmed."
                  : shell?.deletedAt ||
                      detail.status === "deleted" ||
                      (isThreadRouteSnapshotAuthoritative(shellStatus) &&
                        Option.isSome(detail.error))
                    ? "The saved coordinator conversation is unavailable."
                    : "Opening the coordinator conversation…"}
              </p>
              <Link
                to="/projects/$projectKey/crew"
                params={{ projectKey }}
                search={{ view: "settings", section: "crew" }}
                className="underline underline-offset-4"
              >
                Coordinator recovery
              </Link>
            </div>
          ) : (
            <CoordinatorSetup scope={scope} />
          )
        ) : view === "threads" ? (
          <CrewThreads scope={scope} />
        ) : (
          <>
            {view === "settings" ? (
              <nav aria-label="Project settings" className="flex flex-wrap gap-1">
                {(
                  [
                    ["project", "Project"],
                    ["crew", "Crew"],
                    ["memory", "Memory and context"],
                    ["advanced", "Advanced"],
                  ] as const
                ).map(([key, label]) => (
                  <Button
                    key={key}
                    size="sm"
                    variant={section === key ? "secondary" : "ghost"}
                    render={
                      <Link
                        to="/projects/$projectKey/crew"
                        params={{ projectKey }}
                        search={{ view, section: key }}
                        aria-current={section === key ? "page" : undefined}
                      />
                    }
                  >
                    {label}
                  </Button>
                ))}
              </nav>
            ) : null}
            {view === "settings" && section === "project" ? (
              <section className="space-y-3 rounded-lg border p-4 text-sm">
                <h2 className="font-semibold">Project details</h2>
                <p className="break-all text-muted-foreground">{project.workspaceRoot}</p>
                <p className="text-muted-foreground">
                  Environment {config.environment.label ?? scope.environmentId}
                </p>
                {snapshot.initiatives.at(-1)?.brief ? (
                  <details>
                    <summary>Current project goal</summary>
                    <p className="mt-2 whitespace-pre-wrap">{snapshot.initiatives.at(-1)?.brief}</p>
                  </details>
                ) : null}
                <Link to="/settings/projects" className="underline underline-offset-4">
                  Manage projects
                </Link>
              </section>
            ) : (
              <>
                {view === "settings" && section === "advanced" && handoff ? (
                  <CrewHandoffDetails scope={scope} id={handoff} />
                ) : null}
                <TeamworkPanel
                  {...scope}
                  threadId={null}
                  surface={
                    view === "results" ? "results" : section === "project" ? "crew" : section
                  }
                  onOpenThread={(threadId, requestId) => {
                    void navigate({
                      ...crewThreadRoute(scope, threadId),
                      state: {
                        crewSource: { projectKey, originHref },
                        ...(requestId ? { crewRequestId: requestId } : {}),
                      },
                    });
                  }}
                />
              </>
            )}
          </>
        )}
      </div>
    </SidebarInset>
  );
}

function OpenCoordinator({ scope, threadId }: { scope: ScopedProjectRef; threadId: ThreadId }) {
  const projectKey = scopedProjectKey(scope);
  const ref = scopeThreadRef(scope.environmentId, threadId);
  const brief = useAtomValue(crewDraftBrief(projectKey));
  const hasDraft = useThreadHasUnsentDraft(ref);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Transfer a legacy slash-command brief into the real coordinator composer before routing.
  useLayoutEffect(() => {
    if (!brief.trim() || hasDraft) return;
    useComposerDraftStore.getState().setPrompt(ref, brief);
    appAtomRegistry.set(crewDraftBrief(projectKey), "");
  }, [brief, hasDraft, projectKey, ref]);
  if (brief.trim() && hasDraft)
    return (
      <SidebarInset>
        <div className="space-y-3 p-6">
          <p>Your coordinator has an unsent draft. The Crew brief is saved in Crew settings.</p>
          <Link {...crewThreadRoute(scope, threadId)} className="underline underline-offset-4">
            Open project chat
          </Link>
          <Link
            to="/projects/$projectKey/crew"
            params={{ projectKey }}
            search={{ view: "settings", section: "crew" }}
            className="block underline underline-offset-4"
          >
            Open Crew settings
          </Link>
        </div>
      </SidebarInset>
    );
  return <Navigate {...crewThreadRoute(scope, threadId)} replace />;
}

function CoordinatorSetup({ scope }: { scope: ScopedProjectRef }) {
  const project = useProject(scope);
  const projectKey = scopedProjectKey(scope);
  const { snapshot, config, query } = useCrewProject(scope);
  const connected = useEnvironmentShellStatus(scope.environmentId) === "live";
  const origin = useAtomValue(crewOriginThread(projectKey));
  const chosen = useAtomValue(crewCandidateThread(projectKey)) ?? origin;
  const candidate = useQuietThreadShell(
    chosen ? scopeThreadRef(scope.environmentId, chosen) : null,
  );
  const permission = useAtomValue(
    serverEnvironment.mutateTeamwork.permissionAtom(scope.environmentId),
  );
  const canOperate = useEnvironmentScope(scope.environmentId, "orchestration:operate");
  const create = useOrchestrationCommand(threadEnvironment.create, { reportFailure: false });
  const mutate = useAtomCommand(serverEnvironment.mutateTeamwork, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!snapshot) return null;
  const settings = config?.settings ?? DEFAULT_SERVER_SETTINGS;
  const defaults = resolveProjectSettings(settings, scope.projectId, project ?? undefined).settings;
  const modelSelection =
    defaults.defaultModelSelection ??
    resolveProjectDefaultProviderModelSelection(config?.providers ?? [], settings, scope.projectId);
  const existing =
    candidate &&
    isCrewCoordinatorCandidate(scope, candidate) &&
    !snapshot.tasks.some((task) => task.ownerThreadId === candidate.id)
      ? candidate
      : null;
  const confirm = async (useExisting: boolean) => {
    if (
      busy ||
      !permission ||
      !canOperate ||
      !connected ||
      !query.isSuccess ||
      snapshot.coordinatorThreadId ||
      (useExisting && !existing)
    )
      return;
    setBusy(true);
    setError(null);
    const threadId =
      useExisting && existing ? existing.id : ThreadId.make(`crew-coordinator:${scope.projectId}`);
    try {
      const createShell = async () => {
        if (!modelSelection)
          throw new Error("Choose a default provider and model for this project first.");
        const result = await create({
          environmentId: scope.environmentId,
          input: {
            threadId,
            projectId: scope.projectId,
            title: "Project coordinator",
            modelSelection,
            runtimeMode: defaults.defaultRuntimeMode,
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      };
      await establishCrewCoordinator({
        scope,
        threadId,
        readCrew: () => readCrewForConfirmation(scope),
        readThread: () => readCrewCoordinatorCandidate(scope, threadId),
        ...(useExisting ? {} : { create: createShell }),
        setCoordinator: async (expectedRevision) => {
          const result = await mutate({
            environmentId: scope.environmentId,
            input: {
              projectId: scope.projectId,
              expectedRevision,
              commandId: CommandId.make(randomUUID()),
              action: { type: "coordinator.set", threadId },
            },
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        },
      });
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Could not establish this coordinator.",
      );
    } finally {
      query.refresh();
      setBusy(false);
    }
  };
  return (
    <section className="space-y-3 rounded-lg border p-4 text-sm">
      <h2 className="font-semibold">Start your project conversation</h2>
      <p className="text-muted-foreground">
        The coordinator answers questions, finds the right work thread and organizes implementation.
      </p>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={
            busy || !connected || !permission || !canOperate || !modelSelection || !query.isSuccess
          }
          onClick={() => void confirm(false)}
        >
          Create coordinator conversation
        </Button>
        {existing ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !connected || !permission || !canOperate || !query.isSuccess}
            onClick={() => void confirm(true)}
          >
            Use {existing.title}
          </Button>
        ) : null}
      </div>
      {!connected ? <p role="status">Reconnect to set up the coordinator.</p> : null}
      {!modelSelection ? (
        <p role="status">Set a project provider and model to create a conversation.</p>
      ) : null}
    </section>
  );
}

function CrewHandoffDetails({ scope, id }: { scope: ScopedProjectRef; id: string }) {
  const query = useCrewCollection(scope, "handoffs", { id });
  const handoff = query.data?.handoffs[0];
  const origin = useQuietThreadShell(handoff?.origin.conversation ?? null);
  const destination = useQuietThreadShell(handoff?.destination ?? null);
  const owner = useQuietThreadShell(
    handoff && "assignment" in handoff.ownership ? handoff.ownership.assignment.owner : null,
  );
  return (
    <section className="space-y-2 rounded-lg border p-4 text-sm" aria-label="Handoff details">
      <h2 className="font-semibold">Handoff details</h2>
      {handoff ? (
        <>
          <p>
            {origin?.title ?? "Origin conversation"} →{" "}
            {destination?.title ?? "Destination conversation"}
          </p>
          <p>
            Recorded handoff {handoff.state} ·{" "}
            {handoff.ownership.state === "discussion-only"
              ? "Discussion"
              : `${owner?.title ?? "Recorded owner"} · ${handoff.ownership.state === "reconciled" ? "Stop reconciled" : "Destination held"}`}
          </p>
          <div className="flex flex-wrap gap-3">
            <Link
              {...crewThreadRoute(scope, handoff.origin.conversation.threadId)}
              className="underline underline-offset-4"
            >
              Open origin
            </Link>
            <Link
              {...crewThreadRoute(scope, handoff.destination.threadId)}
              className="underline underline-offset-4"
            >
              Open destination
            </Link>
          </div>
        </>
      ) : (
        <p role="status">
          {query.error ?? (query.isSuccess ? "This handoff is unavailable." : "Loading handoff…")}
        </p>
      )}
    </section>
  );
}
