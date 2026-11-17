import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { crewLiveFreshness } from "@t3tools/client-runtime/state/crew";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { CommandId, type ScopedProjectRef, type ThreadId } from "@t3tools/contracts";
import type {
  CrewConversationAction,
  CrewConversationCommand,
  CrewConversationQuery,
} from "@t3tools/contracts/crewConversation";
import { randomUUID } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentShellStatus } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";

export type CrewDestination = "chat" | "threads" | "results" | "settings";
export type CrewSettingsSection = "project" | "crew" | "memory" | "advanced";

declare module "@tanstack/react-router" {
  interface HistoryState {
    crewSource?: { projectKey: string; originHref: string };
    crewRequestId?: string;
    crewRequestRunId?: string;
  }
}

export function useCrewProject(scope: ScopedProjectRef | null) {
  const config = useAtomValue(serverEnvironment.configValueAtom(scope?.environmentId ?? null));
  const enabled = scope !== null && config?.environment.capabilities.projectTeamwork === true;
  const query = useEnvironmentQuery(
    enabled
      ? serverEnvironment.teamworkLive({
          environmentId: scope.environmentId,
          input: { projectId: scope.projectId },
        })
      : null,
  );
  return { config, enabled, query, snapshot: query.data?.snapshot };
}

export function useCrewCollection(
  scope: ScopedProjectRef | null,
  collection: CrewConversationQuery["collection"],
  options: Omit<CrewConversationQuery, "scope" | "collection"> = {},
) {
  return useEnvironmentQuery(
    scope
      ? serverEnvironment.crewConversations({
          environmentId: scope.environmentId,
          input: { scope, collection, limit: 100, ...options },
        })
      : null,
  );
}

export function crewThreadRoute(scope: ScopedProjectRef, threadId: ThreadId) {
  return {
    to: "/$environmentId/$threadId" as const,
    params: scopeThreadRef(scope.environmentId, threadId),
  };
}

export function useCrewConversationMutation(scope: ScopedProjectRef) {
  const { snapshot, query } = useCrewProject(scope);
  const connected = useEnvironmentShellStatus(scope.environmentId) === "live";
  const permission = useAtomValue(
    serverEnvironment.mutateCrewConversation.permissionAtom(scope.environmentId),
  );
  const mutate = useAtomCommand(serverEnvironment.mutateCrewConversation, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastCommand, setLastCommand] = useState<CrewConversationCommand | null>(null);
  const disabled = busy || !permission || crewLiveFreshness(connected, query) !== "current";
  const run = async (command: CrewConversationCommand) => {
    if (disabled) return;
    setBusy(true);
    setLastCommand(command);
    setError(null);
    const result = await mutate({ environmentId: scope.environmentId, input: command });
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not save the Crew action.");
    } else {
      setLastCommand(null);
    }
    setBusy(false);
  };
  return {
    disabled,
    error,
    act: (action: CrewConversationAction) =>
      snapshot &&
      run({
        scope,
        action,
        expectedRevision: snapshot.revision,
        commandId: CommandId.make(randomUUID()),
      }),
    retry: error && lastCommand ? () => run(lastCommand) : null,
  };
}

export function useCrewChatIdentity(scope: ScopedProjectRef | null, threadId: ThreadId) {
  const { snapshot } = useCrewProject(scope);
  const isCoordinator = snapshot?.coordinatorThreadId === threadId;
  const member = useCrewCollection(
    snapshot && snapshot.revision > 0 && !isCoordinator ? scope : null,
    "workstreams",
    { threadId },
  );
  const workstream = member.data?.workstreams.find(
    (entry) => entry.conversation.threadId === threadId,
  );
  const task = snapshot?.tasks.find((entry) => entry.ownerThreadId === threadId);
  return {
    isCoordinator,
    workstreamTitle: workstream
      ? workstream.status !== "unlinked"
        ? workstream.title
        : null
      : (task?.title ?? null),
  };
}
