import { useAtomValue } from "@effect/atom-react";
import type { StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { View } from "react-native";
import { AppText } from "../../components/ui/AppText";
import { useProject } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { TeamworkSheet, type CrewPage } from "./TeamworkSheet";

export function CrewRouteScreen({
  route,
}: StaticScreenProps<{
  environmentId: string;
  projectId: string;
  originThreadId?: string;
  page?: CrewPage;
}>) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const projectId = ProjectId.make(route.params.projectId);
  const project = useProject(scopeProjectRef(environmentId, projectId));
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  if (!project) return <AppText>Project unavailable on this connection.</AppText>;
  if (!config?.environment.capabilities.projectTeamwork)
    return <AppText>This server does not support Crew.</AppText>;
  return (
    <View className="flex-1">
      <AppText className="px-5 pt-4 text-lg font-t3-semibold">{project.title} · Crew</AppText>
      <TeamworkSheet
        key={route.params.page ?? "overview"}
        target={{
          environmentId,
          projectId,
          threadId: route.params.originThreadId ? ThreadId.make(route.params.originThreadId) : null,
        }}
        page={route.params.page}
        embedded
        onClose={() => {}}
      />
    </View>
  );
}
