import { useState } from "react";
import { View } from "react-native";
import type { EnvironmentId, ProjectId, TeamworkAction, ThreadId } from "@t3tools/contracts";
import { crewHistoryText } from "@t3tools/shared/crewHistory";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { AppText, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
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
    <View className="gap-3">
      <AppText className="text-lg font-t3-semibold">Crew history</AppText>
      {archiveEnabled && (
        <>
          <View className="flex-row gap-2">
            {[false, true].map((value) => (
              <Button
                key={String(value)}
                label={value ? "Archive" : "Activity"}
                tone={archived === value ? "primary" : "secondary"}
                onPress={() => {
                  setArchived(value);
                  setBefore(undefined);
                  setSelected(undefined);
                }}
              />
            ))}
          </View>
          <AppTextInput
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
        </>
      )}
      {query.error && <AppText accessibilityRole="alert">{query.error}</AppText>}
      {!data && !query.error && <AppText>Loading history…</AppText>}
      {data && !data.events.length && !data.archives?.length && (
        <AppText>No matching history.</AppText>
      )}
      {data?.archives?.map((entry) => (
        <View key={entry.id} className="gap-2 rounded-2xl bg-secondary p-4">
          <AppText>
            {entry.title} · {entry.taskCount} tasks
          </AppText>
          <Button label="Inspect evidence" onPress={() => setSelected(entry.id)} />
          <Button
            label="Restore paused"
            disabled={disabled}
            onPress={async () => {
              if (await act({ type: "initiative.restore", id: entry.id })) {
                setSelected(undefined);
                setBefore(undefined);
              }
            }}
          />
        </View>
      ))}
      {data?.archive && (
        <View className="gap-3">
          <AppText className="font-t3-semibold">{data.archive.initiative.title}</AppText>
          <AppText>{data.archive.initiative.brief}</AppText>
          {data.archive.tasks.map((task) => (
            <View key={task.id} className="gap-2 rounded-2xl bg-secondary p-4">
              <AppText>
                {task.title} · {task.status}
              </AppText>
              <AppText>{task.brief}</AppText>
              <AppText>Accept when: {task.criteria}</AppText>
              <AppText>{task.evidence}</AppText>
              {task.review && <AppText>Review: {task.review.evidence}</AppText>}
              {artifactsEnabled && task.submission && (
                <CrewArtifactStatus
                  key={task.submission.revision}
                  environmentId={environmentId}
                  input={{ projectId, artifactTaskId: task.id }}
                />
              )}
              {task.ownerThreadId && (
                <Button label="Open worker" onPress={() => onOpenThread(task.ownerThreadId!)} />
              )}
            </View>
          ))}
          <Button
            label="Initiative activity"
            onPress={() => {
              setArchived(false);
              setBefore(undefined);
            }}
          />
        </View>
      )}
      {data?.events.map((event) => (
        <View key={event.revision} className="gap-2 rounded-2xl bg-secondary p-4">
          <AppText className="font-t3-semibold">
            {event.action.type.replaceAll(".", " ")} · {new Date(event.createdAt).toLocaleString()}
          </AppText>
          <AppText>{crewHistoryText(event.action)}</AppText>
          {event.actorThreadId && (
            <Button
              label="Open source conversation"
              onPress={() => onOpenThread(event.actorThreadId!)}
            />
          )}
        </View>
      ))}
      {next != null && <Button label="Older history" onPress={() => setBefore(next)} />}
      {(before !== undefined || selected !== undefined) && (
        <Button
          label="Latest history"
          onPress={() => {
            setBefore(undefined);
            setSelected(undefined);
          }}
        />
      )}
    </View>
  );
}
