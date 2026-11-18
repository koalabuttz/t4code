import { useNavigation } from "@react-navigation/native";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import {
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
import { sameCrewProject } from "@t3tools/shared/crewConversation";
import { useRef, useState, type ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { appAtomRegistry } from "../../state/atom-registry";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { openCrewPage, openCrewSource } from "./crewProjectNavigation";
import { useCrewCollection, useCrewProject, useCrewRead } from "./use-crew-project";
import type { CrewMessageRef } from "@t3tools/contracts/crewConversation";

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
  const settingsPage = page === "project-settings" || page === "advanced" || page === "results";
  const PageScrollView = settingsPage ? ScreenScrollView : ScrollView;
  return (
    <PageScrollView
      ref={scroll}
      className={settingsPage ? "flex-1 ios:bg-sheet" : "flex-1"}
      contentContainerClassName="gap-4 px-5 pt-4"
      contentContainerStyle={{
        paddingBottom: settingsPage ? Math.max(insets.bottom, 18) + 18 : insets.bottom + 24,
      }}
      showsVerticalScrollIndicator={!settingsPage}
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
    </PageScrollView>
  );
}

export function CrewProjectPages({
  scope,
  project,
  page,
}: {
  scope: CrewProjectScope;
  project: EnvironmentProject;
  page: "results" | "project-settings" | "advanced";
}) {
  const navigation = useNavigation();
  const recovery = useCrewRead(page === "advanced" ? scope : null);
  return (
    <CrewPageScroll scope={scope} page={page}>
      {page === "results" ? (
        <ProjectResults scope={scope} />
      ) : page === "project-settings" ? (
        <>
          <ProjectDetails scope={scope} project={project} />
          <ListSection title="Crew">
            <ListRow
              icon="person.2"
              label="Crew and permissions"
              onPress={() => openCrewPage(navigation, scope, "settings")}
            />
            <ListRow
              icon="doc.text"
              label="Memory and context"
              onPress={() => openCrewPage(navigation, scope, "knowledge")}
            />
            <ListRow
              icon="gearshape"
              label="Advanced"
              onPress={() => openCrewPage(navigation, scope, "advanced")}
            />
          </ListSection>
        </>
      ) : (
        <>
          <ListSection title="Conversations">
            <ListRow
              icon="text.bubble"
              label="Inter-thread board"
              onPress={() => openCrewPage(navigation, scope, "board")}
            />
            <ListRow
              icon="doc.text"
              label="Received context"
              onPress={() => openCrewPage(navigation, scope, "context")}
            />
          </ListSection>
          <ListSection title="Activity">
            <ListRow
              icon="clock"
              label="Execution history"
              onPress={() => openCrewPage(navigation, scope, "history")}
            />
            <ListRow
              icon="arrow.clockwise"
              label="Recovery and handover"
              onPress={() => {
                const initiatives = recovery.data?.snapshot.initiatives;
                const initiative =
                  initiatives?.findLast((entry) => entry.status === "active") ??
                  initiatives?.findLast((entry) => entry.status === "paused");
                if (initiative)
                  appAtomRegistry.set(
                    crewSelectedInitiative(scopedProjectKey(scope)),
                    initiative.id,
                  );
                openCrewPage(navigation, scope, "recovery");
              }}
            />
          </ListSection>
          <ListSection title="Management">
            <ListRow
              icon="person.2"
              label="Roles"
              onPress={() => openCrewPage(navigation, scope, "roles")}
            />
            <ListRow
              icon="checkmark.circle"
              label="Initiatives and approval"
              onPress={() => openCrewPage(navigation, scope, "settings")}
            />
          </ListSection>
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
  const nextTitle = title?.trim() ?? "";
  const canRename = canEdit && freshness === "current";
  const canSave = canRename && !busy && nextTitle.length > 0 && nextTitle !== project.title;
  const initiative = snapshot?.initiatives.findLast(
    (item) => item.status === "active" || item.status === "paused" || item.status === "draft",
  );
  const saveName = () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    void update({
      environmentId: scope.environmentId,
      input: { projectId: scope.projectId, title: nextTitle },
    })
      .then((result) => {
        if (result._tag === "Success") setTitle(null);
        else if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          setError(failure instanceof Error ? failure.message : "Could not rename the project.");
        }
      })
      .finally(() => setBusy(false));
  };
  return (
    <ListSection title="Project details">
      {title === null ? (
        <ListActionRow
          icon="pencil"
          label="Rename project"
          description={project.title}
          disabled={!canRename}
          onPress={() => setTitle(project.title)}
        />
      ) : (
        <View className="gap-3 p-4">
          <AppText className="text-sm font-t3-medium text-foreground-muted">Name</AppText>
          <AppTextInput
            accessibilityLabel="Project name"
            className="min-h-11 min-w-0 rounded-xl border-continuous bg-card px-3 text-base text-foreground"
            value={title}
            onChangeText={setTitle}
            returnKeyType="done"
            editable={!busy}
          />
          <View className="flex-row flex-wrap gap-2">
            <Button label="Save name" disabled={!canSave} loading={busy} onPress={saveName} />
            <Button label="Cancel" disabled={busy} onPress={() => setTitle(null)} />
          </View>
        </View>
      )}
      {error && (
        <AppText accessibilityRole="alert" className="px-4 pb-3 text-sm text-danger-foreground">
          {error}
        </AppText>
      )}
      <View className="border-t border-border-subtle">
        <ListRowLayout
          icon="folder"
          label="Workspace"
          meta={
            <AppText textRole="footnote" className="text-foreground-muted" selectable>
              {project.workspaceRoot}
            </AppText>
          }
        />
      </View>
      {initiative && (
        <View className="border-t border-border-subtle">
          <ListRowLayout
            icon="doc.text"
            label="Project brief"
            meta={
              <AppText textRole="footnote" className="text-foreground-muted" numberOfLines={4}>
                {initiative.brief}
              </AppText>
            }
          />
        </View>
      )}
    </ListSection>
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
      {query.error && (
        <AppText className="px-4 text-danger-foreground" accessibilityRole="alert">
          {query.error}
        </AppText>
      )}
      {groups.size === 0 && (
        <ListSection title="Results">
          <ListRowLayout
            icon="doc.text"
            label={
              snapshot ? "No results yet" : query.error ? "Results unavailable" : "Loading results…"
            }
            {...(snapshot ? { description: "Submitted results will appear here." } : {})}
          />
        </ListSection>
      )}
      {[...groups.entries()].map(([id, group]) => (
        <ListSection key={id} title={group.title}>
          {group.tasks.map((task, index) => (
            <View key={task.id} className={index > 0 ? "border-t border-border-subtle" : undefined}>
              <ListRow
                icon="doc.text"
                label={task.title}
                description={crewReviewLabel(task)}
                meta={
                  task.submission?.evidence ? (
                    <AppText
                      textRole="footnote"
                      className="text-foreground-muted"
                      numberOfLines={3}
                    >
                      {task.submission.evidence}
                    </AppText>
                  ) : null
                }
                onPress={() => {
                  appAtomRegistry.set(crewSelectedInitiative(key), task.initiativeId);
                  appAtomRegistry.set(crewSelectedTask(key), task.id);
                  openCrewPage(navigation, scope, "task");
                }}
              />
            </View>
          ))}
        </ListSection>
      ))}
      <ListSection>
        <ListRow
          icon="checkmark.circle"
          label="Integrated milestones"
          onPress={() => openCrewPage(navigation, scope, "milestones")}
        />
      </ListSection>
    </>
  );
}
