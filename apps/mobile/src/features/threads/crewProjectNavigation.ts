import { StackActions, type NavigationProp } from "@react-navigation/native";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { CrewView } from "@t3tools/client-runtime/state/crew";
import type {
  CrewConversationRef,
  CrewMessageRef,
  CrewProjectScope,
} from "@t3tools/contracts/crewConversation";
import { sameCrewProject } from "@t3tools/shared/crewConversation";

import { requestThreadMessageJump } from "./threadMessageJump";
import type { CrewRequestTarget } from "./crewMobile.logic";

export type CrewPage =
  | CrewView
  | "setup"
  | "settings"
  | "recovery"
  | "task"
  | "task-edit"
  | "milestones";
export type CrewProjectPage =
  | CrewPage
  | "threads"
  | "results"
  | "project-settings"
  | "advanced"
  | "exchange";
type CrewNavigation = Pick<
  NavigationProp<ReactNavigation.RootParamList>,
  "navigate" | "dispatch"
> & {
  getState():
    | { index: number; routes: readonly { name: string; params?: object | undefined }[] }
    | undefined;
};

export function openCrewPage(
  navigation: CrewNavigation,
  scope: CrewProjectScope,
  page?: CrewProjectPage,
) {
  const { environmentId, projectId } = scope;
  if (page === undefined) {
    const stack = navigation.getState();
    const last = stack?.index ?? -1;
    const existing =
      stack?.routes.findLastIndex((entry, index) => {
        if (entry.name !== "Crew" || index > last) return false;
        const params = entry.params as ReactNavigation.RootParamList["Crew"] | undefined;
        return (
          params?.environmentId === environmentId &&
          params.projectId === projectId &&
          (params.page === undefined || params.page === "overview")
        );
      }) ?? -1;
    if (existing >= 0) {
      if (existing < last) navigation.dispatch(StackActions.pop(last - existing));
      return;
    }
    navigation.navigate("Crew", { environmentId, projectId });
  } else {
    navigation.dispatch(StackActions.push("Crew", { environmentId, projectId, page }));
  }
}

export function openCrewSource(
  navigation: CrewNavigation,
  scope: CrewProjectScope,
  conversation: CrewConversationRef,
  message?: CrewMessageRef,
  request?: CrewRequestTarget,
) {
  if (!sameCrewProject(scope, conversation)) return;
  if (message) {
    if (
      message.conversation.threadId !== conversation.threadId ||
      !sameCrewProject(conversation, message.conversation)
    )
      return;
    requestThreadMessageJump(
      scopedThreadKey(scopeThreadRef(conversation.environmentId, conversation.threadId)),
      message.messageId,
    );
  }
  navigation.dispatch(
    StackActions.push("Thread", {
      environmentId: conversation.environmentId,
      threadId: conversation.threadId,
      crewSourceProjectId: scope.projectId,
      ...(request ? { crewRequest: request } : {}),
    }),
  );
}

export function openCrewExchange(
  navigation: CrewNavigation,
  scope: CrewProjectScope,
  exchangeKind: "handoffs" | "consultations",
  exchangeId: string,
) {
  navigation.dispatch(
    StackActions.push("Crew", {
      environmentId: scope.environmentId,
      projectId: scope.projectId,
      page: "exchange",
      exchangeKind,
      exchangeId,
    }),
  );
}
