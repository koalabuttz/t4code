import { useState } from "react";
import { View } from "react-native";
import type {
  EnvironmentId,
  TeamworkContext,
  TeamworkSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import { crewHistoryText } from "@t3tools/shared/crewHistory";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";

export function CrewContextView({
  environmentId,
  state,
  preview,
  onOpenThread,
}: {
  environmentId: EnvironmentId;
  state: TeamworkSnapshot;
  preview: TeamworkContext | null;
  onOpenThread: (id: ThreadId) => void;
}) {
  const [selectedThreadId, setThreadId] = useState(state.coordinatorThreadId);
  const members = [
    ...new Set(
      [state.coordinatorThreadId, ...state.tasks.map((t) => t.ownerThreadId)].filter(
        (id): id is ThreadId => id !== null,
      ),
    ),
  ];
  const threadId =
    selectedThreadId && members.includes(selectedThreadId)
      ? selectedThreadId
      : state.coordinatorThreadId;
  const [source, setSource] = useState<TeamworkContext["sources"][number] | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const delivered = useEnvironmentQuery(
    threadId
      ? serverEnvironment.teamworkHistory({
          environmentId,
          input: { projectId: state.projectId, contextThreadId: threadId },
        })
      : null,
  );
  const history = useEnvironmentQuery(
    source
      ? serverEnvironment.teamworkHistory({
          environmentId,
          input: {
            projectId: state.projectId,
            ...(source.kind === "task"
              ? { taskId: source.id, beforeRevision: source.revision + 1 }
              : source.kind === "initiative"
                ? { initiativeId: source.id, beforeRevision: source.revision + 1 }
                : { atRevision: source.revision }),
          },
        })
      : null,
  );
  const packet = delivered.data?.context?.packet;
  return (
    <View className="gap-3">
      <AppText className="font-t3-semibold">Project context</AppText>
      <AppText>
        Corrections affect future packets. Delivered packets remain historical evidence.
      </AppText>
      <View className="flex-row flex-wrap gap-2">
        {members.map((id) => (
          <Button
            key={id}
            label={
              id === state.coordinatorThreadId
                ? "Coordinator"
                : (state.tasks.find((t) => t.ownerThreadId === id)?.title ?? "Worker")
            }
            tone={id === threadId ? "primary" : "secondary"}
            onPress={() => setThreadId(id)}
          />
        ))}
      </View>
      <Button label="Refresh delivered context" onPress={delivered.refresh} />
      {delivered.error && <AppText accessibilityRole="alert">{delivered.error}</AppText>}
      {packet ? (
        <>
          <AppText>
            Delivered at revision {packet.revision} · {packet.bytes} bytes · {packet.omitted}{" "}
            sources omitted to fit
          </AppText>
          <AppText selectable>{packet.text}</AppText>
          {packet.sources.map((item) => (
            <View key={`${item.kind}:${item.id}`} className="gap-2">
              <AppText>
                {item.title} · {item.reason} · revision {item.revision}
              </AppText>
              <Button label="Inspect source" onPress={() => setSource(item)} />
              {item.threadId && (
                <Button label="Source conversation" onPress={() => onOpenThread(item.threadId!)} />
              )}
            </View>
          ))}
        </>
      ) : (
        <AppText>No Crew context delivery is recorded for this conversation yet.</AppText>
      )}
      {source && (
        <View className="gap-2">
          <AppText>{source.title} · source history</AppText>
          {history.error && <AppText accessibilityRole="alert">{history.error}</AppText>}
          {history.data?.events.map((event) => (
            <AppText key={event.revision}>
              Revision {event.revision} · {event.action.type}
              {"\n"}
              {crewHistoryText(event.action)}
            </AppText>
          ))}
        </View>
      )}
      {preview && (
        <>
          <Button
            label={showPreview ? "Hide context preview" : "Preview current coordinator context"}
            onPress={() => setShowPreview(!showPreview)}
          />
          {showPreview && <AppText selectable>{preview.text}</AppText>}
        </>
      )}
    </View>
  );
}
