import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { crewDraftBrief, crewSelectedInitiative } from "@t3tools/client-runtime/state/crew";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import { StackActions, useNavigation } from "@react-navigation/native";
import {
  CommandId,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  type TeamworkAction,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AppText, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Sheet } from "../../components/ui/Sheet";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentShellReadiness } from "../../state/shell";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 } from "../../lib/uuid";
import { TeamworkBriefEditor, TeamworkRoles, TeamworkTaskEditor } from "./TeamworkEditors";
import { CrewWorkerStatus } from "./CrewWorkerStatus";
import { CrewHistory } from "./CrewHistory";
import { CrewContextView } from "./CrewContextView";
import { CrewArtifactStatus, CrewLimits, CrewMilestone } from "./CrewVerification";
import { threadFamilies } from "../../state/threads";
import { appAtomRegistry } from "../../state/atom-registry";

export interface TeamworkTarget {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId | null;
}
export function TeamworkSheet({
  target,
  onClose,
  embedded = false,
}: {
  target: TeamworkTarget;
  onClose: () => void;
  embedded?: boolean;
}) {
  const { environmentId, projectId, threadId } = target;
  const query = useEnvironmentQuery(
    serverEnvironment.teamworkLive({ environmentId, input: { projectId } }),
  );
  const canEdit = useAtomValue(serverEnvironment.mutateTeamwork.permissionAtom(environmentId));
  const connected = useEnvironmentShellReadiness(environmentId).status === "live";
  const mutation = useAtomCommand(serverEnvironment.mutateTeamwork, { reportFailure: false });
  const navigation = useNavigation();
  const [selected, setSelected] = useAtom(crewSelectedInitiative(scopedProjectKey(target)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useAtom(crewDraftBrief(scopedProjectKey(target)));
  const [mode, setMode] = useState<"swarm" | "teamwork">("swarm");
  const [message, setMessage] = useState("");
  const [recipients, setRecipients] = useState<readonly ThreadId[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [knowledgeId, setKnowledgeId] = useState<string | null>(null);
  const [knowledgeTitle, setKnowledgeTitle] = useState("");
  const [knowledgeText, setKnowledgeText] = useState("");
  const state = query.data?.snapshot;
  const coordinatorThreadId = state?.coordinatorThreadId;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Retain the coordinator's worker shells while its Crew view is open.
  useEffect(() => {
    if (coordinatorThreadId == null) return;
    return threadFamilies.mount(appAtomRegistry, environmentId, coordinatorThreadId);
  }, [environmentId, coordinatorThreadId]);
  const initiative = state?.initiatives.find((i) => i.id === selected) ?? state?.initiatives.at(-1);
  const act = async (action: TeamworkAction) => {
    if (!state || busy || !canEdit || !connected) return false;
    setBusy(true);
    setError(null);
    const result = await mutation({
      environmentId,
      input: {
        projectId,
        commandId: CommandId.make(uuidv4()),
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
  const openThread = (id: ThreadId) => {
    if (!embedded) onClose();
    navigation.dispatch(StackActions.push("Thread", { environmentId, threadId: id }));
  };
  const disabled = busy || !canEdit || !connected;
  const content = (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-5 px-5 pb-10 pt-4"
      keyboardShouldPersistTaps="handled"
    >
      {(error || query.error) && (
        <AppText accessibilityRole="alert" className="text-danger">
          {error ?? query.error}
        </AppText>
      )}
      {!state ? (
        <AppText>Loading crew…</AppText>
      ) : (
        <>
          {!connected && (
            <AppText>
              Disconnected. Crew changes will be available when this environment reconnects.
            </AppText>
          )}
          {!canEdit && <AppText>Read-only access</AppText>}
          <AppText className="text-lg font-t3-semibold">Project coordinator</AppText>
          {state.coordinatorThreadId && (
            <Button
              label="Open coordinator"
              onPress={() => openThread(state.coordinatorThreadId!)}
            />
          )}
          {!embedded && (
            <Button
              label="Open workspace"
              onPress={() => {
                onClose();
                navigation.navigate("Crew", { environmentId, projectId });
              }}
            />
          )}
          {threadId !== null && state.coordinatorThreadId !== threadId && (
            <Button
              label="Use this thread as coordinator"
              disabled={disabled}
              onPress={() => void act({ type: "coordinator.set", threadId })}
            />
          )}
          <AppText className="text-lg font-t3-semibold">Start an initiative</AppText>
          {state.coordinatorThreadId && query.data?.capabilities?.includes("context") && (
            <>
              <Button
                label="Pause crew for handover"
                disabled={disabled}
                onPress={() => void act({ type: "coordinator.pause" })}
              />
              <AppText>
                After the crew stops, choose a fresh coordinator conversation. Assignments and
                reviews are retained; resume initiatives explicitly.
              </AppText>
            </>
          )}
          <AppTextInput
            accessibilityLabel="Initiative title"
            placeholder="Outcome"
            value={title}
            onChangeText={setTitle}
            maxLength={160}
          />
          <AppTextInput
            accessibilityLabel="Initiative brief"
            placeholder="Brief and acceptance criteria"
            value={brief}
            onChangeText={setBrief}
            multiline
            maxLength={12000}
          />
          <View className="flex-row flex-wrap gap-2">
            <Button
              label="Swarm: start now"
              tone={mode === "swarm" ? "primary" : "secondary"}
              onPress={() => setMode("swarm")}
            />
            <Button
              label="Require plan approval"
              tone={mode === "teamwork" ? "primary" : "secondary"}
              onPress={() => setMode("teamwork")}
            />
          </View>
          <Button
            label="Create initiative"
            disabled={disabled || !state.coordinatorThreadId || !title.trim() || !brief.trim()}
            onPress={async () => {
              const id = uuidv4();
              if (await act({ type: "initiative.create", id, title, brief, mode })) {
                setSelected(id);
                setTitle("");
                setBrief("");
              }
            }}
          />
          <View className="flex-row flex-wrap gap-2">
            {state.initiatives.map((i) => (
              <Button
                key={i.id}
                label={`${i.title} · ${i.status}`}
                tone={initiative?.id === i.id ? "primary" : "secondary"}
                onPress={() => setSelected(i.id)}
              />
            ))}
          </View>
          {initiative && (
            <>
              <AppText className="text-lg font-t3-semibold">{initiative.title}</AppText>
              <AppText>{initiative.brief}</AppText>
              <TeamworkBriefEditor
                key={`${initiative.id}:${initiative.updatedAt}`}
                initiative={initiative}
                supportsDependencies={query.data?.capabilities?.includes("submissions") ?? false}
                disabled={disabled}
                act={act}
              />
              <View className="flex-row flex-wrap gap-2">
                {initiative.status === "draft" && (
                  <Button
                    label="Approve brief and start"
                    disabled={disabled}
                    onPress={() => void act({ type: "initiative.approve", id: initiative.id })}
                  />
                )}
                {initiative.status === "active" && (
                  <>
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
                    <Button
                      label="Complete"
                      disabled={disabled}
                      onPress={() =>
                        void act({
                          type: "initiative.status",
                          id: initiative.id,
                          status: "completed",
                        })
                      }
                    />
                  </>
                )}
                {["paused", "completed", "cancelled"].includes(initiative.status) && (
                  <Button
                    label={initiative.status === "paused" ? "Resume" : "Reopen"}
                    disabled={disabled || !initiative.approved}
                    onPress={() =>
                      void act({ type: "initiative.status", id: initiative.id, status: "active" })
                    }
                  />
                )}
                {query.data?.capabilities?.includes("archive") &&
                  ["completed", "cancelled"].includes(initiative.status) && (
                    <Button
                      label="Archive initiative"
                      disabled={disabled}
                      onPress={() => void act({ type: "initiative.archive", id: initiative.id })}
                    />
                  )}
                {!["completed", "cancelled"].includes(initiative.status) && (
                  <Button
                    label="Cancel initiative"
                    tone="danger"
                    disabled={disabled}
                    onPress={() =>
                      void act({
                        type: "initiative.status",
                        id: initiative.id,
                        status: "cancelled",
                      })
                    }
                  />
                )}
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
              </View>
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
              <AppText className="text-lg font-t3-semibold">Tasks</AppText>
              {state.tasks
                .filter((t) => t.initiativeId === initiative.id)
                .map((task) => (
                  <View key={task.id} className="gap-3 rounded-2xl bg-secondary p-4">
                    <AppText className="font-t3-semibold">
                      {task.title} · {task.status}
                    </AppText>
                    <AppText>{task.brief}</AppText>
                    <AppText>Accept when: {task.criteria}</AppText>
                    <CrewWorkerStatus environmentId={environmentId} task={task} />
                    {task.ownerThreadId && (
                      <Button label="Open worker" onPress={() => openThread(task.ownerThreadId!)} />
                    )}
                    {task.evidence && <AppText>{task.evidence}</AppText>}
                    {task.review && <AppText>Review: {task.review.evidence}</AppText>}
                    {task.submission && (
                      <AppText>
                        Submission {task.submission.revision} · {task.submission.artifact.kind}{" "}
                        {task.submission.artifact.ref}
                      </AppText>
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
                        <AppText>
                          Ask the worker to resubmit an immutable artifact before reviewing this
                          older result.
                        </AppText>
                      )}
                    {task.status === "review" && (
                      <Review
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
                    <View className="flex-row flex-wrap gap-2">
                      <Button
                        label="Reset assignment"
                        disabled={disabled}
                        onPress={() =>
                          void act({ type: "task.reset", id: task.id, status: "ready" })
                        }
                      />
                      <Button
                        label="Cancel task"
                        disabled={disabled}
                        onPress={() =>
                          void act({ type: "task.reset", id: task.id, status: "cancelled" })
                        }
                      />
                    </View>
                    {["ready", "cancelled"].includes(task.status) && (
                      <TeamworkTaskEditor
                        key={`${task.id}:${task.updatedAt}`}
                        state={state}
                        initiativeId={initiative.id}
                        existing={task}
                        disabled={disabled}
                        act={act}
                      />
                    )}
                  </View>
                ))}
              <TeamworkTaskEditor
                key={initiative.id}
                state={state}
                initiativeId={initiative.id}
                disabled={disabled}
                act={act}
              />
              <AppText className="text-lg font-t3-semibold">Conversations</AppText>
              {state.coordinatorThreadId && (
                <Button
                  label="Coordinator conversation"
                  onPress={() => openThread(state.coordinatorThreadId!)}
                />
              )}
              {state.tasks
                .filter((t) => t.initiativeId === initiative.id && t.ownerThreadId)
                .map((task) => (
                  <Button
                    key={task.id}
                    label={`${state.roles.find((r) => r.id === task.roleId)?.name ?? "Worker"}: ${task.title}`}
                    onPress={() => openThread(task.ownerThreadId!)}
                  />
                ))}
              <AppText className="text-lg font-t3-semibold">Team board</AppText>
              {state.board
                .filter((b) => b.initiativeId === initiative.id)
                .map((b) => (
                  <View key={b.id} className="gap-1">
                    <AppText className="text-sm text-foreground-muted">
                      {b.authorThreadId === null
                        ? "You"
                        : b.authorThreadId === state.coordinatorThreadId
                          ? "Coordinator"
                          : "Worker"}
                    </AppText>
                    <AppText>{b.text}</AppText>
                  </View>
                ))}
              <AppTextInput
                accessibilityLabel="Team message"
                placeholder="Update, decision, or question"
                value={message}
                onChangeText={setMessage}
                multiline
                maxLength={12000}
              />
              <View className="flex-row flex-wrap gap-2">
                {[
                  ...(state.coordinatorThreadId
                    ? [{ id: state.coordinatorThreadId, label: "Coordinator" }]
                    : []),
                  ...state.tasks
                    .filter(
                      (t) =>
                        t.initiativeId === initiative.id &&
                        t.ownerThreadId &&
                        !["done", "cancelled"].includes(t.status),
                    )
                    .map((t) => ({ id: t.ownerThreadId!, label: t.title })),
                ].map((member) => (
                  <Button
                    key={member.id}
                    label={`${recipients.includes(member.id) ? "Notify: " : "Notify "}${member.label}`}
                    tone={recipients.includes(member.id) ? "primary" : "secondary"}
                    disabled={
                      disabled ||
                      initiative.status !== "active" ||
                      (!recipients.includes(member.id) && recipients.length >= 8)
                    }
                    onPress={() =>
                      setRecipients((current) =>
                        current.includes(member.id)
                          ? current.filter((id) => id !== member.id)
                          : [...current, member.id],
                      )
                    }
                  />
                ))}
                <Button
                  label="Post update"
                  disabled={disabled || !message.trim()}
                  onPress={async () => {
                    if (
                      await act({
                        type: "board.post",
                        initiativeId: initiative.id,
                        text: message,
                        recipients:
                          initiative.status === "active"
                            ? recipients.filter(
                                (id) =>
                                  id === state.coordinatorThreadId ||
                                  state.tasks.some(
                                    (t) =>
                                      t.initiativeId === initiative.id &&
                                      t.ownerThreadId === id &&
                                      !["done", "cancelled"].includes(t.status),
                                  ),
                              )
                            : [],
                      })
                    )
                      setMessage("");
                  }}
                />
                <Button
                  label="Ask coordinator"
                  disabled={disabled || !message.trim() || initiative.status !== "active"}
                  onPress={async () => {
                    if (
                      await act({
                        type: "board.post",
                        initiativeId: initiative.id,
                        text: message,
                        recipients: state.coordinatorThreadId ? [state.coordinatorThreadId] : [],
                      })
                    )
                      setMessage("");
                  }}
                />
              </View>
            </>
          )}
          <AppText className="text-lg font-t3-semibold">Project knowledge</AppText>
          {query.data?.capabilities?.includes("context") && (
            <>
              <Button
                label={showContext ? "Hide project context" : "Inspect project context"}
                onPress={() => setShowContext(!showContext)}
              />
              {showContext && (
                <CrewContextView
                  environmentId={environmentId}
                  state={state}
                  preview={query.data.context ?? null}
                  onOpenThread={openThread}
                />
              )}
            </>
          )}
          <Button
            label={showHistory ? "Hide history" : "Show history and archive"}
            onPress={() => setShowHistory(!showHistory)}
          />
          {showHistory && (
            <CrewHistory
              environmentId={environmentId}
              projectId={projectId}
              revision={state.revision}
              archiveEnabled={query.data?.capabilities?.includes("archive") ?? false}
              artifactsEnabled={query.data?.capabilities?.includes("artifacts") ?? false}
              disabled={disabled}
              act={act}
              onOpenThread={openThread}
            />
          )}
          <TeamworkRoles
            state={state}
            environmentId={environmentId}
            disabled={disabled}
            act={act}
          />
          {state.knowledge.map((k) => (
            <View key={k.id} className="gap-2 rounded-2xl bg-secondary p-4">
              <AppText className="font-t3-semibold">{k.title}</AppText>
              <AppText>{k.text}</AppText>
              <View className="flex-row gap-2">
                <Button
                  label="Correct"
                  disabled={disabled}
                  onPress={() => {
                    setKnowledgeId(k.id);
                    setKnowledgeTitle(k.title);
                    setKnowledgeText(k.text);
                  }}
                />
                <Button
                  label="Forget"
                  disabled={disabled}
                  onPress={() => void act({ type: "knowledge.forget", id: k.id })}
                />
              </View>
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
            placeholder="A fact or decision to retain"
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
          {query.data?.deliveries
            .filter((d) => d.status === "failed")
            .map((d) => (
              <Button
                key={d.id}
                label={`Retry failed ${d.kind}`}
                disabled={disabled}
                onPress={() => void act({ type: "delivery.retry", id: d.id })}
              />
            ))}
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
