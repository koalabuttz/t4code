import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { useAtomValue } from "@effect/atom-react";
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
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 } from "../../lib/uuid";
import { TeamworkBriefEditor, TeamworkRoles, TeamworkTaskEditor } from "./TeamworkEditors";
import { CrewWorkerStatus } from "./CrewWorkerStatus";
import { threadFamilies } from "../../state/threads";
import { appAtomRegistry } from "../../state/atom-registry";

export interface TeamworkTarget {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId;
}
export function TeamworkSheet({
  target,
  onClose,
}: {
  target: TeamworkTarget;
  onClose: () => void;
}) {
  const { environmentId, projectId, threadId } = target;
  const query = useEnvironmentQuery(
    serverEnvironment.teamworkLive({ environmentId, input: { projectId } }),
  );
  const canEdit = useAtomValue(serverEnvironment.mutateTeamwork.permissionAtom(environmentId));
  const mutation = useAtomCommand(serverEnvironment.mutateTeamwork, { reportFailure: false });
  const navigation = useNavigation();
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [mode, setMode] = useState<"swarm" | "teamwork">("swarm");
  const [message, setMessage] = useState("");
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
    if (!state || busy || !canEdit) return false;
    setBusy(true);
    setError(null);
    try {
      const result = await mutation({
        environmentId,
        input: {
          projectId,
          commandId: CommandId.make(uuidv4()),
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
  const openThread = (id: ThreadId) => {
    onClose();
    navigation.dispatch(StackActions.push("Thread", { environmentId, threadId: id }));
  };
  const disabled = busy || !canEdit;
  return (
    <Sheet title="Project crew" onClose={onClose}>
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
            {!canEdit && <AppText>Read-only access</AppText>}
            <AppText className="text-lg font-t3-semibold">Project coordinator</AppText>
            {state.coordinatorThreadId && (
              <Button
                label="Open coordinator"
                onPress={() => openThread(state.coordinatorThreadId!)}
              />
            )}
            {state.coordinatorThreadId !== threadId && (
              <Button
                label="Use this thread as coordinator"
                disabled={disabled}
                onPress={() => void act({ type: "coordinator.set", threadId })}
              />
            )}
            <AppText className="text-lg font-t3-semibold">Start an initiative</AppText>
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
                {initiative.milestones.map((m) => (
                  <View key={m.id} className="gap-2 rounded-2xl bg-secondary p-4">
                    <AppText className="font-t3-semibold">{m.title}</AppText>
                    <AppText>{m.criteria}</AppText>
                    <Button
                      label={m.accepted ? "Reopen milestone" : "Accept milestone"}
                      disabled={disabled}
                      onPress={() =>
                        void act({
                          type: "milestone.accept",
                          initiativeId: initiative.id,
                          id: m.id,
                          accepted: !m.accepted,
                        })
                      }
                    />
                  </View>
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
                        <Button
                          label="Open worker"
                          onPress={() => openThread(task.ownerThreadId!)}
                        />
                      )}
                      {task.evidence && <AppText>{task.evidence}</AppText>}
                      {task.review && <AppText>Review: {task.review.evidence}</AppText>}
                      {task.status === "review" && (
                        <Review
                          disabled={disabled}
                          onReview={(decision, evidence) =>
                            act({ type: "task.review", id: task.id, decision, evidence })
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
                      {!["delegating", "running"].includes(task.status) && (
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
                  <Button
                    label="Post update"
                    disabled={disabled || !message.trim()}
                    onPress={async () => {
                      if (
                        await act({
                          type: "board.post",
                          initiativeId: initiative.id,
                          text: message,
                          recipients: [],
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
