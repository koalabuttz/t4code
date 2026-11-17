import {
  NavigationRouteContext,
  useFocusEffect,
  useNavigation,
  useRoute,
  type StaticScreenProps,
} from "@react-navigation/native";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { View } from "react-native";
import { useCallback } from "react";

import { AppBar } from "../../components/ui/AppBar";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { useEnvironmentServerConfig, useProject } from "../../state/entities";
import { useAndroidWorkspaceBack } from "../layout/workspace/useAndroidWorkspaceNavigation";
import { CrewExchangeDetails, CrewProjectDestinations, CrewProjectPages } from "./CrewProjectPages";
import { type CrewProjectPage } from "./crewProjectNavigation";
import { CrewCoordinatorSetup } from "./CrewCoordinatorSetup";
import { moveCrewEntryDraft } from "./CrewChat";
import { TeamworkSheet } from "./TeamworkSheet";
import { ThreadRouteScreen } from "./ThreadRouteScreen";
import { useCrewRead } from "./use-crew-project";

const pageTitles: Partial<Record<CrewProjectPage, string>> = {
  threads: "Threads",
  results: "Results",
  "project-settings": "Project settings",
  advanced: "Advanced",
  exchange: "Conversation exchange",
  settings: "Crew settings",
  knowledge: "Memory and context",
  context: "Received context",
  board: "Inter-thread board",
  history: "Execution history",
  recovery: "Recovery and handover",
  conversations: "Conversations",
  milestones: "Milestones",
  roles: "Roles",
  setup: "New initiative",
  task: "Result details",
  "task-edit": "Edit work",
  tasks: "Work and review",
};

type CrewRouteProps = StaticScreenProps<{
  environmentId: string;
  projectId: string;
  originThreadId?: string;
  page?: CrewProjectPage;
  exchangeKind?: "handoffs" | "consultations";
  exchangeId?: string;
}>;

export function CrewRouteScreen({ route }: CrewRouteProps) {
  const currentRoute = useRoute();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const projectId = ProjectId.make(route.params.projectId);
  const scope = { environmentId, projectId };
  const config = useEnvironmentServerConfig(environmentId);
  const supported = config?.environment.capabilities.projectTeamwork === true;
  const query = useCrewRead(supported ? scope : null);
  const threadId = query.data?.snapshot.coordinatorThreadId;
  const page = route.params.page;
  useFocusEffect(
    useCallback(() => {
      if (threadId && (!page || page === "overview"))
        moveCrewEntryDraft({ environmentId, projectId, threadId });
    }, [environmentId, projectId, threadId, page]),
  );
  if (supported && (!page || page === "overview") && threadId) {
    const threadRoute = {
      ...currentRoute,
      params: { ...route.params, threadId, crewCoordinatorProjectId: projectId },
    };
    return (
      <NavigationRouteContext value={threadRoute}>
        <ThreadRouteScreen route={threadRoute} />
      </NavigationRouteContext>
    );
  }

  return <CrewProjectPageScreen route={route} />;
}

function CrewProjectPageScreen({ route }: CrewRouteProps) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const projectId = ProjectId.make(route.params.projectId);
  const scope = { environmentId, projectId };
  const project = useProject(scope);
  const config = useEnvironmentServerConfig(environmentId);
  const supported = config?.environment.capabilities.projectTeamwork === true;
  const query = useCrewRead(supported ? scope : null);
  const navigation = useNavigation();
  const goBack = useAndroidWorkspaceBack(true);
  const page = route.params.page;
  const title = page ? pageTitles[page] : undefined;
  const originThreadId = route.params.originThreadId
    ? ThreadId.make(route.params.originThreadId)
    : null;
  return (
    <View className="flex-1 bg-screen android:bg-header">
      <AppBar
        title={title ?? project?.title ?? "Project chat"}
        subtitle={title ? project?.title : "Project chat"}
        onBack={goBack}
      />
      <ScreenContent surface="canvas">
        {!project || !supported ? (
          <AppText className="p-5">
            {!project
              ? "Project unavailable on this connection."
              : config
                ? "This environment does not support Crew."
                : "Connecting to the project environment…"}
          </AppText>
        ) : (
          <>
            <CrewProjectDestinations scope={scope} page={page} />
            {page === "threads" ||
            page === "results" ||
            page === "project-settings" ||
            page === "advanced" ? (
              <CrewProjectPages scope={scope} project={project} page={page} />
            ) : page === "exchange" ? (
              <CrewExchangeDetails
                scope={scope}
                kind={route.params.exchangeKind}
                id={route.params.exchangeId}
              />
            ) : page && title ? (
              <TeamworkSheet
                key={page}
                target={{ ...scope, threadId: originThreadId }}
                page={page}
                embedded
                onClose={() => navigation.goBack()}
              />
            ) : query.data ? (
              <CrewCoordinatorSetup
                scope={scope}
                project={project}
                originThreadId={originThreadId}
              />
            ) : (
              <View className="gap-3 p-5">
                <AppText accessibilityRole={query.error ? "alert" : undefined}>
                  {query.error ?? "Opening project chat…"}
                </AppText>
                {query.error && <Button label="Refresh project chat" onPress={query.refresh} />}
              </View>
            )}
          </>
        )}
      </ScreenContent>
    </View>
  );
}
