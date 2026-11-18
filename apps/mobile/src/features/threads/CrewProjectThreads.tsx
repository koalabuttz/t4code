import { AnimatedLegendList } from "@legendapp/list/reanimated";
import type { LegendListRef } from "@legendapp/list/react-native";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import { useAtomValue } from "@effect/atom-react";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import { crewScrollOffset, isCrewCoordinatorCandidate } from "@t3tools/client-runtime/state/crew";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { sortPinnedThreadsByOrderKey } from "@t3tools/client-runtime/state/thread-sort";
import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import type { CrewProjectScope } from "@t3tools/contracts/crewConversation";
import { canLinkCrewWorkstream, sameCrewProject } from "@t3tools/shared/crewConversation";
import { useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Platform, View, type ScrollViewProps } from "react-native";
import { GestureDetector, useNativeGesture } from "react-native-gesture-handler";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { useContentBottomInset, useSearchToolbarInset } from "../../components/ui/useBarInset";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { appAtomRegistry } from "../../state/atom-registry";
import { threadListEnvironmentsAtom } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useQueuedThreadKeys } from "../../state/use-thread-outbox";
import { ThreadUndoNotice } from "../home/ThreadUndoNotice";
import { SwipeableScrollGateProvider, useSwipeableScrollGate } from "../home/thread-swipe-actions";
import { useThreadListActions } from "../home/useThreadListActions";
import { useSearchScrollRestoration } from "../layout/workspace/useSearchScrollRestoration";
import { mobileCrewWorkstreamGroups } from "./crewMobile.logic";
import { openCrewSource } from "./crewProjectNavigation";
import {
  ThreadListV2CollapsibleSection,
  ThreadListV2FallbackRow,
  ThreadListV2Row,
  ThreadListV2SectionDivider,
} from "./thread-list-v2-items";
import { useThreadListNow } from "./use-thread-list-now";
import { THREAD_LIST_ROW_LAYOUT } from "./threadListAnimations";
import { useThreadRowProviderInstanceResolver } from "./thread-provider-instance";
import {
  buildThreadListV2ListItems,
  resolveThreadListV2WokeAt,
  type ThreadListV2ThreadListItem,
} from "./threadListV2";
import {
  useCrewCollection,
  useCrewControls,
  useCrewHumanAttention,
  useCrewProject,
} from "./use-crew-project";
import { useOpenThreadPullRequests } from "./use-open-thread-pull-requests";

type CrewSection = ReturnType<typeof mobileCrewWorkstreamGroups>[number];
export interface CrewProjectThreadsFilters {
  search: string;
  cursor: string | undefined;
  requestCursor: string | undefined;
  collapsedGroups: ReadonlySet<CrewSection["title"]>;
}

export interface CrewProjectThreadsScroll {
  offset: number;
  browseOffset: number;
}

type CrewThreadItem =
  | { type: "section"; key: string; title: CrewSection["title"]; count: number; expanded: boolean }
  | {
      type: "thread";
      key: string;
      row: CrewSection["rows"][number];
      item?: ThreadListV2ThreadListItem;
      title: CrewSection["title"];
      divider: boolean;
    };

function renderScrollView(props: ScrollViewProps) {
  return <NativeScrollView {...props} className="bg-screen" />;
}

export function CrewProjectThreads({
  scope,
  project,
  goBack,
  tabs,
  filters,
  setFilters,
  savedScroll,
  onScrollPosition,
}: {
  scope: CrewProjectScope;
  project: EnvironmentProject;
  goBack: () => void;
  tabs: ReactNode;
  filters: CrewProjectThreadsFilters;
  setFilters: Dispatch<SetStateAction<CrewProjectThreadsFilters>>;
  savedScroll: CrewProjectThreadsScroll | undefined;
  onScrollPosition: (position: CrewProjectThreadsScroll) => void;
}) {
  const { environmentId } = scope;
  const navigation = useNavigation();
  const focused = useIsFocused();
  const insets = useSafeAreaInsets();
  const contentBottomInset = useContentBottomInset();
  const { threads, snapshot, freshness, supervision } = useCrewProject(scope);
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const { search, cursor, requestCursor, collapsedGroups } = filters;
  const [linking, setLinking] = useState(false);
  const [linkIssue, setLinkIssue] = useState<string | null>(null);
  const [checkingLink, setCheckingLink] = useState(false);
  const setCursor = (value: string | undefined) => {
    setFilters((current) => ({ ...current, cursor: value }));
  };
  const setRequestCursor = (value: string | undefined) => {
    setFilters((current) => ({ ...current, requestCursor: value }));
  };
  const workstreams = useCrewCollection(canRead ? scope : null, {
    collection: "workstreams",
    limit: 100,
    ...(cursor ? { cursor } : {}),
  });
  const taskLinks = useCrewCollection(canRead ? scope : null, {
    collection: "task-links",
    limit: 100,
  });
  const current = canRead && freshness === "current";
  const attention = useCrewHumanAttention(
    scope,
    current ? (snapshot?.coordinatorThreadId ?? null) : null,
    snapshot?.revision,
    requestCursor,
  );
  const workstreamsCurrent =
    current &&
    workstreams.successResult !== null &&
    workstreams.data?.revision === snapshot?.revision;
  const controls = useCrewControls(scope, snapshot?.revision, workstreamsCurrent);
  const entries = workstreams.data?.workstreams ?? [];
  const groups = mobileCrewWorkstreamGroups({
    scope,
    workstreams: entries,
    links: taskLinks.data?.taskLinks ?? [],
    threads,
    supervision,
    freshness,
    search,
  });

  const environments = useAtomValue(threadListEnvironmentsAtom);
  const providers = environments.providersByEnvironmentId.get(environmentId);
  const resolveProvider = useThreadRowProviderInstanceResolver(
    environments.providersByEnvironmentId,
  );
  const settlement = environments.settlementEnvironmentIds.has(environmentId);
  const snooze = environments.snoozeEnvironmentIds.has(environmentId);
  const queuedThreadKeys = useQueuedThreadKeys();
  const now = useThreadListNow(threads);
  const searching = search.trim().length > 0;
  const items: CrewThreadItem[] = groups.flatMap(({ title, rows }) => {
    if (rows.length === 0) return [];
    const section: CrewThreadItem = {
      type: "section",
      key: title,
      title,
      count: rows.length,
      expanded: searching || !collapsedGroups.has(title),
    };
    if (!section.expanded) return [section];
    const metadata = buildThreadListV2ListItems({
      items: rows.flatMap(({ shell: thread }) => {
        if (!thread) return [];
        const snoozed = snooze && effectiveSnoozed(thread, { now });
        const settled =
          settlement &&
          thread.settledOverride === "settled" &&
          !queuedThreadKeys.has(`${environmentId}:${thread.id}`);
        return [
          {
            thread,
            variant: snoozed || settled ? "slim" : "card",
            snoozed,
            pinned: !snoozed && !settled && thread.pinnedAt != null,
            wokeAt: !snoozed && !settled ? resolveThreadListV2WokeAt(thread, { now }) : null,
            isLast: false,
          },
        ];
      }),
      pendingTasks: [],
      queuedThreadKeys,
      snoozeEnvironmentIds: environments.snoozeEnvironmentIds,
      snoozeLabelNow: `${now.slice(0, 16)}:00.000Z`,
    });
    const byThread = new Map(
      metadata.flatMap((item) =>
        item.type === "v2-thread" ? [[item.item.thread.id, item] as const] : [],
      ),
    );
    const pinned = searching
      ? []
      : sortPinnedThreadsByOrderKey(
          metadata.flatMap((item) =>
            item.type === "v2-thread" && item.item.pinned ? [item.item.thread] : [],
          ),
        );
    const pinRank = new Map(pinned.map((thread, index) => [thread.id, index]));
    const ordered =
      pinned.length === 0
        ? rows
        : [...rows].sort(
            (a, b) =>
              (pinRank.get(a.workstream.conversation.threadId) ?? pinned.length) -
              (pinRank.get(b.workstream.conversation.threadId) ?? pinned.length),
          );
    return [
      section,
      ...ordered.map((row, index): CrewThreadItem => {
        const key = row.workstream.conversation.threadId;
        const item = byThread.get(key);
        return {
          type: "thread",
          key,
          row,
          title,
          divider: index < rows.length - 1,
          ...(item ? { item } : {}),
        };
      }),
    ];
  });

  const list = useRef<LegendListRef>(null);
  const offsetAtom = crewScrollOffset(`native:${scopedProjectKey(scope)}:threads`);
  const [initialScroll] = useState(() => {
    if (savedScroll) return savedScroll;
    const offset = appAtomRegistry.get(offsetAtom);
    return { offset, browseOffset: offset };
  });
  const restoreOffset = useRef(initialScroll.offset);
  const openSwipe = useRef<SwipeableMethods | null>(null);
  const browseOffset = useRef(initialScroll.browseOffset);
  const scrollTo = (offset: number) => {
    openSwipe.current?.close();
    void list.current?.scrollToOffset({ offset, animated: false });
  };
  useSearchScrollRestoration(searching ? "active" : "resting", () => {
    scrollTo(browseOffset.current);
  });
  const searchBar = {
    value: search,
    placeholder: "Search",
    accessibilityLabel: "Search work threads",
    onChangeText: (value: string) => {
      setFilters((current) => ({ ...current, search: value }));
      if (!searching && value.trim()) scrollTo(0);
    },
  };
  const toolbarInset = useSearchToolbarInset(searchBar);
  const scrollGesture = useNativeGesture();
  const { swipeEnabled, scrollGateHandlers } = useSwipeableScrollGate({
    onScrollBeginDrag: () => openSwipe.current?.close(),
    onScroll: (event) => {
      if (restoreOffset.current !== 0) return;
      const offset = Math.max(0, event.nativeEvent.contentOffset.y);
      if (!searching) {
        browseOffset.current = offset;
        if (!cursor) appAtomRegistry.set(offsetAtom, offset);
      }
      onScrollPosition({ offset, browseOffset: browseOffset.current });
    },
  });
  const actions = useThreadListActions();
  const openPullRequests = useOpenThreadPullRequests();
  const linkable = linking
    ? threads
        .filter(
          (thread) =>
            isCrewCoordinatorCandidate(scope, thread) &&
            !thread.archivedAt &&
            canLinkCrewWorkstream(
              scope,
              environmentId,
              thread.source,
              snapshot?.coordinatorThreadId ?? null,
            ) &&
            !entries.some(
              (entry) => entry.status !== "unlinked" && entry.conversation.threadId === thread.id,
            ),
        )
        .slice(0, 30)
    : [];
  const linkThread = (thread: EnvironmentThreadShell) => {
    if (!controls.canEditConversations || checkingLink) return;
    setLinkIssue(null);
    setCheckingLink(true);
    const save = async () => {
      if (cursor || workstreams.data?.nextCursor) {
        const lookup = await executeAtomQuery(
          appAtomRegistry,
          serverEnvironment.crewConversations({
            environmentId,
            input: { scope, collection: "workstreams", id: thread.id, limit: 1 },
          }),
          { refresh: true, reportFailure: false, signal: AbortSignal.timeout(6_000) },
        );
        if (
          lookup._tag === "Failure" ||
          lookup.value.revision !== snapshot?.revision ||
          !sameCrewProject(scope, lookup.value.scope)
        ) {
          setLinkIssue("Could not verify this conversation. Refresh Threads and try again.");
          return;
        }
        if (lookup.value.workstreams.some((entry) => entry.status !== "unlinked")) {
          setLinkIssue("This conversation is already linked.");
          return;
        }
      }
      const saved = await controls.change({
        type: "workstream.link",
        threadId: thread.id,
        title: thread.title.slice(0, 160),
      });
      if (saved) setLinking(false);
    };
    void save()
      .catch(() => setLinkIssue("Could not link this conversation. Try again."))
      .finally(() => setCheckingLink(false));
  };

  return (
    <View className="flex-1 bg-screen android:bg-header">
      <AppBar
        title="Threads"
        subtitle={project.title}
        onBack={goBack}
        backInSplitView={{ accessibilityLabel: "Back", icon: "chevron.left" }}
        search={searchBar}
        actions={[
          {
            accessibilityLabel: linking
              ? "Hide available conversations"
              : "Link an existing conversation",
            icon: "link",
            disabled: !canRead,
            onPress: () => {
              setLinkIssue(null);
              setLinking(!linking);
              if (!linking) scrollTo(0);
            },
          },
        ]}
      />
      <ScreenContent surface="screen">
        {tabs}
        <SwipeableScrollGateProvider enabled={swipeEnabled}>
          <GestureDetector gesture={scrollGesture}>
            <AnimatedLegendList
              ref={list}
              data={items}
              extraData={controls.canEditConversations}
              keyExtractor={(item) => item.key}
              getItemType={(item) => item.type}
              estimatedItemSize={68}
              recycleItems={false}
              itemLayoutAnimation={THREAD_LIST_ROW_LAYOUT}
              renderScrollComponent={Platform.OS === "ios" ? renderScrollView : undefined}
              style={{ flex: 1 }}
              contentInsetAdjustmentBehavior="never"
              keyboardDismissMode="on-drag"
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{
                paddingBottom: Math.max(contentBottomInset, insets.bottom, 16) + toolbarInset + 16,
              }}
              {...scrollGateHandlers}
              scrollEventThrottle={16}
              onContentSizeChange={(_width, height) => {
                const offset = restoreOffset.current;
                if (offset > 0 && workstreams.data && height >= offset) {
                  restoreOffset.current = 0;
                  scrollTo(offset);
                }
              }}
              ListHeaderComponent={
                <>
                  {!canRead && (
                    <AppText className="px-5 py-3">
                      Thread history is unavailable on this connection.
                    </AppText>
                  )}
                  {canRead && !current && (
                    <AppText className="px-5 py-3" accessibilityRole="alert">
                      Updates are last known. Execution is unconfirmed.
                    </AppText>
                  )}
                  {(workstreams.error || controls.error || linkIssue) && (
                    <AppText className="px-5 py-3 text-danger" accessibilityRole="alert">
                      {workstreams.error ?? controls.error ?? linkIssue}
                    </AppText>
                  )}
                  {attention.checking && (
                    <AppText className="px-5 py-3">Checking pending requests…</AppText>
                  )}
                  {attention.error && (
                    <ThreadListV2FallbackRow
                      title="Refresh pending requests"
                      detail={attention.error}
                      onPress={attention.refresh}
                    />
                  )}
                  {(attention.requests.length > 0 || requestCursor) && (
                    <ThreadListV2SectionDivider label="Pending requests" />
                  )}
                  {attention.requests.map((request) => {
                    const { conversation } = request.source;
                    const thread = threads.find(
                      (thread) => thread.id === conversation.threadId && thread.deletedAt === null,
                    );
                    const pending = request.pendingRequest;
                    if (
                      !current ||
                      !pending ||
                      !sameCrewProject(scope, conversation) ||
                      request.coordinator.threadId !== snapshot?.coordinatorThreadId
                    )
                      return null;
                    const workstream = entries.find(
                      (entry) =>
                        sameCrewProject(scope, entry.conversation) &&
                        entry.conversation.threadId === conversation.threadId,
                    );
                    return (
                      <ThreadListV2FallbackRow
                        key={request.id}
                        title={request.reason === "approval" ? "Review request" : "Open question"}
                        detail={thread?.title ?? workstream?.title ?? "Work thread"}
                        onPress={() =>
                          openCrewSource(navigation, scope, conversation, undefined, pending)
                        }
                      />
                    );
                  })}
                  {attention.nextCursor && (
                    <ThreadListV2FallbackRow
                      title="Next request page"
                      detail="Pending requests"
                      onPress={() => setRequestCursor(attention.nextCursor ?? undefined)}
                    />
                  )}
                  {requestCursor && current && (
                    <ThreadListV2FallbackRow
                      title="First request page"
                      detail="Pending requests"
                      onPress={() => setRequestCursor(undefined)}
                    />
                  )}
                  {linking && canRead && (
                    <>
                      <ThreadListV2SectionDivider label="Link an existing conversation" />
                      {linkable.map((thread) => (
                        <ThreadListV2FallbackRow
                          key={thread.id}
                          title={thread.title}
                          detail="Link to Crew"
                          onPress={
                            controls.canEditConversations && !checkingLink
                              ? () => linkThread(thread)
                              : undefined
                          }
                        />
                      ))}
                      {linkable.length === 0 && (
                        <AppText className="px-5 py-3">
                          No other conversations can be linked.
                        </AppText>
                      )}
                    </>
                  )}
                </>
              }
              ListEmptyComponent={
                canRead && workstreams.data ? (
                  <AppText className="px-5 py-3 text-foreground-muted">
                    {searching
                      ? "No work thread titles match on this page."
                      : "Work threads will appear here as the coordinator delegates."}
                  </AppText>
                ) : null
              }
              ListFooterComponent={
                canRead && (cursor || workstreams.data?.nextCursor || workstreams.error) ? (
                  <View className="flex-row flex-wrap gap-2 px-5 py-3">
                    {workstreams.error && (
                      <Button
                        size="compact"
                        label="Refresh threads"
                        onPress={workstreams.refresh}
                      />
                    )}
                    {workstreams.data?.nextCursor && (
                      <Button
                        size="compact"
                        label="Next page"
                        onPress={() => {
                          setCursor(workstreams.data?.nextCursor ?? undefined);
                          scrollTo(0);
                        }}
                      />
                    )}
                    {cursor && (
                      <Button
                        size="compact"
                        label="First page"
                        onPress={() => {
                          setCursor(undefined);
                          restoreOffset.current = appAtomRegistry.get(offsetAtom);
                          scrollTo(0);
                        }}
                      />
                    )}
                  </View>
                ) : null
              }
              renderItem={({ item: entry }) => {
                if (entry.type === "section")
                  return (
                    <ThreadListV2CollapsibleSection
                      label={entry.title}
                      count={entry.count}
                      expanded={entry.expanded}
                      searching={searching}
                      onToggle={() => {
                        setFilters((current) => {
                          const collapsedGroups = new Set(current.collapsedGroups);
                          if (collapsedGroups.has(entry.title)) collapsedGroups.delete(entry.title);
                          else collapsedGroups.add(entry.title);
                          return { ...current, collapsedGroups };
                        });
                      }}
                    />
                  );
                const { workstream, detail } = entry.row;
                const { conversation } = workstream;
                const open = () => {
                  openSwipe.current?.close();
                  openCrewSource(navigation, scope, conversation);
                };
                const resolved = workstream.status === "resolved";
                const additionalAction = controls.canEditConversations
                  ? {
                      item: {
                        id: "crew-workstream-status",
                        title: resolved ? "Reopen" : "Resolve",
                        image: resolved ? "arrow.uturn.backward" : "checkmark.circle",
                      },
                      onPress: () => {
                        void controls.change({
                          type: "workstream.status",
                          threadId: conversation.threadId,
                          status: resolved ? "open" : "resolved",
                        });
                      },
                    }
                  : undefined;
                if (!entry.item || entry.item.item.thread.archivedAt) {
                  return (
                    <ThreadListV2FallbackRow
                      title={entry.item?.item.thread.title ?? workstream.title}
                      detail={
                        entry.item
                          ? "Archived thread"
                          : entry.title === "Resolved"
                            ? "Resolved · History may be unavailable"
                            : detail
                      }
                      onPress={canRead ? open : undefined}
                      additionalAction={additionalAction}
                    />
                  );
                }
                const {
                  item,
                  hasQueuedMessages,
                  snoozePresetMinute,
                  snoozeWakeLabelText,
                  timeLabel,
                } = entry.item;
                const thread = item.thread;
                const held = entry.title === "Working" || entry.title === "Needs you";
                return (
                  <ThreadListV2Row
                    thread={thread}
                    variant={item.variant}
                    project={project}
                    providers={providers}
                    providerInstance={resolveProvider(thread)}
                    environmentLabel={null}
                    hasQueuedMessages={hasQueuedMessages}
                    pinned={item.pinned}
                    snoozed={item.snoozed}
                    wokeAt={item.wokeAt}
                    snoozePresetMinute={snoozePresetMinute ?? ""}
                    {...(snoozeWakeLabelText !== undefined ? { snoozeWakeLabelText } : {})}
                    timeLabel={timeLabel}
                    showTrailingDivider={entry.divider}
                    statusDetail={detail}
                    onSelectThread={open}
                    selectionDisabled={!canRead}
                    mutationsDisabled={!workstreamsCurrent}
                    additionalAction={additionalAction}
                    allowProjectPromotion={false}
                    settlementSupported={settlement && (!held || item.variant === "slim")}
                    snoozeSupported={snooze && !held}
                    snoozePresets={environments.snoozePresetsByEnvironmentId.get(environmentId)}
                    pinningSupported={environments.pinningEnvironmentIds.has(environmentId)}
                    autoSettleOptOutSupported={environments.autoSettleOptOutEnvironmentIds.has(
                      environmentId,
                    )}
                    titleRegenerationSupported={environments.titleRegenerationEnvironmentIds.has(
                      environmentId,
                    )}
                    onOpenThreadPullRequests={openPullRequests}
                    onRenameThread={actions.renameThread}
                    onRegenerateThreadTitle={actions.regenerateThreadTitle}
                    onSettleThread={actions.settleThread}
                    onUnsettleThread={actions.unsettleThread}
                    onSnoozeThread={actions.snoozeThread}
                    onUnsnoozeThread={actions.unsnoozeThread}
                    onPinThread={actions.pinThread}
                    onUnpinThread={actions.unpinThread}
                    onSetThreadAutoSettle={actions.setThreadAutoSettle}
                    onSwipeableWillOpen={(methods) => {
                      if (openSwipe.current !== methods) {
                        openSwipe.current?.close();
                        openSwipe.current = methods;
                      }
                    }}
                    onSwipeableClose={(methods) => {
                      if (openSwipe.current === methods) openSwipe.current = null;
                    }}
                    simultaneousSwipeGesture={scrollGesture}
                  />
                );
              }}
            />
          </GestureDetector>
        </SwipeableScrollGateProvider>
        <ThreadUndoNotice visible={focused} />
      </ScreenContent>
    </View>
  );
}
