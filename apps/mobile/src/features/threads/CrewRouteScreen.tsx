import { useAtom, useAtomValue } from "@effect/atom-react";
import type { StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeProjectRef, scopedProjectKey } from "@t3tools/client-runtime/environment";
import {
  crewCandidateThread,
  crewOriginThread,
  isCrewCoordinatorCandidate,
  resolveCrewCoordinator,
} from "@t3tools/client-runtime/state/crew";
import { View } from "react-native";
import { AppText } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { useProject, useThreadShells } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { TeamworkSheet } from "./TeamworkSheet";

export function CrewRouteScreen({
  route,
}: StaticScreenProps<{ environmentId: string; projectId: string; originThreadId?: string }>) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const projectId = ProjectId.make(route.params.projectId);
  const projectRef = scopeProjectRef(environmentId, projectId);
  const project = useProject(projectRef);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const allThreads = useThreadShells();
  const threads = allThreads.filter((thread) => isCrewCoordinatorCandidate(projectRef, thread));
  const projectKey = scopedProjectKey(projectRef);
  const [candidate, setCandidate] = useAtom(crewCandidateThread(projectKey));
  const originThreadId = useAtomValue(crewOriginThread(projectKey));
  const query = useEnvironmentQuery(
    serverEnvironment.teamworkLive({ environmentId, input: { projectId } }),
  );
  const coordinatorThreadId = query.data?.snapshot.coordinatorThreadId ?? null;
  const selection = resolveCrewCoordinator({
    project: projectRef,
    threads: allThreads,
    coordinatorThreadId,
    candidateThreadId: candidate,
    originThreadId:
      originThreadId ??
      (route.params.originThreadId ? ThreadId.make(route.params.originThreadId) : null),
  });
  const handoverCandidate = candidate ? threads.find((thread) => thread.id === candidate) : null;
  const candidateId = handoverCandidate?.id ?? selection.threadId;
  const selected = threads.find((thread) => thread.id === candidateId);
  const coordinator = threads.find((thread) => thread.id === coordinatorThreadId);
  if (!project) return <AppText>Project unavailable on this connection.</AppText>;
  if (!config?.environment.capabilities.projectTeamwork)
    return <AppText>This server does not support Crew.</AppText>;
  return (
    <View className="flex-1">
      <AppText className="px-5 pt-4 text-lg font-t3-semibold">{project.title} · Crew</AppText>
      {threads.length > 0 && query.data !== null && (
        <Menu
          title={
            coordinatorThreadId
              ? "Conversation for explicit handover"
              : "Conversation to use as coordinator"
          }
          actions={threads.map((thread) => ({
            id: thread.id,
            title: thread.title,
            state: selected?.id === thread.id ? "on" : "off",
          }))}
          onPressAction={({ nativeEvent }) =>
            setCandidate(threads.find((thread) => thread.id === nativeEvent.event)?.id ?? null)
          }
        >
          <View
            accessible
            accessibilityRole="button"
            accessibilityLabel="Choose coordinator conversation"
            className="px-5 py-3"
          >
            <AppText>
              {selected ? `Conversation: ${selected.title}` : "Choose coordinator conversation"}
            </AppText>
          </View>
        </Menu>
      )}
      {coordinatorThreadId && (
        <AppText className="px-5 py-3">
          Existing coordinator: {coordinator?.title ?? "Conversation unavailable"}. Choosing a
          conversation does not change it. Use handover to replace it explicitly.
        </AppText>
      )}
      {selection.reason && <AppText className="px-5">{selection.reason}</AppText>}
      {threads.length === 0 && (
        <AppText>Start a project conversation to choose a coordinator.</AppText>
      )}
      <TeamworkSheet
        target={{ environmentId, projectId, threadId: query.data ? candidateId : null }}
        embedded
        onClose={() => {}}
      />
    </View>
  );
}
