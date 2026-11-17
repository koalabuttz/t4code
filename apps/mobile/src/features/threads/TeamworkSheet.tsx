import { useEffect, useRef, useState } from "react";
import { ScrollView, View, type ScrollViewInstance } from "react-native";
import { useAtom, useAtomValue } from "@effect/atom-react";
import {
  crewCandidateThread,
  crewDraftBrief,
  crewDraftMode,
  crewDraftTitle,
  crewFilters,
  crewMessageDraft,
  crewOriginThread,
  crewReturnContext,
  crewScrollOffset,
  crewLiveFreshness,
  crewSelectedInitiative,
  crewSelectedTask,
  crewSelectedView,
  isCrewCoordinatorCandidate,
  resolveCrewCoordinator,
  type CrewView,
} from "@t3tools/client-runtime/state/crew";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import { StackActions, useNavigation } from "@react-navigation/native";
import {
  AuthFilesystemReadScope,
  AuthOrchestrationReadScope,
  CommandId,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  type TeamworkAction,
  type TeamworkSnapshot,
} from "@t3tools/contracts";
import type { CrewPrerequisite, CrewSupervisionItem } from "@t3tools/shared/crewSupervision";
import { crewDeliveryNotice } from "@t3tools/shared/crewArtifacts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AppText, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Menu } from "../../components/ui/Menu";
import { Sheet } from "../../components/ui/Sheet";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentShellReadiness } from "../../state/shell";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentScope } from "../../state/session";
import { useProject } from "../../state/entities";
import { uuidv4 } from "../../lib/uuid";
import { TeamworkBriefEditor, TeamworkRoles, TeamworkTaskEditor } from "./TeamworkEditors";
import { CrewHistory } from "./CrewHistory";
import { CrewContextView } from "./CrewContextView";
import { CrewLimits, CrewMilestone, CrewTaskArtifact } from "./CrewVerification";
import { environmentThreadShells, threadFamilies } from "../../state/threads";
import { useRetryEnvironment } from "../connection/useRetryEnvironment";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  mobileCrewArtifactWorkspace,
  mobileCrewDraftAfterSave,
  mobileCrewMessageDeliveries,
  mobileCrewRecipients,
  mobileCrewSupervision,
} from "./crewMobile.logic";

export type CrewPage =
  | CrewView
  | "setup"
  | "settings"
  | "recovery"
  | "task"
  | "task-edit"
  | "milestones";
export interface TeamworkTarget {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId | null;
}

export function TeamworkSheet({
  target,
  onClose,
  embedded = false,
  page = "overview",
}: {
  target: TeamworkTarget;
  onClose: () => void;
  embedded?: boolean;
  page?: CrewPage | undefined;
}) {
  const { environmentId, projectId, threadId } = target;
  const projectKey = scopedProjectKey(target);
  const query = useEnvironmentQuery(
    serverEnvironment.teamworkLive({ environmentId, input: { projectId } }),
  );
  const canEdit = useAtomValue(serverEnvironment.mutateTeamwork.permissionAtom(environmentId));
  const canReadFiles = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  const canReadThreads = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const connected = useEnvironmentShellReadiness(environmentId).status === "live";
  const mutation = useAtomCommand(serverEnvironment.mutateTeamwork, { reportFailure: false });
  const navigation = useNavigation();
  const retryEnvironment = useRetryEnvironment();
  const project = useProject(target);
  const allThreads = useAtomValue(environmentThreadShells.quietThreadShellsAtom);
  const threads = allThreads.filter(
    (thread) => thread.environmentId === environmentId && thread.projectId === projectId,
  );
  const [selected, setSelected] = useAtom(crewSelectedInitiative(projectKey));
  const [selectedTask, setSelectedTask] = useAtom(crewSelectedTask(projectKey));
  const [filters, setFilters] = useAtom(crewFilters(projectKey));
  const [, setView] = useAtom(crewSelectedView(projectKey));
  const [returnContext, setReturnContext] = useAtom(crewReturnContext(projectKey));
  const [candidate, setCandidate] = useAtom(crewCandidateThread(projectKey));
  const origin = useAtomValue(crewOriginThread(projectKey));
  const [title, setTitle] = useAtom(crewDraftTitle(projectKey));
  const [brief, setBrief] = useAtom(crewDraftBrief(projectKey));
  const [mode, setMode] = useAtom(crewDraftMode(projectKey));
  const [draft, setDraft] = useAtom(crewMessageDraft(projectKey));
  const [messageNotice, setMessageNotice] = useState<string | null>(null);
  const [lastMessageId, setLastMessageId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [knowledgeId, setKnowledgeId] = useState<string | null>(null);
  const [knowledgeTitle, setKnowledgeTitle] = useState("");
  const [knowledgeText, setKnowledgeText] = useState("");
  const scroll = useRef<ScrollViewInstance>(null);
  const scrollPosition = useRef(appAtomRegistry.get(crewScrollOffset(projectKey)));
  const restoredScroll = useRef(false);
  const state = query.data?.snapshot;
  const freshness = crewLiveFreshness(connected, query);
  const supervision = query.data ? mobileCrewSupervision(query.data, threads, freshness) : null;
  const initiative =
    state?.initiatives.find((item) => item.id === selected) ?? state?.initiatives.at(-1);
  const summary = supervision?.initiatives.find((item) => item.initiativeId === initiative?.id);
  const task = state?.tasks.find(
    (item) => item.id === selectedTask && item.initiativeId === initiative?.id,
  );
  const selection = resolveCrewCoordinator({
    project: target,
    threads: allThreads,
    coordinatorThreadId: state?.coordinatorThreadId ?? null,
    candidateThreadId: candidate,
    originThreadId: origin ?? threadId,
  });
  const eligibleThreads = threads.filter((thread) => isCrewCoordinatorCandidate(target, thread));
  const coordinator = threads.find((thread) => thread.id === selection.threadId);
  const handoverCandidate = eligibleThreads.find((thread) => thread.id === candidate);
  const replacementCoordinator =
    handoverCandidate ?? (state?.coordinatorThreadId ? null : coordinator);
  const familyIds = JSON.stringify(
    [
      ...new Set(
        [
          state?.coordinatorThreadId,
          ...(state?.tasks.map((task) => task.ownerThreadId) ?? []),
          ...(query.data?.deliveries.map((delivery) => delivery.threadId) ?? []),
        ].filter((id): id is ThreadId => id != null),
      ),
    ].sort(),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribe to all Crew thread families so offscreen initiatives and coordinator requests stay live.
  useEffect(() => {
    const ids: ThreadId[] = JSON.parse(familyIds);
    const releases = ids.map((id) => threadFamilies.mount(appAtomRegistry, environmentId, id));
    return () => releases.forEach((release) => release());
  }, [environmentId, familyIds]);
  const act = async (action: TeamworkAction, commandId = CommandId.make(uuidv4())) => {
    if (!state || busy || !canEdit || freshness !== "current") return false;
    setBusy(true);
    setError(null);
    const result = await mutation({
      environmentId,
      input: {
        projectId,
        commandId,
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
  const disabled = busy || !canEdit || freshness !== "current";
  const supports = (capability: "archive" | "submissions" | "context" | "artifacts") =>
    query.data?.capabilities?.includes(capability) ?? false;
  const go = (next: CrewPage) => {
    appAtomRegistry.set(crewScrollOffset(projectKey), 0);
    if (
      [
        "overview",
        "tasks",
        "conversations",
        "board",
        "knowledge",
        "context",
        "roles",
        "history",
      ].includes(next)
    )
      setView(next as CrewView);
    if (!embedded) onClose();
    navigation.dispatch(
      StackActions.push("Crew", {
        environmentId,
        projectId,
        page: next,
        originThreadId: origin ?? threadId ?? undefined,
      }),
    );
  };
  const openThread = (id: ThreadId, item?: CrewSupervisionItem) => {
    if (!canReadThreads) return;
    if (item?.initiativeId) setSelected(item.initiativeId);
    else if (initiative) setSelected(initiative.id);
    appAtomRegistry.set(crewScrollOffset(projectKey), scrollPosition.current);
    if (item?.taskId) setSelectedTask(item.taskId);
    setReturnContext({
      threadId: id,
      taskId: item?.taskId ?? appAtomRegistry.get(crewSelectedTask(projectKey)),
      kind:
        item?.kind === "approval"
          ? "approval"
          : item?.kind === "input"
            ? "question"
            : "conversation",
      requestId: item?.requestId ?? null,
    });
    if (!embedded) onClose();
    navigation.dispatch(
      StackActions.push("Thread", {
        environmentId,
        threadId: id,
        crewProjectId: projectId,
        crewPage: page,
      }),
    );
  };
  const threadName = (id: ThreadId) => threads.find((thread) => thread.id === id)?.title ?? id;
  const contentOpener = (sourceThreadId: ThreadId | null) => {
    const cwd = mobileCrewArtifactWorkspace(
      sourceThreadId,
      threads,
      project?.workspaceRoot ?? null,
    );
    return canReadFiles && connected && cwd
      ? (path: string) => {
          if (!embedded) onClose();
          navigation.dispatch(
            StackActions.push("ThreadFile", {
              environmentId,
              threadId: sourceThreadId ?? undefined,
              cwd,
              projectName: project?.title,
              path: [path],
            }),
          );
        }
      : undefined;
  };
  const prerequisiteText = (item: CrewPrerequisite) => {
    switch (item.kind) {
      case "refresh-connection":
        return "Reconnect and refresh current execution.";
      case "select-coordinator":
        return "Choose a coordinator conversation.";
      case "approve-plan":
        return "Approve the current plan before continuing.";
      case "pause-initiative":
        return `Pause ${state?.initiatives.find((initiative) => initiative.id === item.initiativeId)?.title ?? item.initiativeId}.`;
      case "verify-assignment":
        return `Verify assignment: ${state?.tasks.find((task) => task.id === item.taskId)?.title ?? item.taskId}.`;
      case "retry-stop":
        return `Retry the failed stop for ${threads.find((thread) => thread.id === item.threadId)?.title ?? item.threadId}.`;
      case "wait-stop":
        return "Wait for the pending stop delivery.";
      case "wait-worker":
        return "Wait for the worker to stop.";
      case "stop-coordinator":
        return "Pause the crew to stop the coordinator.";
      case "verify-execution":
        return `Verify current execution: ${threads.find((thread) => thread.id === item.threadId)?.title ?? item.threadId}.`;
    }
  };
  const resumeBlockers =
    summary?.resume.prerequisites.filter((item) => item.kind !== "approve-plan") ?? [];
  const actionFor = (item: CrewSupervisionItem) => {
    const action = item.action;
    if (!action) return null;
    switch (action.kind) {
      case "open-thread":
        return (
          <Button
            label={
              action.focus === "approval"
                ? "Open approval conversation"
                : action.focus === "input"
                  ? "Open question conversation"
                  : "Open conversation"
            }
            disabled={!canReadThreads}
            onPress={() => openThread(action.threadId, item)}
          />
        );
      case "open-task":
        return (
          <Button
            label={item.kind === "review" ? "Inspect submitted result" : "Inspect work"}
            onPress={() => {
              setSelectedTask(action.taskId);
              if (item.initiativeId) setSelected(item.initiativeId);
              go("task");
            }}
          />
        );
      case "retry-delivery":
        return (
          <Button
            label="Retry delivery"
            disabled={disabled}
            onPress={() => void act({ type: "delivery.retry", id: action.deliveryId })}
          />
        );
      case "refresh-connection":
        return <Button label="Refresh facts" disabled={!connected} onPress={query.refresh} />;
      case "select-coordinator":
        return <Button label="Choose coordinator" onPress={() => go("recovery")} />;
      case "resume":
        return (
          <Button
            label="Review resume prerequisites"
            onPress={() => {
              setSelected(action.initiativeId);
              go("recovery");
            }}
          />
        );
      case "approve-plan":
        return (
          <Button
            label="Review plan"
            onPress={() => {
              setSelected(action.initiativeId);
              go("settings");
            }}
          />
        );
    }
  };
  const renderItem = (item: CrewSupervisionItem) => (
    <View key={item.id} className="gap-2 rounded-2xl bg-secondary p-4">
      <AppText className="font-t3-semibold">{item.label}</AppText>
      <AppText>
        {item.initiativeTitle ?? "Project crew"}
        {item.taskId
          ? ` · ${state?.tasks.find((task) => task.id === item.taskId)?.title ?? item.taskId}`
          : ""}
      </AppText>
      <AppText>
        {item.responsibility === "human"
          ? "Needs you"
          : item.responsibility === "crew"
            ? item.underway
              ? "Crew is handling it"
              : "Crew owns the next step; execution is not confirmed"
            : item.responsibility === "waiting"
              ? "Waiting"
              : "Responsibility unknown"}
        {item.actor.kind === "agent" ? ` · ${threadName(item.actor.threadId)}` : ""}
      </AppText>
      {item.freshness !== "current" && (
        <AppText>
          Execution {item.freshness === "last-known" ? "last known" : "unavailable"}
          {item.lastKnownState ? ` · ${item.lastKnownState}` : ""}
        </AppText>
      )}
      {item.detail && <AppText>{item.detail}</AppText>}
      {item.requestId && (
        <AppText selectable>
          Request: {item.requestId}. Open the conversation to respond to this request.
        </AppText>
      )}
      {item.dependencyIds?.map((id) => (
        <Button
          key={id}
          label={`Dependency: ${state?.tasks.find((task) => task.id === id)?.title ?? id}`}
          onPress={() => {
            setSelectedTask(id);
            const dependency = state?.tasks.find((task) => task.id === id);
            if (dependency) setSelected(dependency.initiativeId);
            go("task");
          }}
        />
      ))}
      {actionFor(item)}
    </View>
  );
  const recipients = initiative && state ? mobileCrewRecipients(state, initiative.id, threads) : [];
  const validRecipients = draft.recipients.filter((id) => recipients.includes(id));
  const renderBoardMessage = (message: TeamworkSnapshot["board"][number]) => {
    const messageInitiative = state?.initiatives.find((item) => item.id === message.initiativeId);
    const deliveries = mobileCrewMessageDeliveries(
      projectId,
      message,
      query.data?.deliveries ?? [],
    );
    return (
      <View key={message.id} className="gap-2 rounded-2xl bg-secondary p-4">
        <AppText className="font-t3-semibold">
          {message.initiativeId === null
            ? "Project crew"
            : (messageInitiative?.title ?? "Initiative unavailable")}
        </AppText>
        <AppText>
          {message.recipients.length ? "Asked crew" : "Quiet note"} ·{" "}
          {message.authorThreadId ? threadName(message.authorThreadId) : "You"} ·{" "}
          {message.createdAt}
        </AppText>
        <AppText selectable>{message.text}</AppText>
        {message.recipients.length === 0 ? (
          <AppText>No agent notification requested.</AppText>
        ) : (
          <>
            <AppText>
              Recorded delivery for this message. Delivery does not confirm an answer.
            </AppText>
            {deliveries.map(({ threadId: recipient, delivery }) => (
              <View key={recipient} className="gap-2">
                <AppText>
                  {threadName(recipient)}:{" "}
                  {delivery === null
                    ? "Delivery details are unavailable in the current history window."
                    : delivery.status === "pending"
                      ? "Delivery pending"
                      : delivery.status === "delivered"
                        ? "Delivered; answer not confirmed"
                        : delivery.status === "failed"
                          ? "Delivery failed"
                          : "Delivery cancelled"}
                </AppText>
                {delivery?.status === "failed" && (
                  <>
                    <Button
                      label="Retry this message delivery"
                      disabled={disabled || messageInitiative?.status !== "active"}
                      onPress={() => void act({ type: "delivery.retry", id: delivery.id })}
                    />
                    {messageInitiative?.status !== "active" && (
                      <AppText>
                        Delivery retry requires an active initiative. Resume explicitly before
                        notifying its crew.
                      </AppText>
                    )}
                    {messageInitiative && messageInitiative.status !== "active" && (
                      <Button
                        label="Review this initiative's resume prerequisites"
                        onPress={() => {
                          setSelected(messageInitiative.id);
                          go("recovery");
                        }}
                      />
                    )}
                  </>
                )}
              </View>
            ))}
          </>
        )}
      </View>
    );
  };
  const lastMessage = state?.board.find((message) => message.id === lastMessageId);
  const composer = initiative && (
    <View className="gap-3">
      <AppText className="text-lg font-t3-semibold">Quick response</AppText>
      <View className="flex-row flex-wrap gap-2">
        <Button
          label="Ask crew"
          tone={draft.intent === "ask" ? "primary" : "secondary"}
          onPress={() => setDraft({ ...draft, intent: "ask" })}
        />
        <Button
          label="Save a note"
          tone={draft.intent === "note" ? "primary" : "secondary"}
          onPress={() => setDraft({ ...draft, intent: "note" })}
        />
      </View>
      <AppText>
        {draft.intent === "ask"
          ? "Choose a recipient to request an agent response. Delivery confirms receipt, not an answer."
          : "A quiet project update. Saving a note does not start an agent turn."}
      </AppText>
      <AppTextInput
        accessibilityLabel="Crew message"
        placeholder={
          draft.intent === "ask"
            ? "What do you need from the crew?"
            : "Decision or update to retain"
        }
        value={draft.text}
        onChangeText={(text) => setDraft({ ...draft, text })}
        multiline
        maxLength={12000}
      />
      {draft.intent === "ask" && (
        <>
          {recipients.map((id) => (
            <Button
              key={id}
              label={`${validRecipients.includes(id) ? "✓ " : ""}${id === state?.coordinatorThreadId ? "Coordinator" : (threads.find((thread) => thread.id === id)?.title ?? "Worker")}`}
              tone={validRecipients.includes(id) ? "primary" : "secondary"}
              disabled={disabled || (!validRecipients.includes(id) && validRecipients.length >= 8)}
              onPress={() =>
                setDraft({
                  ...draft,
                  recipients: validRecipients.includes(id)
                    ? validRecipients.filter((recipient) => recipient !== id)
                    : [...validRecipients, id],
                })
              }
            />
          ))}
          {validRecipients.length === 0 && (
            <AppText>Choose at least one current crew recipient.</AppText>
          )}
          {validRecipients.length !== draft.recipients.length && (
            <AppText>
              A previous recipient is no longer assigned. Choose a current recipient before sending.
            </AppText>
          )}
          {initiative.status !== "active" && (
            <>
              <AppText>
                Agents cannot be notified while this initiative is {initiative.status}. Resume or
                approve explicitly first; your draft is retained.
              </AppText>
              <Button label="Review recovery and resume" onPress={() => go("recovery")} />
            </>
          )}
        </>
      )}
      <Button
        label={busy ? "Saving…" : draft.intent === "ask" ? "Send question" : "Save quiet note"}
        disabled={
          disabled ||
          !draft.text.trim() ||
          (draft.intent === "ask" &&
            (initiative.status !== "active" ||
              validRecipients.length === 0 ||
              validRecipients.length !== draft.recipients.length))
        }
        onPress={async () => {
          if (
            disabled ||
            !draft.text.trim() ||
            (draft.intent === "ask" &&
              (initiative.status !== "active" ||
                validRecipients.length === 0 ||
                validRecipients.length !== draft.recipients.length))
          )
            return;
          const submitted = draft;
          const messageId = CommandId.make(uuidv4());
          setLastMessageId(messageId);
          setMessageNotice(
            submitted.intent === "ask"
              ? "Saving question and queueing delivery…"
              : "Saving quiet note…",
          );
          const saved = await act(
            {
              type: "board.post",
              initiativeId: initiative.id,
              text: submitted.text,
              recipients: submitted.intent === "ask" ? validRecipients : [],
            },
            messageId,
          );
          setDraft((current) => mobileCrewDraftAfterSave(current, submitted, saved));
          setMessageNotice(
            saved
              ? submitted.intent === "ask"
                ? "Question saved for delivery. Your draft is retained; delivery is not an answer."
                : "Note saved quietly; no agent turn was started."
              : "Could not confirm the save. Your draft is retained; check the board before retrying.",
          );
        }}
      />
      {draft.intent === "ask" && (
        <>
          <AppText>
            Question text stays here for recovery if delivery fails. Retry the recorded delivery
            instead of sending it twice.
          </AppText>
          <Button label="Clear message draft" onPress={() => setDraft({ ...draft, text: "" })} />
        </>
      )}
      {messageNotice && <AppText accessibilityLiveRegion="polite">{messageNotice}</AppText>}
      {lastMessageId && page !== "board" && (
        <>
          {lastMessage ? (
            renderBoardMessage(lastMessage)
          ) : (
            <AppText>
              This message is not in the current board window. Check messages or history for its
              saved result.
            </AppText>
          )}
          <Button label="View messages and their delivery" onPress={() => go("board")} />
        </>
      )}
    </View>
  );
  const coordinatorPicker = (
    <>
      <AppText>
        {state?.coordinatorThreadId
          ? "Choose a replacement for explicit handover. Selecting a conversation changes no assignments and starts no work."
          : "Choose a project conversation to coordinate this initiative. Selecting it starts no work."}
      </AppText>
      <Menu
        title="Coordinator conversation"
        actions={eligibleThreads.map((thread) => ({
          id: thread.id,
          title: thread.title,
          state: (candidate ?? selection.threadId) === thread.id ? "on" : "off",
        }))}
        onPressAction={({ nativeEvent }) =>
          setCandidate(
            eligibleThreads.find((thread) => thread.id === nativeEvent.event)?.id ?? null,
          )
        }
      >
        <View
          accessible
          accessibilityRole="button"
          accessibilityLabel="Choose coordinator conversation"
          className="rounded-2xl bg-secondary p-4"
        >
          <AppText>
            {handoverCandidate?.title ?? coordinator?.title ?? "Choose coordinator conversation"}
          </AppText>
        </View>
      </Menu>
      {selection.reason && <AppText>{selection.reason}</AppText>}
      {!eligibleThreads.length && (
        <AppText>Start a project conversation before choosing a coordinator.</AppText>
      )}
    </>
  );
  const content = (
    <ScrollView
      ref={scroll}
      key={page}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-5 px-5 pb-10 pt-4"
      keyboardShouldPersistTaps="handled"
      scrollEventThrottle={200}
      onScroll={(event) => {
        scrollPosition.current = event.nativeEvent.contentOffset.y;
      }}
      onContentSizeChange={() => {
        if (state && !restoredScroll.current) {
          restoredScroll.current = true;
          scroll.current?.scrollTo({ y: scrollPosition.current, animated: false });
        }
      }}
    >
      {(error || query.error) && (
        <AppText accessibilityRole="alert" className="text-danger">
          {error ?? query.error}
        </AppText>
      )}
      {freshness !== "current" && (
        <>
          <AppText accessibilityRole="alert">
            {connected
              ? "Refreshing crew facts. Execution is last known until fresh state arrives."
              : "Disconnected. Execution is last known, not confirmed stopped. Reconnect this environment to act."}
          </AppText>
          <Button
            label={connected ? "Refresh crew facts" : "Reconnect environment"}
            onPress={() => {
              if (connected) query.refresh();
              else void retryEnvironment(environmentId);
            }}
          />
        </>
      )}
      {!canEdit && <AppText>Read-only access</AppText>}
      {page !== "overview" && (
        <Button
          label="Crew overview"
          onPress={() => {
            appAtomRegistry.set(crewScrollOffset(projectKey), 0);
            setView("overview");
            navigation.dispatch(
              StackActions.popTo("Crew", { environmentId, projectId, page: "overview" }),
            );
          }}
        />
      )}
      {!state ? (
        <AppText>Loading crew…</AppText>
      ) : (
        <>
          {page === "overview" && (
            <>
              {initiative ? (
                <>
                  <AppText className="text-xl font-t3-semibold">{initiative.title}</AppText>
                  <AppText>{initiative.brief}</AppText>
                  <AppText>
                    Intended state: {initiative.status}
                    {summary?.pause.state !== "not-requested"
                      ? ` · ${summary?.pause.state === "stopping" ? "Stopping workers…" : summary?.pause.state === "failed" ? "Worker stop failed" : summary?.pause.state === "unknown" ? "Stop state unknown" : "Workers stopped"}`
                      : ""}
                  </AppText>
                  {summary && (
                    <AppText>
                      {summary.progress.accepted}/{summary.progress.total} tasks accepted ·{" "}
                      {summary.progress.needingReview} need review ·{" "}
                      {summary.progress.running ?? "Unknown"} running ·{" "}
                      {summary.progress.starting ?? "Unknown"} starting ·{" "}
                      {summary.progress.milestonesAccepted}/{summary.progress.milestonesTotal}{" "}
                      milestones accepted
                    </AppText>
                  )}
                  <AppText className="font-t3-semibold">Next known step</AppText>
                  {summary?.next ? (
                    renderItem(summary.next)
                  ) : (
                    <AppText>
                      {supervision?.clear
                        ? "No outstanding response is recorded."
                        : "The next step is not established. Check crew execution and assignments."}
                    </AppText>
                  )}
                  <View className="flex-row flex-wrap gap-2">
                    {initiative.status === "active" && (
                      <Button
                        label="Pause workers"
                        disabled={disabled}
                        onPress={() =>
                          void act({
                            type: "initiative.status",
                            id: initiative.id,
                            status: "paused",
                          })
                        }
                      />
                    )}
                    {initiative.status === "paused" && (
                      <Button label="Review and resume" onPress={() => go("recovery")} />
                    )}
                    {initiative.status === "draft" && (
                      <Button label="Review plan approval" onPress={() => go("settings")} />
                    )}
                  </View>
                </>
              ) : (
                <>
                  <AppText className="text-xl font-t3-semibold">Start your crew</AppText>
                  <AppText>
                    Describe the outcome and choose a coordinator before starting work.
                  </AppText>
                  {selection.reason && <AppText>{selection.reason}</AppText>}
                  <Button label="Start an initiative" onPress={() => go("setup")} />
                </>
              )}
              <AppText className="text-lg font-t3-semibold">
                Project attention · {supervision?.attention.length ?? 0}
              </AppText>
              {supervision?.attention
                .filter((item) => item.id !== summary?.next?.id)
                .map(renderItem)}
              {supervision?.attention.length === 0 && (
                <AppText>
                  {supervision.clear
                    ? "No response is currently needed."
                    : "Current execution or responsibility is not fully established."}
                </AppText>
              )}
              {composer}
              <AppText className="text-lg font-t3-semibold">Initiatives</AppText>
              {state.initiatives.map((item) => (
                <Button
                  key={item.id}
                  label={`${item.title} · ${item.status}`}
                  tone={item.id === initiative?.id ? "primary" : "secondary"}
                  onPress={() => {
                    setSelected(item.id);
                    setSelectedTask(null);
                    scrollPosition.current = 0;
                    appAtomRegistry.set(crewScrollOffset(projectKey), 0);
                    scroll.current?.scrollTo({ y: 0, animated: false });
                  }}
                />
              ))}
              <View className="flex-row flex-wrap gap-2">
                {(
                  [
                    ["tasks", "Work and review"],
                    ["milestones", "Integrated results"],
                    ["conversations", "Conversations"],
                    ["board", "Messages and delivery"],
                    ["knowledge", "Project knowledge"],
                    ["context", "Received context"],
                    ["settings", "Brief and limits"],
                    ["roles", "Roles"],
                    ["recovery", "Recovery and handover"],
                    ["history", "History and archive"],
                    ["setup", "New initiative"],
                  ] as const
                ).map(([next, label]) => (
                  <Button key={next} label={label} onPress={() => go(next)} />
                ))}
              </View>
              {returnContext && (
                <AppText>
                  Returned from{" "}
                  {threads.find((thread) => thread.id === returnContext.threadId)?.title ??
                    "crew conversation"}
                  . Work selection, filters, and drafts are retained.
                </AppText>
              )}
            </>
          )}
          {page === "setup" && (
            <>
              <AppText className="text-lg font-t3-semibold">Start an initiative</AppText>
              {coordinatorPicker}
              <AppText>
                Coordinator: {coordinator?.title ?? "Not selected"} · Model:{" "}
                {coordinator?.modelSelection.model ?? "Unavailable"}
              </AppText>
              <AppText>
                Execution limits: up to 4 concurrent assignments, 3 attempts and 4 submissions per
                task by default. These are execution limits, not spending limits.
              </AppText>
              <AppText>
                Workers use isolated worktrees by default. The coordinator can explicitly choose a
                shared workspace for an assignment. Coordinator workspace:{" "}
                {coordinator?.worktreePath ?? project?.workspaceRoot ?? "Unavailable"}.
              </AppText>
              <AppTextInput
                accessibilityLabel="Initiative brief"
                placeholder="Goal and acceptance criteria"
                value={brief}
                onChangeText={setBrief}
                multiline
                maxLength={12000}
              />
              <AppTextInput
                accessibilityLabel="Initiative title"
                placeholder="Suggested from your brief"
                value={title}
                onChangeText={setTitle}
                maxLength={160}
              />
              <Button label="Restore suggested title" onPress={() => setTitle(null)} />
              <View className="flex-row flex-wrap gap-2">
                <Button
                  label="Start now"
                  tone={mode === "swarm" ? "primary" : "secondary"}
                  onPress={() => setMode("swarm")}
                />
                <Button
                  label="Require plan approval"
                  tone={mode === "teamwork" ? "primary" : "secondary"}
                  onPress={() => setMode("teamwork")}
                />
              </View>
              {!state.coordinatorThreadId && (
                <Button
                  label="Confirm selected coordinator"
                  disabled={disabled || !selection.threadId || !!selection.reason}
                  onPress={() =>
                    selection.threadId &&
                    void act({ type: "coordinator.set", threadId: selection.threadId })
                  }
                />
              )}
              <Button
                label={mode === "swarm" ? "Start initiative now" : "Create for plan approval"}
                disabled={
                  disabled ||
                  !state.coordinatorThreadId ||
                  !!selection.reason ||
                  !title.trim() ||
                  !brief.trim()
                }
                onPress={async () => {
                  const id = uuidv4();
                  if (await act({ type: "initiative.create", id, title, brief, mode })) {
                    setSelected(id);
                    setBrief("");
                    setTitle(null);
                    go("overview");
                  }
                }}
              />
            </>
          )}
          {page === "settings" && initiative && (
            <>
              <AppText className="text-lg font-t3-semibold">Brief and execution limits</AppText>
              <TeamworkBriefEditor
                key={`${initiative.id}:${initiative.updatedAt}`}
                initiative={initiative}
                supportsDependencies={supports("submissions")}
                disabled={disabled}
                act={act}
              />
              {initiative.status === "draft" && (
                <Button
                  label="Approve brief and start"
                  disabled={disabled || !state.coordinatorThreadId}
                  onPress={() => void act({ type: "initiative.approve", id: initiative.id })}
                />
              )}
              {initiative.status === "draft" &&
                resumeBlockers.map((item) => (
                  <AppText key={JSON.stringify(item)}>{prerequisiteText(item)}</AppText>
                ))}
              {initiative.mode === "swarm" && (
                <Button
                  label="Require plan approval"
                  disabled={disabled}
                  onPress={() =>
                    void act({
                      type: "initiative.edit",
                      id: initiative.id,
                      title: initiative.title,
                      brief: initiative.brief,
                      mode: "teamwork",
                    })
                  }
                />
              )}
              {supports("submissions") && (
                <CrewLimits
                  key={`${initiative.id}:${JSON.stringify(initiative.policy)}`}
                  initiative={initiative}
                  disabled={disabled}
                  act={act}
                />
              )}
              <AppText>
                These limits control execution attempts and concurrency, not spending.
              </AppText>
              <AppText>{crewDeliveryNotice}</AppText>
              {initiative.status === "active" && (
                <Button
                  label="Complete initiative"
                  disabled={disabled}
                  onPress={() =>
                    void act({ type: "initiative.status", id: initiative.id, status: "completed" })
                  }
                />
              )}
              {!["completed", "cancelled"].includes(initiative.status) && (
                <Button
                  label="Cancel initiative"
                  tone="danger"
                  disabled={disabled}
                  onPress={() =>
                    void act({ type: "initiative.status", id: initiative.id, status: "cancelled" })
                  }
                />
              )}
              {supports("archive") && ["completed", "cancelled"].includes(initiative.status) && (
                <Button
                  label="Archive initiative"
                  disabled={disabled}
                  onPress={() => void act({ type: "initiative.archive", id: initiative.id })}
                />
              )}
            </>
          )}
          {page === "tasks" && initiative && (
            <>
              <AppText className="text-lg font-t3-semibold">Work and review</AppText>
              <AppTextInput
                accessibilityLabel="Filter crew work"
                placeholder="Search work"
                value={filters.query}
                onChangeText={(query) => setFilters({ ...filters, query })}
              />
              <Menu
                title="Task acceptance status"
                actions={[
                  "all",
                  "ready",
                  "delegating",
                  "running",
                  "blocked",
                  "review",
                  "done",
                  "cancelled",
                ].map((status) => ({
                  id: status,
                  title: status,
                  state: (filters.status ?? "all") === status ? "on" : "off",
                }))}
                onPressAction={({ nativeEvent }) =>
                  setFilters({
                    ...filters,
                    status: nativeEvent.event === "all" ? null : nativeEvent.event,
                  })
                }
              >
                <View accessible accessibilityRole="button" className="p-3">
                  <AppText>Acceptance: {filters.status ?? "all"}</AppText>
                </View>
              </Menu>
              <Menu
                title="Assigned conversation"
                actions={[
                  {
                    id: "all",
                    title: "All owners",
                    state: filters.ownerThreadId === null ? "on" : "off",
                  },
                  ...threads.map((thread) => ({
                    id: thread.id,
                    title: thread.title,
                    state: filters.ownerThreadId === thread.id ? ("on" as const) : ("off" as const),
                  })),
                ]}
                onPressAction={({ nativeEvent }) =>
                  setFilters({
                    ...filters,
                    ownerThreadId:
                      threads.find((thread) => thread.id === nativeEvent.event)?.id ?? null,
                  })
                }
              >
                <View accessible accessibilityRole="button" className="p-3">
                  <AppText>
                    Owner:{" "}
                    {threads.find((thread) => thread.id === filters.ownerThreadId)?.title ?? "all"}
                  </AppText>
                </View>
              </Menu>
              {state.tasks
                .filter(
                  (task) =>
                    task.initiativeId === initiative.id &&
                    (!filters.status || task.status === filters.status) &&
                    (!filters.ownerThreadId || task.ownerThreadId === filters.ownerThreadId) &&
                    `${task.title} ${task.brief}`
                      .toLowerCase()
                      .includes(filters.query.toLowerCase()),
                )
                .map((task) => (
                  <View key={task.id} className="gap-2 rounded-2xl bg-secondary p-4">
                    <AppText className="font-t3-semibold">
                      {task.title} · Acceptance: {task.status}
                    </AppText>
                    {supervision?.items.filter((item) => item.taskId === task.id).map(renderItem)}
                    <Button
                      label="Open work details"
                      onPress={() => {
                        setSelectedTask(task.id);
                        go("task");
                      }}
                    />
                  </View>
                ))}
              <Button
                label="Add work"
                disabled={disabled}
                onPress={() => {
                  setSelectedTask(null);
                  go("task-edit");
                }}
              />
            </>
          )}
          {page === "task" &&
            (task ? (
              <>
                <AppText className="text-lg font-t3-semibold">{task.title}</AppText>
                <AppText>Task acceptance: {task.status}</AppText>
                <AppText>{task.brief}</AppText>
                <AppText>Accept when: {task.criteria}</AppText>
                {supervision?.items.filter((item) => item.taskId === task.id).map(renderItem)}
                {task.ownerThreadId && (
                  <Button
                    label="Open worker conversation"
                    disabled={!canReadThreads}
                    onPress={() => openThread(task.ownerThreadId!)}
                  />
                )}
                <CrewTaskArtifact
                  key={`artifact:${task.id}:${task.submission?.revision}`}
                  task={task}
                  environmentId={environmentId}
                  projectId={projectId}
                  artifactsEnabled={supports("artifacts")}
                  onOpenContent={contentOpener(task.submission?.threadId ?? task.ownerThreadId)}
                />
                {task.evidence && <AppText selectable>{task.evidence}</AppText>}
                {task.status === "review" && (
                  <Review
                    key={`review:${task.id}:${task.submission?.revision}`}
                    disabled={disabled || (supports("submissions") && !task.submission)}
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
                <Button label="Received context and omissions" onPress={() => go("context")} />
                <Button label="Recovery and replacement" onPress={() => go("recovery")} />
                {["ready", "cancelled"].includes(task.status) && (
                  <Button label="Edit work" disabled={disabled} onPress={() => go("task-edit")} />
                )}
              </>
            ) : (
              <AppText>This task is unavailable. Return to work to choose a current task.</AppText>
            ))}
          {page === "task-edit" && initiative && (
            <TeamworkTaskEditor
              key={`${initiative.id}:${task?.id}:${task?.updatedAt}`}
              state={state}
              initiativeId={initiative.id}
              existing={task}
              disabled={disabled}
              act={act}
            />
          )}
          {page === "milestones" && initiative && (
            <>
              <AppText className="text-lg font-t3-semibold">Integrated results</AppText>
              <AppText>{crewDeliveryNotice}</AppText>
              {initiative.milestones.length === 0 && (
                <AppText>No milestones yet. Add one under Brief and limits.</AppText>
              )}
              {initiative.milestones.map((milestone) => (
                <CrewMilestone
                  key={`${initiative.id}:${milestone.id}:${milestone.accepted}:${milestone.verification?.createdAt}`}
                  initiative={initiative}
                  milestone={milestone}
                  disabled={disabled}
                  requiresVerification={supports("submissions")}
                  tasks={state.tasks.filter((task) => task.initiativeId === initiative.id)}
                  environmentId={environmentId}
                  projectId={projectId}
                  artifactsEnabled={supports("artifacts")}
                  onOpenContent={contentOpener(milestone.verification?.threadId ?? null)}
                  act={act}
                />
              ))}
            </>
          )}
          {page === "conversations" && (
            <>
              <AppText className="text-lg font-t3-semibold">Conversations</AppText>
              {state.coordinatorThreadId && (
                <Button
                  label="Project coordinator"
                  disabled={!canReadThreads}
                  onPress={() => openThread(state.coordinatorThreadId!)}
                />
              )}
              {state.tasks
                .filter((task) => task.initiativeId === initiative?.id && task.ownerThreadId)
                .map((task) => (
                  <Button
                    key={task.id}
                    label={task.title}
                    disabled={!canReadThreads}
                    onPress={() => {
                      setSelectedTask(task.id);
                      openThread(task.ownerThreadId!);
                    }}
                  />
                ))}
            </>
          )}
          {page === "board" && (
            <>
              <AppText className="text-lg font-t3-semibold">Messages and delivery</AppText>
              {composer}
              {state.board
                .filter(
                  (message) =>
                    message.initiativeId === initiative?.id || message.initiativeId === null,
                )
                .reverse()
                .map(renderBoardMessage)}
            </>
          )}
          {page === "knowledge" && (
            <>
              <AppText className="text-lg font-t3-semibold">Project knowledge</AppText>
              <AppText>
                Corrections affect future context. They do not rewrite context already received by
                workers.
              </AppText>
              {state.knowledge.map((entry) => (
                <View key={entry.id} className="gap-2 rounded-2xl bg-secondary p-4">
                  <AppText className="font-t3-semibold">{entry.title}</AppText>
                  <AppText selectable>{entry.text}</AppText>
                  <Button
                    label="Correct knowledge"
                    disabled={disabled}
                    onPress={() => {
                      setKnowledgeId(entry.id);
                      setKnowledgeTitle(entry.title);
                      setKnowledgeText(entry.text);
                    }}
                  />
                  <Button
                    label="Forget knowledge"
                    disabled={disabled}
                    onPress={() => void act({ type: "knowledge.forget", id: entry.id })}
                  />
                </View>
              ))}
              <AppTextInput
                accessibilityLabel="Knowledge title"
                placeholder="Knowledge title"
                value={knowledgeTitle}
                onChangeText={setKnowledgeTitle}
                maxLength={160}
              />
              <AppTextInput
                accessibilityLabel="Knowledge text"
                placeholder="Fact or decision"
                value={knowledgeText}
                onChangeText={setKnowledgeText}
                multiline
                maxLength={12000}
              />
              <Button
                label={knowledgeId ? "Save correction" : "Remember"}
                disabled={disabled || !knowledgeTitle.trim() || !knowledgeText.trim()}
                onPress={async () => {
                  if (
                    await act({
                      type: "knowledge.save",
                      id: knowledgeId ?? uuidv4(),
                      title: knowledgeTitle,
                      text: knowledgeText,
                      sourceTaskId: null,
                    })
                  ) {
                    setKnowledgeId(null);
                    setKnowledgeTitle("");
                    setKnowledgeText("");
                  }
                }}
              />
              {knowledgeId && (
                <Button
                  label="Cancel correction"
                  onPress={() => {
                    setKnowledgeId(null);
                    setKnowledgeTitle("");
                    setKnowledgeText("");
                  }}
                />
              )}
            </>
          )}
          {page === "context" &&
            (supports("context") ? (
              <CrewContextView
                key={task?.ownerThreadId ?? state.coordinatorThreadId}
                environmentId={environmentId}
                state={state}
                initialThreadId={task?.ownerThreadId}
                preview={query.data?.context ?? null}
                onOpenThread={openThread}
              />
            ) : (
              <AppText>This environment does not expose delivered context.</AppText>
            ))}
          {page === "roles" && (
            <TeamworkRoles
              state={state}
              environmentId={environmentId}
              disabled={disabled}
              act={act}
            />
          )}
          {page === "history" && (
            <CrewHistory
              environmentId={environmentId}
              projectId={projectId}
              revision={state.revision}
              archiveEnabled={supports("archive")}
              artifactsEnabled={supports("artifacts")}
              disabled={disabled}
              act={act}
              onOpenThread={openThread}
            />
          )}
          {page === "recovery" && (
            <>
              <AppText className="text-lg font-t3-semibold">Recovery and handover</AppText>
              {supervision?.attention
                .filter(
                  (item) => item.initiativeId === initiative?.id || item.initiativeId === null,
                )
                .map(renderItem)}
              {initiative && (
                <>
                  <AppText>
                    {initiative.title} · {initiative.status}
                  </AppText>
                  <AppText>
                    Pause progress:{" "}
                    {summary?.pause.state === "stopping"
                      ? "Stopping workers…"
                      : (summary?.pause.state ?? "unknown")}
                  </AppText>
                  {initiative.status === "active" && (
                    <Button
                      label="Pause initiative workers"
                      disabled={disabled}
                      onPress={() =>
                        void act({ type: "initiative.status", id: initiative.id, status: "paused" })
                      }
                    />
                  )}
                  {["paused", "completed", "cancelled"].includes(initiative.status) && (
                    <>
                      <AppText>Before resuming:</AppText>
                      {summary?.resume.prerequisites.map((item) => (
                        <AppText key={JSON.stringify(item)}>{prerequisiteText(item)}</AppText>
                      ))}
                      <AppText>
                        The server verifies current execution and outstanding stops when you
                        confirm. Unmet prerequisites leave the initiative unchanged.
                      </AppText>
                      <Button
                        label={
                          initiative.status === "paused"
                            ? "Resume initiative explicitly"
                            : "Reopen initiative explicitly"
                        }
                        disabled={disabled || !initiative.approved || !state.coordinatorThreadId}
                        onPress={() =>
                          void act({
                            type: "initiative.status",
                            id: initiative.id,
                            status: "active",
                          })
                        }
                      />
                      {!initiative.approved && (
                        <Button label="Review plan approval" onPress={() => go("settings")} />
                      )}
                    </>
                  )}
                </>
              )}
              {task && (
                <>
                  <AppText className="font-t3-semibold">Assignment recovery · {task.title}</AppText>
                  <AppText>
                    Reset requests a worker stop and clears this assignment. Replacement waits for
                    confirmed stopping and accepted dependencies. A new attempt needs a new
                    submission and independent review; the server validates these transitions.
                  </AppText>
                  <Button
                    label="Stop and reset assignment to ready"
                    disabled={disabled}
                    onPress={() => void act({ type: "task.reset", id: task.id, status: "ready" })}
                  />
                  <Button
                    label="Cancel assignment"
                    tone="danger"
                    disabled={disabled}
                    onPress={() =>
                      void act({ type: "task.reset", id: task.id, status: "cancelled" })
                    }
                  />
                </>
              )}
              <AppText className="font-t3-semibold">Project coordinator handover</AppText>
              <AppText>
                Assignments, submissions, reviews, and history are retained. Paused initiatives
                resume only when you explicitly resume them.
              </AppText>
              {state.coordinatorThreadId && (
                <>
                  <Button
                    label="Open coordinator conversation"
                    disabled={!canReadThreads}
                    onPress={() => openThread(state.coordinatorThreadId!)}
                  />
                  <Button
                    label="Pause entire crew for handover"
                    disabled={disabled || !supports("context")}
                    onPress={() => void act({ type: "coordinator.pause" })}
                  />
                </>
              )}
              {supervision?.handover.prerequisites.map((item) => (
                <AppText key={JSON.stringify(item)}>{prerequisiteText(item)}</AppText>
              ))}
              <AppText>
                The server checks these prerequisites when you confirm. Pending or failed stops must
                be resolved before handover.
              </AppText>
              {coordinatorPicker}
              <Button
                label={
                  state.coordinatorThreadId ? "Confirm coordinator handover" : "Confirm coordinator"
                }
                disabled={
                  disabled ||
                  !replacementCoordinator ||
                  replacementCoordinator.id === state.coordinatorThreadId
                }
                onPress={() =>
                  replacementCoordinator &&
                  void act({ type: "coordinator.set", threadId: replacementCoordinator.id })
                }
              />
            </>
          )}
        </>
      )}
    </ScrollView>
  );
  return embedded ? (
    content
  ) : (
    <Sheet title="Project crew" onClose={onClose}>
      {content}
    </Sheet>
  );
}

function Review({
  disabled,
  onReview,
}: {
  disabled: boolean;
  onReview: (decision: "approve" | "changes", evidence: string) => Promise<boolean>;
}) {
  const [evidence, setEvidence] = useState("");
  return (
    <View className="gap-2">
      <AppTextInput
        accessibilityLabel="Review evidence"
        placeholder="What did you independently verify?"
        value={evidence}
        onChangeText={setEvidence}
        multiline
        maxLength={12000}
      />
      <View className="flex-row flex-wrap gap-2">
        <Button
          label="Approve result"
          disabled={disabled || !evidence.trim()}
          onPress={() => void onReview("approve", evidence)}
        />
        <Button
          label="Request changes"
          disabled={disabled || !evidence.trim()}
          onPress={() => void onReview("changes", evidence)}
        />
      </View>
    </View>
  );
}
