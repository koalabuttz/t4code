import {
  NavigationRouteContext,
  useFocusEffect,
  useNavigation,
  useRoute,
  type StaticScreenProps,
} from "@react-navigation/native";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import { Keyboard, Platform, View } from "react-native";
import { useCallback, useRef, useState } from "react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { CrewProjectScope } from "@t3tools/contracts/crewConversation";

import { AppBar } from "../../components/ui/AppBar";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { useBarOverlap } from "../../components/ui/useBarInset";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironmentServerConfig, useProject } from "../../state/entities";
import { useAndroidWorkspaceBack } from "../layout/workspace/useAndroidWorkspaceNavigation";
import { CrewExchangeDetails, CrewProjectPages } from "./CrewProjectPages";
import {
  CrewProjectThreads,
  type CrewProjectThreadsFilters,
  type CrewProjectThreadsScroll,
} from "./CrewProjectThreads";
import {
  CREW_PROJECT_TABS,
  isCrewProjectTab,
  selectCrewProjectTab,
  type CrewProjectPage,
  type CrewProjectTab,
} from "./crewProjectNavigation";
import { CrewCoordinatorSetup } from "./CrewCoordinatorSetup";
import { moveCrewEntryDraft } from "./CrewChat";
import { isCrewSettingsPage, TeamworkSheet } from "./TeamworkSheet";
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
  const page = route.params.page;
  const opensCoordinator = !page || page === "overview";
  const query = useCrewRead(supported && opensCoordinator ? scope : null);
  const threadId = query.data?.snapshot.coordinatorThreadId;
  useFocusEffect(
    useCallback(() => {
      if (threadId && opensCoordinator) moveCrewEntryDraft({ environmentId, projectId, threadId });
    }, [environmentId, projectId, threadId, opensCoordinator]),
  );
  if (supported && opensCoordinator && threadId) {
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

  return <CrewProjectPageScreen route={route} routeKey={currentRoute.key} />;
}

function CrewProjectPageScreen({ route, routeKey }: CrewRouteProps & { routeKey: string }) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const projectId = ProjectId.make(route.params.projectId);
  const scope = { environmentId, projectId };
  const project = useProject(scope);
  const config = useEnvironmentServerConfig(environmentId);
  const supported = config?.environment.capabilities.projectTeamwork === true;
  const navigation = useNavigation();
  const goBack = useAndroidWorkspaceBack(true);
  const page = route.params.page;
  const title = page ? pageTitles[page] : undefined;
  const query = useCrewRead(supported && !title ? scope : null);
  const settingsPage =
    page === "project-settings" || page === "advanced" || isCrewSettingsPage(page);
  const originThreadId = route.params.originThreadId
    ? ThreadId.make(route.params.originThreadId)
    : null;
  const overlap = useBarOverlap();
  if (isCrewProjectTab(page) && project && supported) {
    return (
      <CrewProjectTabsScreen
        key={scopedProjectKey(scope)}
        scope={scope}
        project={project}
        page={page}
        routeKey={routeKey}
        goBack={goBack}
      />
    );
  }
  return (
    <View
      className={
        settingsPage ? "flex-1 bg-sheet android:bg-header" : "flex-1 bg-screen android:bg-header"
      }
    >
      <AppBar
        title={title ?? project?.title ?? "Project chat"}
        subtitle={title ? project?.title : "Project chat"}
        onBack={goBack}
        backInSplitView={{ accessibilityLabel: "Back", icon: "chevron.left" }}
        hideBottomBorder={settingsPage}
      />
      <ScreenContent surface={settingsPage ? "sheet" : "canvas"}>
        <View className="flex-1" style={{ paddingTop: overlap }}>
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
              {page === "advanced" ? (
                <CrewProjectPages scope={scope} project={project} page={page} />
              ) : page === "exchange" ? (
                <CrewExchangeDetails
                  scope={scope}
                  kind={route.params.exchangeKind}
                  id={route.params.exchangeId}
                />
              ) : page && !isCrewProjectTab(page) && title ? (
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
        </View>
      </ScreenContent>
    </View>
  );
}

function CrewProjectTabsScreen({
  scope,
  project,
  page,
  routeKey,
  goBack,
}: {
  scope: CrewProjectScope;
  project: EnvironmentProject;
  page: CrewProjectTab;
  routeKey: string;
  goBack: () => void;
}) {
  const navigation = useNavigation();
  const overlap = useBarOverlap();
  const [filters, setFilters] = useState<CrewProjectThreadsFilters>({
    search: "",
    cursor: undefined,
    requestCursor: undefined,
  });
  const threadsScroll = useRef<CrewProjectThreadsScroll | undefined>(undefined);
  const [savedScroll, setSavedScroll] = useState<CrewProjectThreadsScroll>();
  const tabs = (
    <View className="px-5 pb-2 pt-3" style={{ marginTop: overlap }}>
      <SegmentedControl
        options={CREW_PROJECT_TABS}
        selected={page}
        role="tab"
        variant="card"
        onSelect={(tab) => {
          if (tab === page) return;
          Keyboard.dismiss();
          if (page === "threads") setSavedScroll(threadsScroll.current ?? savedScroll);
          selectCrewProjectTab(navigation, routeKey, tab);
        }}
      />
    </View>
  );
  if (page === "threads") {
    return (
      <CrewProjectThreads
        scope={scope}
        project={project}
        goBack={goBack}
        tabs={tabs}
        filters={filters}
        setFilters={setFilters}
        savedScroll={savedScroll}
        onScrollPosition={(position) => {
          threadsScroll.current = position;
        }}
      />
    );
  }
  return (
    <View className="flex-1 bg-sheet android:bg-header">
      {Platform.OS === "ios" && (
        <NativeStackScreenOptions
          options={{ headerSearchBarOptions: undefined, unstable_headerToolbarItems: undefined }}
        />
      )}
      <AppBar
        title={pageTitles[page] ?? project.title}
        subtitle={project.title}
        onBack={goBack}
        backInSplitView={{ accessibilityLabel: "Back", icon: "chevron.left" }}
        hideBottomBorder
      />
      <ScreenContent surface="sheet">
        {tabs}
        <CrewProjectPages key={page} scope={scope} project={project} page={page} />
      </ScreenContent>
    </View>
  );
}
