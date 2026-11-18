import { useState } from "react";
import { View } from "react-native";
import type { EnvironmentId, ProjectId, TeamworkAction, ThreadId } from "@t3tools/contracts";
import { crewHistoryText } from "@t3tools/shared/crewHistory";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { FormField, FormSection } from "../../components/ui/FormSection";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { CrewArtifactStatus } from "./CrewVerification";

export function CrewHistory({
  environmentId,
  projectId,
  revision,
  archiveEnabled,
  artifactsEnabled,
  disabled,
  act,
  onOpenThread,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  revision: number;
  archiveEnabled: boolean;
  artifactsEnabled: boolean;
  disabled: boolean;
  act: (action: TeamworkAction) => Promise<boolean>;
  onOpenThread: (id: ThreadId) => void;
}) {
  const [archived, setArchived] = useState(false);
  const [before, setBefore] = useState<number>();
  const [selected, setSelected] = useState<string>();
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const query = useEnvironmentQuery(
    serverEnvironment.teamworkHistory({
      environmentId,
      input: {
        projectId,
        beforeRevision: before ?? revision + 1,
        ...(archiveEnabled
          ? { archived, query: search, ...(selected ? { initiativeId: selected } : {}) }
          : {}),
      },
    }),
  );
  const data = query.data;
  const next =
    data?.nextBeforeRevision ??
    (data?.nextBeforeRevision === undefined && data?.events.length === 40
      ? data.events.at(-1)?.revision
      : undefined);
  return (
    <>
      {archiveEnabled && (
        <FormSection title="Filter history">
          <SegmentedControl
            options={[
              { value: "activity", label: "Activity" },
              { value: "archive", label: "Archive" },
            ]}
            selected={archived ? "archive" : "activity"}
            onSelect={(value) => {
              setArchived(value === "archive");
              setBefore(undefined);
              setSelected(undefined);
            }}
          />
          <FormField
            label="Search history"
            accessibilityLabel="Search Crew history"
            placeholder="Search decisions and evidence"
            value={text}
            onChangeText={setText}
            maxLength={200}
          />
          <Button
            label="Search"
            onPress={() => {
              setSearch(text);
              setBefore(undefined);
              setSelected(undefined);
            }}
          />
        </FormSection>
      )}
      {query.error && (
        <AppText accessibilityRole="alert" className="px-4 text-danger-foreground">
          {query.error}
        </AppText>
      )}
      {!query.error &&
        (!data || (!data.events.length && !data.archives?.length && !data.archive)) && (
          <ListSection title="History">
            <ListRowLayout label={data ? "No matching history" : "Loading history…"} />
          </ListSection>
        )}
      {data?.archives?.map((entry) => (
        <ListSection key={entry.id} title={entry.title}>
          <ListRow
            icon="doc.text"
            label="Inspect evidence"
            description={`${entry.taskCount} tasks`}
            onPress={() => setSelected(entry.id)}
          />
          <ListActionRow
            icon="arrow.uturn.backward"
            label="Restore paused"
            disabled={disabled}
            onPress={async () => {
              if (await act({ type: "initiative.restore", id: entry.id })) {
                setSelected(undefined);
                setBefore(undefined);
              }
            }}
          />
        </ListSection>
      ))}
      {data?.archive && (
        <>
          <ListSection title="Archived initiative">
            <ListRowLayout
              label={data.archive.initiative.title}
              description={data.archive.initiative.brief}
            />
            <ListRow
              icon="clock"
              label="Initiative activity"
              onPress={() => {
                setArchived(false);
                setBefore(undefined);
              }}
            />
          </ListSection>
          {data.archive.tasks.map((task) => (
            <ListSection key={task.id}>
              <ListRowLayout
                label={task.title}
                description={task.status}
                meta={
                  <>
                    <AppText>{task.brief}</AppText>
                    <AppText>Accept when: {task.criteria}</AppText>
                    <AppText>{task.evidence}</AppText>
                    {task.review && <AppText>Review: {task.review.evidence}</AppText>}
                  </>
                }
              />
              {artifactsEnabled && task.submission && (
                <View className="px-4 pb-3">
                  <CrewArtifactStatus
                    key={task.submission.revision}
                    environmentId={environmentId}
                    input={{ projectId, artifactTaskId: task.id }}
                  />
                </View>
              )}
              {task.ownerThreadId && (
                <ListRow
                  icon="text.bubble"
                  label="Open worker"
                  onPress={() => onOpenThread(task.ownerThreadId!)}
                />
              )}
            </ListSection>
          ))}
        </>
      )}
      {data?.events.map((event) => (
        <ListSection key={event.revision}>
          <ListRowLayout
            icon="clock"
            label={event.action.type.replaceAll(".", " ")}
            description={new Date(event.createdAt).toLocaleString()}
            meta={<AppText>{crewHistoryText(event.action)}</AppText>}
          />
          {event.actorThreadId && (
            <ListRow
              icon="text.bubble"
              label="Open source conversation"
              onPress={() => onOpenThread(event.actorThreadId!)}
            />
          )}
        </ListSection>
      ))}
      {(next != null || before !== undefined || selected !== undefined) && (
        <ListSection>
          {next != null && <ListActionRow label="Older history" onPress={() => setBefore(next)} />}
          {(before !== undefined || selected !== undefined) && (
            <ListActionRow
              label="Latest history"
              onPress={() => {
                setBefore(undefined);
                setSelected(undefined);
              }}
            />
          )}
        </ListSection>
      )}
    </>
  );
}
