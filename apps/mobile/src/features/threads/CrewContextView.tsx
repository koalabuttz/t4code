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
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";

export function CrewContextView({
  environmentId,
  state,
  preview,
  onOpenThread,
  initialThreadId,
}: {
  environmentId: EnvironmentId;
  state: TeamworkSnapshot;
  preview: TeamworkContext | null;
  onOpenThread: (id: ThreadId) => void;
  initialThreadId?: ThreadId | null | undefined;
}) {
  const [selectedThreadId, setThreadId] = useState(initialThreadId ?? state.coordinatorThreadId);
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
    <>
      {members.length > 0 && (
        <ListSection title="Conversations">
          {members.map((id, index) => (
            <View key={id} className={index > 0 ? "border-t border-border-subtle" : undefined}>
              <ListRow
                label={
                  id === state.coordinatorThreadId
                    ? "Coordinator"
                    : (state.tasks.find((t) => t.ownerThreadId === id)?.title ?? "Worker")
                }
                icon="text.bubble"
                selected={id === threadId}
                onPress={() => setThreadId(id)}
              />
            </View>
          ))}
        </ListSection>
      )}
      <ListSection
        title="Delivered context"
        footer="Corrections affect future packets. Delivered packets remain historical evidence."
      >
        {packet ? (
          <ListRowLayout
            icon="doc.text"
            label={`Delivered at revision ${packet.revision}`}
            description={`${packet.bytes} bytes · ${packet.omitted} sources omitted to fit`}
            meta={<AppText selectable>{packet.text}</AppText>}
          />
        ) : (
          <ListRowLayout label="No Crew context delivery is recorded for this conversation yet." />
        )}
        <ListActionRow
          icon="arrow.clockwise"
          label="Refresh delivered context"
          onPress={delivered.refresh}
        />
      </ListSection>
      {delivered.error && (
        <AppText accessibilityRole="alert" className="px-4 text-danger-foreground">
          {delivered.error}
        </AppText>
      )}
      {packet?.sources.map((item) => (
        <ListSection key={`${item.kind}:${item.id}`} title={item.title}>
          <ListRow
            icon="doc.text"
            label="Inspect source"
            description={`${item.reason} · revision ${item.revision}`}
            onPress={() => setSource(item)}
          />
          {item.threadId && (
            <ListRow
              icon="text.bubble"
              label="Source conversation"
              onPress={() => onOpenThread(item.threadId!)}
            />
          )}
        </ListSection>
      ))}
      {source && (
        <ListSection title={`${source.title} · source history`}>
          {history.error && (
            <AppText accessibilityRole="alert" className="px-4 py-3 text-danger-foreground">
              {history.error}
            </AppText>
          )}
          {history.data?.events.length === 0 && (
            <ListRowLayout label="No source history recorded" />
          )}
          {!history.data && !history.error && <ListRowLayout label="Loading source history…" />}
          {history.data?.events.map((event) => (
            <ListRowLayout
              key={event.revision}
              label={`Revision ${event.revision} · ${event.action.type}`}
              description={crewHistoryText(event.action)}
            />
          ))}
        </ListSection>
      )}
      {preview && (
        <ListSection title="Coordinator context">
          <ListActionRow
            icon="doc.text"
            label={showPreview ? "Hide context preview" : "Preview current coordinator context"}
            onPress={() => setShowPreview(!showPreview)}
          />
          {showPreview && (
            <AppText selectable className="px-4 pb-3">
              {preview.text}
            </AppText>
          )}
        </ListSection>
      )}
    </>
  );
}
