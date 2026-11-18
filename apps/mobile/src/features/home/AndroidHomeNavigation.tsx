import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { LegendList } from "@legendapp/list/react-native";
import { useNavigation } from "@react-navigation/native";
import { AsyncResult, Atom } from "effect/reactivity";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { getThreadSortTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import { isListedThreadLineage, type ScopedProjectRef } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { useEffect, useMemo, useState } from "react";
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
import {
  readCrewProjectFootprint,
  type CrewProjectFootprint,
} from "../../state/crew-project-footprints";
import { workspaceConnections } from "../../state/workspace";
import { WorkspaceListHeader } from "../layout/workspace/WorkspaceListHeader";
import { openCrewPage } from "../threads/crewProjectNavigation";
import type { HomeProjectScope } from "./homeThreadList";
import type { HomeProjectItem } from "./use-project-list-selection";

const EMPTY_TARGETS: readonly ScopedProjectRef[] = [];
const CREW_PROJECTS_TITLE = "Crew Projects";

const projectKey = (project: EnvironmentProject) =>
  scopedProjectKey(project.environmentId, project.id);

function isNavigationProject(project: EnvironmentProject) {
  return project.archivedAt == null && !project.isScratch;
}

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
  const targetsAtom = useMemo(
    () =>
      Atom.make((get) => {
        if (!enabled || !visible) return EMPTY_TARGETS;
        const connectedCrew = new Set(
          get(workspaceConnections.environmentsAtom)
            .filter(
              (environment) =>
                environment.isEnabled &&
                environment.connectionState === "connected" &&
                get(serverEnvironment.configValueAtom(environment.environmentId))?.environment
                  .capabilities.projectTeamwork === true,
            )
            .map((environment) => environment.environmentId),
        );
        return projects.flatMap((project) =>
          connectedCrew.has(project.environmentId) && isNavigationProject(project)
            ? [{ environmentId: project.environmentId, projectId: project.id }]
            : [],
        );
      }).pipe(
        Atom.withEquality<readonly ScopedProjectRef[]>(
          (left, right) =>
            left.length === right.length &&
            left.every(
              (scope, index) =>
                scope.environmentId === right[index]?.environmentId &&
                scope.projectId === right[index]?.projectId,
            ),
        ),
      ),
    [enabled, projects, visible],
  );
  const targets = useAtomValue(targetsAtom);
  const [completed, setCompleted] = useState<readonly ScopedProjectRef[]>(EMPTY_TARGETS);
  const [footprints, setFootprints] = useState<ReadonlyMap<string, CrewProjectFootprint>>(
    () => new Map(),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- checks each connected project's footprint once per visible navigation load and cancels when covered
  useEffect(() => {
    if (!targets.length) return;
    const controller = new AbortController();
    void Effect.runPromise(
      Effect.forEach(
        targets,
        (scope) =>
          Effect.promise(async () => {
            if (controller.signal.aborted) return;
            const record = await readCrewProjectFootprint(
              scope,
              AbortSignal.any([controller.signal, AbortSignal.timeout(3_000)]),
            );
            if (!record || controller.signal.aborted) return;
            const key = scopedProjectKey(scope.environmentId, scope.projectId);
            setFootprints((current) => {
              const previous = current.get(key);
              if (
                previous?.hasCrew === record.hasCrew &&
                previous.coordinatorThreadId === record.coordinatorThreadId
              )
                return current;
              return new Map(current).set(key, record);
            });
          }),
        { concurrency: 4, discard: true },
      ),
    ).then(() => {
      if (!controller.signal.aborted) setCompleted(targets);
    });
    return () => controller.abort();
  }, [targets]);
  const coordinators = useMemo(
    () =>
      new Map(
        [...footprints].flatMap(([key, footprint]) =>
          footprint.coordinatorThreadId ? [[key, footprint.coordinatorThreadId] as const] : [],
        ),
      ),
    [footprints],
  );
  return {
    view,
    coordinators,
    checkingProjects: targets.length > 0 && targets !== completed,
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
    hasCrew: (project: EnvironmentProject) => footprints.get(projectKey(project))?.hasCrew === true,
  };
}

type NavigationModel = ReturnType<typeof useAndroidHomeNavigation>;

function projectItems(scopes: readonly HomeProjectScope[]): HomeProjectItem[] {
  return scopes.flatMap((group) =>
    group.projects.filter(isNavigationProject).map((project) => ({ group, project })),
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

export function AndroidCrewProjectsView(props: {
  navigation: NavigationModel;
  scopes: readonly HomeProjectScope[];
  onAddProject: () => void;
  onOpenEnvironments: () => void;
  canAddProject: boolean;
}) {
  const navigation = useNavigation();
  const [search, setSearch] = useState("");
  const insets = useSafeAreaInsets();
  const query = search.trim().toLowerCase();
  const items = projectItems(props.scopes)
    .filter(
      ({ project }) =>
        props.navigation.hasCrew(project) &&
        `${project.title} ${project.workspaceRoot}`.toLowerCase().includes(query),
    )
    .sort(
      (left, right) =>
        Number(right.project.pinnedAt != null) - Number(left.project.pinnedAt != null),
    );
  return (
    <View className="flex-1 bg-screen">
      <WorkspaceListHeader
        title={CREW_PROJECTS_TITLE}
        accessibilityLabel={CREW_PROJECTS_TITLE}
        onOpenNavigation={props.navigation.openDrawer}
        onOpenEnvironments={props.onOpenEnvironments}
        search={{
          value: search,
          onChangeText: setSearch,
          placeholder: "Search Crew projects",
          accessibilityLabel: "Search Crew projects",
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
            {props.navigation.checkingProjects
              ? "Checking for Crew projects…"
              : query
                ? "No matching Crew projects"
                : "No known Crew projects. Start Crew from a project thread."}
          </AppText>
        }
        renderItem={({ item }) => (
          <ProjectNavigationRow
            item={item}
            hasCoordinator={props.navigation.hasCoordinator(item.project)}
            onOpen={({ project }) =>
              openCrewPage(navigation, {
                environmentId: project.environmentId,
                projectId: project.id,
              })
            }
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
                    title={view === "projects" ? CREW_PROJECTS_TITLE : "Threads"}
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
