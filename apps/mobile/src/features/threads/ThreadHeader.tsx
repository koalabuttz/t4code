import { AppBar } from "../../components/ui/AppBar";
import { useNavigation } from "@react-navigation/native";
import { prepareCrewEntry } from "@t3tools/client-runtime/state/crew";
import { appAtomRegistry } from "../../state/atom-registry";
import type { TeamworkTarget } from "./TeamworkSheet";
import { useCrewChat } from "./CrewChat";
import { openCrewPage } from "./crewProjectNavigation";
import type { AppBarAction, AppBarMenu } from "../../components/ui/AppBar.types";
import {
  useAdaptiveWorkspaceLayout,
  useWorkspacePaneState,
} from "../layout/AdaptiveWorkspaceLayout";
import type { ThreadInspectorMode } from "./thread-inspector-navigation";
import { useWorkspaceBackNavigation } from "../layout/workspace/useAndroidWorkspaceNavigation";
import {
  threadTerminalMenu,
  useThreadGitMenuDefinition,
  type ThreadGitControlsProps,
} from "./ThreadGitControls";

export function ThreadHeader(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly gitControls: ThreadGitControlsProps;
  readonly onReturnToThread?: () => void;
  readonly draft?: boolean;
  readonly hasThreadCwd: boolean;
  readonly inspectorMode: ThreadInspectorMode | null;
  readonly onOpenFilesInspector: () => void;
  readonly teamwork?: TeamworkTarget;
}) {
  const navigation = useNavigation();
  const chat = useCrewChat();
  const crewSource = chat?.route.source === true;
  const preserveStack = crewSource || chat?.route.coordinator === true;
  const goBack = useWorkspaceBackNavigation(preserveStack);
  const { toggleAuxiliaryPane, startNewTask } = useAdaptiveWorkspaceLayout();
  const { panes } = useWorkspacePaneState();
  const gitMenu = useThreadGitMenuDefinition(props.gitControls);
  const terminalMenu = threadTerminalMenu(props.gitControls);
  const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
  const actions: AppBarAction[] = props.hasThreadCwd
    ? [
        {
          accessibilityLabel: filesVisible ? "Close files" : "Open files",
          icon: "folder",
          selected: filesVisible,
          disabled: !props.gitControls.canOpenFiles,
          separateBackground: false,
          onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
        },
      ]
    : [];
  const menus = [gitMenu, terminalMenu].filter((menu): menu is AppBarMenu => menu !== null);
  if (chat) {
    if (!crewSource && !chat.route.coordinator)
      actions.push({
        accessibilityLabel: "Project chat",
        icon: "person.2",
        onPress: () => chat.go(),
      });
    menus.push({
      title: "Project conversations",
      icon: "person.2",
      items: [
        ...(!chat.route.coordinator
          ? [{ id: "chat", title: "Project chat", onPress: () => chat.go() }]
          : []),
        { id: "threads", title: "Threads", onPress: () => chat.go("threads") },
        { id: "results", title: "Results", onPress: () => chat.go("results") },
        { id: "settings", title: "Settings", onPress: () => chat.go("project-settings") },
        { id: "memory", title: "Save a project note", onPress: () => chat.go("knowledge") },
        ...(chat.route.coordinator
          ? [
              {
                id: "pause",
                title: chat.stop
                  ? "Stop recovery"
                  : chat.actionInitiative?.status === "active"
                    ? "Pause work"
                    : "Plan and recovery",
                onPress: chat.pauseOrRecover,
                disabled:
                  chat.actionInitiative?.status === "active" &&
                  !chat.stop &&
                  !chat.controls.canEdit,
              },
            ]
          : []),
      ],
    });
  } else if (props.teamwork)
    actions.push({
      accessibilityLabel: "Project crew",
      icon: "person.2",
      onPress: () => {
        if (!props.teamwork) return;
        prepareCrewEntry(appAtomRegistry, props.teamwork, props.teamwork);
        openCrewPage(navigation, props.teamwork);
      },
    });

  return (
    <AppBar
      title={
        chat?.route.coordinator ? chat.route.projectTitle : (chat?.workstream?.title ?? props.title)
      }
      subtitle={
        chat?.route.coordinator
          ? `Coordinator · ${props.title} · ${props.subtitle}`
          : chat?.workstream
            ? `${chat.route.projectTitle} · ${props.subtitle}`
            : props.subtitle
      }
      onBack={preserveStack ? goBack : undefined}
      onBackToList={preserveStack ? undefined : goBack}
      onCompose={props.draft ? undefined : startNewTask}
      backInSplitView={
        props.onReturnToThread
          ? {
              accessibilityLabel: "Return to chat",
              icon: "chevron.left",
              onPress: props.onReturnToThread,
            }
          : crewSource
            ? { accessibilityLabel: "Back", icon: "chevron.left" }
            : undefined
      }
      actions={actions}
      menus={menus}
      hideBottomBorder
    />
  );
}
