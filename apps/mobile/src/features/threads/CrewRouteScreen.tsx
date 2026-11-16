import { useAtomValue } from "@effect/atom-react";
import type { StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useState } from "react";
import { View } from "react-native";
import { AppText } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { useProject, useThreadShells } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { TeamworkSheet } from "./TeamworkSheet";

export function CrewRouteScreen({
  route,
}: StaticScreenProps<{ environmentId: string; projectId: string }>) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const projectId = ProjectId.make(route.params.projectId);
  const project = useProject(scopeProjectRef(environmentId, projectId));
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const threads = useThreadShells().filter(
    (t) =>
      t.environmentId === environmentId &&
      t.projectId === projectId &&
      t.lineage.parentThreadId === null,
  );
  const [candidate, setCandidate] = useState<string | null>(null);
  const selected = threads.find((t) => t.id === candidate) ?? threads[0];
  if (!project) return <AppText>Project unavailable on this connection.</AppText>;
  if (!config?.environment.capabilities.projectTeamwork)
    return <AppText>This server does not support Crew.</AppText>;
  return (
    <View className="flex-1">
      <AppText className="px-5 pt-4 text-lg font-t3-semibold">{project.title} · Crew</AppText>
      {selected && (
        <Menu
          title="Conversation to use as coordinator"
          actions={threads.map((thread) => ({
            id: thread.id,
            title: thread.title,
            state: selected.id === thread.id ? "on" : "off",
          }))}
          onPressAction={({ nativeEvent }) => setCandidate(nativeEvent.event)}
        >
          <View
            accessible
            accessibilityRole="button"
            accessibilityLabel="Choose coordinator conversation"
            className="px-5 py-3"
          >
            <AppText>Conversation: {selected.title}</AppText>
          </View>
        </Menu>
      )}
      {threads.length === 0 && (
        <AppText>Start a project conversation to choose a coordinator.</AppText>
      )}
      <TeamworkSheet
        target={{ environmentId, projectId, threadId: selected?.id ?? null }}
        embedded
        onClose={() => {}}
      />
    </View>
  );
}
