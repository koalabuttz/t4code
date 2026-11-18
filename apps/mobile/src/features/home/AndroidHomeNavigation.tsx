import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { LegendList } from "@legendapp/list/react-native";
import { AsyncResult, Atom } from "effect/reactivity";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { getThreadSortTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import { isListedThreadLineage } from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { Modal, Platform, Pressable, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { NavigationRow } from "../../components/ui/NavigationRow";
import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import type { AndroidHomeView } from "../../persistence/mobile-preferences";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { serverEnvironment } from "../../state/server";
import { WorkspaceListHeader } from "../layout/workspace/WorkspaceListHeader";
import type { HomeProjectScope } from "./homeThreadList";
import type { HomeProjectItem } from "./use-project-list-selection";

const EMPTY_COORDINATORS = new Map<string, string>();
const sameCoordinators = (left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>) =>
  left.size === right.size && [...left].every(([key, thread]) => right.get(key) === thread);

export function useAndroidHomeNavigation(
  projects: readonly EnvironmentProject[],
  visible: boolean,
) {
  const enabled = Platform.OS === "android";
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const view =
    enabled && AsyncResult.isSuccess(preferences)
      ? (preferences.value.androidHomeView ?? "threads")
      : "threads";
  const projectKey = (project: EnvironmentProject) =>
    scopedProjectKey(project.environmentId, project.id);
  const indexAtom = useMemo(
    () =>
      Atom.make((get) => {
        if (!enabled || !visible) return EMPTY_COORDINATORS;
        const index = new Map<string, string>();
        for (const project of projects) {
          if (project.archivedAt != null || project.isScratch) continue;
          const { id: projectId, environmentId } = project;
          if (
            !get(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities
              .projectTeamwork
          )
            continue;
          const result = get(
            serverEnvironment.teamworkLive({ environmentId, input: { projectId } }),
          );
          const coordinator =
            result._tag === "Success" ? result.value.snapshot.coordinatorThreadId : null;
          if (coordinator) index.set(scopedProjectKey(environmentId, projectId), coordinator);
        }
        return index;
      }).pipe(Atom.withEquality(sameCoordinators)),
    [enabled, projects, visible],
  );
  const coordinators = useAtomValue(indexAtom);
  return {
    view,
    coordinators,
    drawerOpen,
    openDrawer: () => setDrawerOpen(true),
    closeDrawer: () => setDrawerOpen(false),
    setView: (next: AndroidHomeView) => {
      setDrawerOpen(false);
      if (view !== next) save({ androidHomeView: next });
    },
    isProjectChat: (thread: EnvironmentThreadShell) =>
      coordinators.get(scopedProjectKey(thread.environmentId, thread.projectId)) === thread.id,
    hasCoordinator: (project: EnvironmentProject) => coordinators.has(projectKey(project)),
  };
}

type NavigationModel = ReturnType<typeof useAndroidHomeNavigation>;

function projectItems(scopes: readonly HomeProjectScope[]): HomeProjectItem[] {
  return scopes.flatMap((group) =>
    group.projects
      .filter((project) => !project.isScratch && project.archivedAt == null)
      .map((project) => ({ group, project })),
  );
}

function ProjectNavigationRow(props: {
  item: HomeProjectItem;
  hasCoordinator: boolean;
  shortcut?: boolean;
  onOpen: (item: HomeProjectItem) => void;
}) {
  const { group, project } = props.item;
  return (
    <NavigationRow
      title={project.title}
      subtitle={
        props.shortcut
          ? undefined
          : [props.hasCoordinator ? "Project chat" : null, project.workspaceRoot]
              .filter(Boolean)
              .join(" · ")
      }
      subtitleNumberOfLines={1}
      subtitleEllipsizeMode={props.hasCoordinator ? "tail" : "head"}
      leading={<SymbolView name="folder" size={21} />}
      trailing={
        project.pinnedAt != null || group.pinned ? <SymbolView name="pin" size={16} /> : undefined
      }
      onPress={() => props.onOpen(props.item)}
    />
  );
}

export function AndroidProjectsView(props: {
  navigation: NavigationModel;
  scopes: readonly HomeProjectScope[];
  onOpenProject: (item: HomeProjectItem) => void;
  onAddProject: () => void;
  onOpenEnvironments: () => void;
  canAddProject: boolean;
}) {
  const [search, setSearch] = useState("");
  const insets = useSafeAreaInsets();
  const query = search.trim().toLowerCase();
  const items = projectItems(props.scopes)
    .filter(({ project }) =>
      `${project.title} ${project.workspaceRoot}`.toLowerCase().includes(query),
    )
    .sort(
      (left, right) =>
        Number(right.project.pinnedAt != null) - Number(left.project.pinnedAt != null),
    );
  return (
    <View className="flex-1 bg-screen">
      <WorkspaceListHeader
        title="Projects"
        accessibilityLabel="Projects"
        onOpenNavigation={props.navigation.openDrawer}
        onOpenEnvironments={props.onOpenEnvironments}
        search={{
          value: search,
          onChangeText: setSearch,
          placeholder: "Search projects",
          accessibilityLabel: "Search projects",
        }}
        filter={{ customized: false, items: [] }}
      />
      <LegendList
        data={items}
        extraData={props.navigation.coordinators}
        recycleItems
        renderScrollComponent={NativeScrollView}
        keyExtractor={({ project }) => scopedProjectKey(project.environmentId, project.id)}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 12, paddingBottom: insets.bottom + 112 }}
        ListHeaderComponent={
          <View className="mb-3 items-end">
            <Button
              label={props.canAddProject ? "Add project" : "Environments"}
              icon={props.canAddProject ? "folder.badge.plus" : "gearshape"}
              size="compact"
              onPress={props.canAddProject ? props.onAddProject : props.onOpenEnvironments}
            />
          </View>
        }
        ListEmptyComponent={
          <AppText className="p-4 text-center text-foreground-muted">
            {query ? "No matching projects" : "No projects yet"}
          </AppText>
        }
        renderItem={({ item }) => (
          <ProjectNavigationRow
            item={item}
            hasCoordinator={props.navigation.hasCoordinator(item.project)}
            onOpen={props.onOpenProject}
          />
        )}
      />
    </View>
  );
}

export function AndroidHomeDrawer(props: {
  navigation: NavigationModel;
  scopes: readonly HomeProjectScope[];
  threads: readonly EnvironmentThreadShell[];
  onOpenProject: (item: HomeProjectItem) => void;
  onOpenThread: (thread: EnvironmentThreadShell) => void;
}) {
  const { navigation } = props;
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  if (!navigation.drawerOpen) return null;
  const pins = projectItems(props.scopes).filter(({ project }) => project.pinnedAt != null);
  const threads = props.threads
    .filter(
      (thread) =>
        thread.deletedAt === null &&
        thread.archivedAt === null &&
        isListedThreadLineage(thread.lineage) &&
        !navigation.isProjectChat(thread),
    )
    .sort(
      (a, b) => getThreadSortTimestamp(b, "updated_at") - getThreadSortTimestamp(a, "updated_at"),
    );
  const pinnedThreads = threads.filter((thread) => thread.pinnedAt != null);
  const recentThreads = threads.filter((thread) => thread.pinnedAt == null).slice(0, 8);
  const threadRow = (thread: EnvironmentThreadShell) => (
    <NavigationRow
      key={scopedThreadKey(thread.environmentId, thread.id)}
      title={thread.title}
      leading={<SymbolView name="text.bubble" size={21} />}
      trailing={null}
      onPress={() => {
        navigation.closeDrawer();
        props.onOpenThread(thread);
      }}
    />
  );
  return (
    <Modal transparent visible animationType="fade" onRequestClose={navigation.closeDrawer}>
      <View className="flex-1 flex-row bg-backdrop">
        <View
          accessibilityViewIsModal
          className="bg-drawer"
          style={{
            width: Math.min(360, width - 48),
            paddingTop: insets.top,
            paddingBottom: insets.bottom,
            paddingLeft: insets.left,
          }}
        >
          <View className="flex-row items-center justify-between px-4 py-2">
            <AppText textRole="title" className="text-drawer-foreground">
              T3 Code
            </AppText>
            <IconButton
              icon="xmark"
              accessibilityLabel="Close workspace navigation"
              onPress={navigation.closeDrawer}
            />
          </View>
          <LegendList
            data={recentThreads}
            recycleItems
            renderScrollComponent={NativeScrollView}
            keyExtractor={(thread) => scopedThreadKey(thread.environmentId, thread.id)}
            ListHeaderComponent={
              <View>
                {(["projects", "threads"] as const).map((view) => (
                  <NavigationRow
                    key={view}
                    title={view === "projects" ? "Projects" : "Threads"}
                    leading={
                      <SymbolView name={view === "projects" ? "folder" : "text.bubble"} size={22} />
                    }
                    trailing={
                      navigation.view === view ? <SymbolView name="checkmark" size={18} /> : null
                    }
                    accessibilityState={{ selected: navigation.view === view }}
                    onPress={() => navigation.setView(view)}
                  />
                ))}
                {pins.length > 0 || pinnedThreads.length > 0 ? (
                  <>
                    <AppText className="px-4 pb-2 pt-5 text-drawer-foreground-muted">
                      Pinned
                    </AppText>
                    {pins.map((item) => (
                      <ProjectNavigationRow
                        key={scopedProjectKey(item.project.environmentId, item.project.id)}
                        item={item}
                        hasCoordinator={navigation.hasCoordinator(item.project)}
                        shortcut
                        onOpen={(item) => {
                          navigation.closeDrawer();
                          props.onOpenProject(item);
                        }}
                      />
                    ))}
                    {pinnedThreads.map(threadRow)}
                  </>
                ) : null}
                {recentThreads.length > 0 && (
                  <AppText className="px-4 pb-2 pt-5 text-drawer-foreground-muted">
                    Recent threads
                  </AppText>
                )}
              </View>
            }
            renderItem={({ item }) => threadRow(item)}
          />
        </View>
        <Pressable
          accessibilityLabel="Close workspace navigation"
          accessibilityRole="button"
          className="flex-1"
          onPress={navigation.closeDrawer}
        />
      </View>
    </Modal>
  );
}
