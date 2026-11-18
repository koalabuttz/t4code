import { useNavigation } from "@react-navigation/native";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import {
  isCrewCoordinatorCandidate,
  crewSelectedInitiative,
  crewSelectedTask,
  crewScrollOffset,
} from "@t3tools/client-runtime/state/crew";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { CrewProjectScope } from "@t3tools/contracts/crewConversation";
import { crewReviewLabel } from "@t3tools/shared/crewArtifacts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { canLinkCrewWorkstream, sameCrewProject } from "@t3tools/shared/crewConversation";
import { useRef, useState, type ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useBarOverlap } from "../../components/ui/useBarInset";
import { appAtomRegistry } from "../../state/atom-registry";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { openCrewPage, openCrewSource, type CrewProjectPage } from "./crewProjectNavigation";
import { mobileCrewWorkstreamGroups } from "./crewMobile.logic";
import {
  useCrewCollection,
  useCrewControls,
  useCrewHumanAttention,
  useCrewProject,
} from "./use-crew-project";
import type { CrewMessageRef } from "@t3tools/contracts/crewConversation";

export function CrewProjectDestinations({
  scope,
  page,
}: {
  scope: CrewProjectScope;
  page?: CrewProjectPage | undefined;
}) {
  const navigation = useNavigation();
  const overlap = useBarOverlap();
  return (
    <View
      className="flex-row flex-wrap items-center gap-2 border-b border-border px-4 pb-2 pt-2"
      style={{ marginTop: overlap }}
    >
      {(
        [
          [undefined, "Chat"],
          ["threads", "Threads"],
          ["results", "Results"],
          ["project-settings", "Settings"],
        ] as const
      ).map(([target, label]) => {
        const selected = (page === "overview" ? undefined : page) === target;
        return (
          <Button
            key={label}
            label={label}
            size="compact"
            tone={selected ? "primary" : "secondary"}
            disabled={selected}
            onPress={() => openCrewPage(navigation, scope, target)}
          />
        );
      })}
    </View>
  );
}

function CrewPageScroll({
  scope,
  page,
  children,
}: {
  scope: CrewProjectScope;
  page: string;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const atom = crewScrollOffset(`native:${scopedProjectKey(scope)}:${page}`);
  const [initial] = useState(() => appAtomRegistry.get(atom));
  const scroll = useRef<React.ElementRef<typeof ScrollView>>(null);
  const restored = useRef(initial === 0);
  return (
    <ScrollView
      ref={scroll}
      className="flex-1"
      contentContainerClassName="gap-4 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      keyboardShouldPersistTaps="handled"
      scrollEventThrottle={100}
      onScroll={(event) => {
        if (restored.current)
          appAtomRegistry.set(atom, Math.max(0, event.nativeEvent.contentOffset.y));
      }}
      onContentSizeChange={(_width, height) => {
        if (!restored.current && height >= initial) {
          restored.current = true;
          scroll.current?.scrollTo({ y: initial, animated: false });
        }
      }}
    >
      {children}
    </ScrollView>
  );
}

export function CrewProjectPages({
  scope,
  project,
  page,
}: {
  scope: CrewProjectScope;
  project: EnvironmentProject;
  page: "threads" | "results" | "project-settings" | "advanced";
}) {
  const navigation = useNavigation();
  return (
    <CrewPageScroll scope={scope} page={page}>
      {page === "threads" ? (
        <WorkstreamList scope={scope} />
      ) : page === "results" ? (
        <ProjectResults scope={scope} />
      ) : page === "project-settings" ? (
        <>
          <AppText className="text-lg font-t3-semibold" accessibilityRole="header">
            Project
          </AppText>
          <ProjectDetails scope={scope} project={project} />
          <Button
            label="Crew and permissions"
            onPress={() => openCrewPage(navigation, scope, "settings")}
          />
          <Button
            label="Memory and context"
            onPress={() => openCrewPage(navigation, scope, "knowledge")}
          />
          <Button label="Advanced" onPress={() => openCrewPage(navigation, scope, "advanced")} />
        </>
      ) : (
        <>
          <Button
            label="Inter-thread board"
            onPress={() => openCrewPage(navigation, scope, "board")}
          />
          <Button
            label="Received context"
            onPress={() => openCrewPage(navigation, scope, "context")}
          />
          <Button
            label="Execution history"
            onPress={() => openCrewPage(navigation, scope, "history")}
          />
          <Button
            label="Recovery and handover"
            onPress={() => openCrewPage(navigation, scope, "recovery")}
          />
          <Button label="Roles" onPress={() => openCrewPage(navigation, scope, "roles")} />
          <Button
            label="Initiatives and approval"
            onPress={() => openCrewPage(navigation, scope, "settings")}
          />
        </>
      )}
    </CrewPageScroll>
  );
}

export function CrewExchangeDetails({
  scope,
  kind,
  id,
}: {
  scope: CrewProjectScope;
  kind: "handoffs" | "consultations" | undefined;
  id: string | undefined;
}) {
  const navigation = useNavigation();
  const { threads } = useCrewProject(scope);
  const canRead = useEnvironmentScope(scope.environmentId, AuthOrchestrationReadScope);
  const query = useCrewCollection(kind && id ? scope : null, {
    collection: kind ?? "consultations",
    ...(id ? { id } : {}),
    limit: 1,
  });
  const handoff = kind === "handoffs" ? query.data?.handoffs[0] : undefined;
  const consultation = kind === "consultations" ? query.data?.consultations[0] : undefined;
  const exchange = handoff ?? consultation;
  const opened = lens(exchangedSources());
  function exchangedSources(): Array<{ label: string; message: CrewMessageRef }> {
    if (!exchange || !sameCrewProject(scope, exchange.origin.conversation)) return [];
    const sources = [{ label: "Original message", message: exchange.origin }];
    if (handoff) sources.push({ label: "Handoff explanation", message: handoff.explanation });
    if (consultation?.progress.state === "answered") {
      sources.push({
        label: "Specialist question",
        message: consultation.progress.exchange.request,
      });
      sources.push({
        label: "Specialist answer",
        message: consultation.progress.exchange.response,
      });
    } else if (consultation?.progress.state === "delivered") {
      sources.push({ label: "Specialist question", message: consultation.progress.request });
    }
    return sources;
  }
  function lens(sources: ReturnType<typeof exchangedSources>) {
    return sources.map(({ label, message }) => {
      const inScope = sameCrewProject(scope, message.conversation);
      const source =
        inScope &&
        threads.find(
          (thread) => thread.id === message.conversation.threadId && thread.deletedAt === null,
        );
      return (
        <View key={label} className="gap-2 rounded-xl border border-border p-3">
          <AppText className="font-t3-semibold">{label}</AppText>
          <AppText>{source ? source.title : "Source conversation"}</AppText>
          <AppText selectable className="text-foreground-muted">
            {message.messageId}
          </AppText>
          <Button
            label="Open message"
            accessibilityLabel={`Open ${label.toLowerCase()}`}
            size="compact"
            disabled={!canRead || !inScope}
            onPress={() => openCrewSource(navigation, scope, message.conversation, message)}
          />
        </View>
      );
    });
  }
  const destination =
    exchange && sameCrewProject(scope, exchange.destination)
      ? threads.find(
          (thread) => thread.id === exchange.destination.threadId && thread.deletedAt === null,
        )
      : undefined;
  return (
    <CrewPageScroll scope={scope} page={`exchange:${id ?? ""}`}>
      {!exchange ? (
        <AppText accessibilityRole={query.error ? "alert" : undefined}>
          {query.error ??
            (query.isPending ? "Loading source exchange…" : "This exchange is unavailable.")}
        </AppText>
      ) : (
        <>
          <AppText accessibilityRole="header" className="text-lg font-t3-semibold">
            {handoff ? "Handoff" : "Consultation"}
          </AppText>
          <AppText>{destination?.title ?? "Destination work thread"}</AppText>
          <AppText>
            {handoff
              ? `State · ${handoff.state}`
              : `Response · ${consultation?.progress.state === "answered" ? "Received" : "Not received"}`}
          </AppText>
          {consultation?.replyTo && <AppText>Follow-up consultation</AppText>}
          {handoff && sameCrewProject(scope, handoff.destination) && (
            <Button
              label="Open destination"
              size="compact"
              disabled={!canRead}
              onPress={() => openCrewSource(navigation, scope, handoff.destination)}
            />
          )}
          {opened}
        </>
      )}
    </CrewPageScroll>
  );
}

function ProjectDetails({
  scope,
  project,
}: {
  scope: CrewProjectScope;
  project: EnvironmentProject;
}) {
  const { snapshot, freshness } = useCrewProject(scope);
  const update = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const canEdit = useEnvironmentScope(scope.environmentId, AuthOrchestrationOperateScope);
  const [title, setTitle] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initiative = snapshot?.initiatives.findLast(
    (item) => item.status === "active" || item.status === "paused" || item.status === "draft",
  );
  return (
    <View className="gap-3">
      <AppText>{project.title}</AppText>
      <AppText selectable>{project.workspaceRoot}</AppText>
      {initiative && <AppText numberOfLines={4}>{initiative.brief}</AppText>}
      {error && <AppText accessibilityRole="alert">{error}</AppText>}
      {title === null ? (
        <Button
          label="Rename project"
          disabled={!canEdit || freshness !== "current"}
          onPress={() => setTitle(project.title)}
        />
      ) : (
        <>
          <AppTextInput
            value={title}
            onChangeText={setTitle}
            editable={!busy}
            accessibilityLabel="Project name"
            className="rounded-xl border border-border p-3"
          />
          <View className="flex-row flex-wrap gap-2">
            <Button
              label="Save name"
              disabled={
                !canEdit ||
                freshness !== "current" ||
                !title.trim() ||
                title.trim() === project.title
              }
              loading={busy}
              onPress={() => {
                setBusy(true);
                setError(null);
                void update({
                  environmentId: scope.environmentId,
                  input: { projectId: scope.projectId, title: title.trim() },
                })
                  .then((result) => {
                    if (result._tag === "Success") setTitle(null);
                    else if (!isAtomCommandInterrupted(result)) {
                      const failure = squashAtomCommandFailure(result);
                      setError(
                        failure instanceof Error
                          ? failure.message
                          : "Could not rename the project.",
                      );
                    }
                  })
                  .finally(() => setBusy(false));
              }}
            />
            <Button label="Cancel" disabled={busy} onPress={() => setTitle(null)} />
          </View>
        </>
      )}
    </View>
  );
}

function WorkstreamList({ scope }: { scope: CrewProjectScope }) {
  const navigation = useNavigation();
  const { threads, snapshot, freshness, supervision } = useCrewProject(scope);
  const canRead = useEnvironmentScope(scope.environmentId, AuthOrchestrationReadScope);
  const [search, setSearch] = useState("");
  const [linking, setLinking] = useState(false);
  const [cursor, setCursor] = useState<string>();
  const [requestCursor, setRequestCursor] = useState<string>();
  const workstreams = useCrewCollection(scope, {
    collection: "workstreams",
    limit: 100,
    ...(cursor ? { cursor } : {}),
  });
  const taskLinks = useCrewCollection(scope, { collection: "task-links", limit: 100 });
  const attention = useCrewHumanAttention(
    scope,
    freshness === "current" ? (snapshot?.coordinatorThreadId ?? null) : null,
    snapshot?.revision,
    requestCursor,
  );
  const controls = useCrewControls(scope, snapshot?.revision, freshness === "current");
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
  const linkable = threads.filter(
    (thread) =>
      isCrewCoordinatorCandidate(scope, thread) &&
      !thread.archivedAt &&
      canLinkCrewWorkstream(
        scope,
        thread.environmentId,
        thread.source,
        snapshot?.coordinatorThreadId ?? null,
      ) &&
      !entries.some(
        (entry) => entry.status !== "unlinked" && entry.conversation.threadId === thread.id,
      ),
  );
  return (
    <>
      <AppTextInput
        accessibilityLabel="Search work threads"
        placeholder="Search work threads"
        value={search}
        onChangeText={setSearch}
        className="rounded-xl border border-border px-3 py-3"
      />
      {freshness !== "current" && (
        <AppText accessibilityRole="alert">
          Updates are last known. Execution is unconfirmed.
        </AppText>
      )}
      {workstreams.error && <AppText accessibilityRole="alert">{workstreams.error}</AppText>}
      {controls.error && (
        <AppText accessibilityRole="alert" className="text-danger">
          {controls.error}
        </AppText>
      )}
      {attention.checking && <AppText>Checking pending requests…</AppText>}
      {attention.error && (
        <Button label="Refresh pending requests" size="compact" onPress={attention.refresh} />
      )}
      {freshness === "current" &&
        attention.requests.map((item) => {
          const pending = item.pendingRequest;
          const thread = threads.find(
            (entry) => entry.id === item.source.conversation.threadId && entry.deletedAt === null,
          );
          return pending &&
            item.coordinator.threadId === snapshot?.coordinatorThreadId &&
            thread ? (
            <Button
              key={item.id}
              size="compact"
              label={`${item.reason === "approval" ? "Review request" : "Open question"} · ${thread.title}`}
              onPress={() =>
                openCrewSource(navigation, scope, item.source.conversation, undefined, pending)
              }
            />
          ) : null;
        })}
      {attention.nextCursor && (
        <Button
          label="Check next request page"
          size="compact"
          onPress={() => setRequestCursor(attention.nextCursor ?? undefined)}
        />
      )}
      {requestCursor && (
        <Button
          label="First request page"
          size="compact"
          onPress={() => setRequestCursor(undefined)}
        />
      )}
      {groups.map(
        ({ title, rows }) =>
          rows.length > 0 && (
            <View key={title} className="gap-2">
              <AppText accessibilityRole="header" className="font-t3-semibold">
                {title}
              </AppText>
              {rows.map(({ workstream, detail, unread }) => (
                <View
                  key={workstream.conversation.threadId}
                  className="gap-2 rounded-xl border border-border p-3"
                >
                  <AppText className="font-t3-semibold">
                    {workstream.title}
                    {unread ? " · Unread" : ""}
                  </AppText>
                  <AppText className="text-foreground-muted">{detail}</AppText>
                  <View className="flex-row flex-wrap gap-2">
                    <Button
                      label="Open thread"
                      accessibilityLabel={`Open ${workstream.title}`}
                      size="compact"
                      disabled={!canRead}
                      onPress={() => openCrewSource(navigation, scope, workstream.conversation)}
                    />
                    <Button
                      label={workstream.status === "resolved" ? "Reopen" : "Resolve"}
                      size="compact"
                      disabled={!controls.canEditConversations}
                      onPress={() =>
                        void controls.change({
                          type: "workstream.status",
                          threadId: workstream.conversation.threadId,
                          status: workstream.status === "resolved" ? "open" : "resolved",
                        })
                      }
                    />
                  </View>
                </View>
              ))}
            </View>
          ),
      )}
      {workstreams.data && groups.every((group) => group.rows.length === 0) && (
        <AppText>
          {search
            ? "No matching work threads."
            : "Work threads will appear here as the coordinator delegates."}
        </AppText>
      )}
      {workstreams.data?.nextCursor && (
        <Button
          label="Next page"
          onPress={() => setCursor(workstreams.data?.nextCursor ?? undefined)}
        />
      )}
      {cursor && <Button label="First page" onPress={() => setCursor(undefined)} />}
      <Button
        label={linking ? "Hide available conversations" : "Link an existing conversation"}
        onPress={() => setLinking(!linking)}
      />
      {linking &&
        linkable.slice(0, 30).map((thread) => (
          <Button
            key={thread.id}
            label={`Link ${thread.title}`}
            disabled={!controls.canEditConversations}
            onPress={() => {
              void controls
                .change({
                  type: "workstream.link",
                  threadId: thread.id,
                  title: thread.title.slice(0, 160),
                })
                .then((saved) => {
                  if (saved) setLinking(false);
                });
            }}
          />
        ))}
      {linking && linkable.length === 0 && <AppText>No other conversations can be linked.</AppText>}
    </>
  );
}

function ProjectResults({ scope }: { scope: CrewProjectScope }) {
  const navigation = useNavigation();
  const { snapshot, threads, query } = useCrewProject(scope);
  const workstreams = useCrewCollection(scope, { collection: "workstreams", limit: 100 });
  const taskLinks = useCrewCollection(scope, { collection: "task-links", limit: 100 });
  const groups = new Map<
    string,
    { title: string; tasks: NonNullable<typeof snapshot>["tasks"][number][] }
  >();
  for (const task of snapshot?.tasks ?? []) {
    if (!task.submission && !task.review) continue;
    const link = taskLinks.data?.taskLinks.find(
      (entry) => entry.taskId === task.id && entry.initiativeId === task.initiativeId,
    );
    const threadId = link?.workstream.threadId ?? task.ownerThreadId;
    const title =
      workstreams.data?.workstreams.find((entry) => entry.conversation.threadId === threadId)
        ?.title ??
      threads.find((thread) => thread.id === threadId)?.title ??
      "Other project results";
    const key = threadId ?? "other";
    const group = groups.get(key) ?? { title, tasks: [] };
    group.tasks.push(task);
    groups.set(key, group);
  }
  const key = scopedProjectKey(scope);
  return (
    <>
      {query.error && <AppText accessibilityRole="alert">{query.error}</AppText>}
      {!snapshot ? (
        <AppText>Loading project results…</AppText>
      ) : groups.size === 0 ? (
        <AppText>Submitted results will appear here.</AppText>
      ) : null}
      {[...groups.entries()].map(([id, group]) => (
        <View key={id} className="gap-2">
          <AppText accessibilityRole="header" className="font-t3-semibold">
            {group.title}
          </AppText>
          {group.tasks.map((task) => (
            <View key={task.id} className="gap-2 rounded-xl border border-border p-3">
              <AppText className="font-t3-semibold">{task.title}</AppText>
              <AppText>{crewReviewLabel(task)}</AppText>
              {task.submission?.evidence && (
                <AppText numberOfLines={3}>{task.submission.evidence}</AppText>
              )}
              <Button
                label="Open result details"
                accessibilityLabel={`Open result details for ${task.title}`}
                size="compact"
                onPress={() => {
                  appAtomRegistry.set(crewSelectedInitiative(key), task.initiativeId);
                  appAtomRegistry.set(crewSelectedTask(key), task.id);
                  openCrewPage(navigation, scope, "task");
                }}
              />
            </View>
          ))}
        </View>
      ))}
      <Button
        label="Integrated milestones"
        onPress={() => openCrewPage(navigation, scope, "milestones")}
      />
    </>
  );
}
