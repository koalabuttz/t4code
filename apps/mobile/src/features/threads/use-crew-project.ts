import { useAtomValue } from "@effect/atom-react";
import { crewLiveFreshness } from "@t3tools/client-runtime/state/crew";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { CommandId, TeamworkError, type TeamworkAction, type ThreadId } from "@t3tools/contracts";
import { sameCrewProject } from "@t3tools/shared/crewConversation";
import * as Schema from "effect/Schema";
import type {
  CrewConversationAction,
  CrewConversationCommand,
  CrewConversationQuery,
  CrewProjectScope,
} from "@t3tools/contracts/crewConversation";
import { useMemo, useRef, useState } from "react";

import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentShellReadiness } from "../../state/shell";
import { environmentThreadShells } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  CREW_REQUEST_CURSOR,
  mobileCrewPendingAttention,
  mobileCrewSupervision,
} from "./crewMobile.logic";

const isTeamworkError = Schema.is(TeamworkError);

export function useCrewRead(scope: CrewProjectScope | null) {
  return useEnvironmentQuery(
    scope &&
      serverEnvironment.teamworkLive({
        environmentId: scope.environmentId,
        input: { projectId: scope.projectId },
      }),
  );
}

export function useCrewCollection(
  scope: CrewProjectScope | null,
  query: Omit<CrewConversationQuery, "scope">,
) {
  return useEnvironmentQuery(
    scope &&
      serverEnvironment.crewConversations({
        environmentId: scope.environmentId,
        input: { ...query, scope },
      }),
  );
}

export function useCrewHumanAttention(
  scope: CrewProjectScope,
  coordinator: ThreadId | null,
  revision: number | undefined,
  cursor = CREW_REQUEST_CURSOR,
) {
  const enabled = coordinator !== null && revision !== undefined;
  const query = useCrewCollection(enabled ? scope : null, {
    collection: "attention",
    cursor,
    limit: 100,
  });
  const page = enabled
    ? mobileCrewPendingAttention({ ...scope, threadId: coordinator }, revision, query.data)
    : null;
  return {
    requests: page?.requests ?? [],
    nextCursor: page?.nextCursor ?? null,
    checking: enabled && page === null && query.error === null,
    error: query.error,
    refresh: query.refresh,
  };
}

export function useCrewProject(scope: CrewProjectScope, enabled = true) {
  const { environmentId, projectId } = scope;
  const query = useCrewRead(enabled ? scope : null);
  const connected = useEnvironmentShellReadiness(enabled ? environmentId : null).status === "live";
  const freshness = crewLiveFreshness(connected, query);
  const allThreads = useAtomValue(environmentThreadShells.quietThreadShellsAtom);
  const threads = useMemo(
    () =>
      enabled
        ? allThreads.filter(
            (thread) => thread.environmentId === environmentId && thread.projectId === projectId,
          )
        : [],
    [allThreads, enabled, environmentId, projectId],
  );
  const supervision = useMemo(
    () => (query.data ? mobileCrewSupervision(query.data, threads, freshness) : null),
    [query.data, threads, freshness],
  );
  return { query, connected, freshness, threads, supervision, snapshot: query.data?.snapshot };
}

export function useCrewControls(
  scope: CrewProjectScope,
  revision: number | undefined,
  current: boolean,
) {
  const { environmentId, projectId } = scope;
  const canEdit = useAtomValue(serverEnvironment.mutateTeamwork.permissionAtom(environmentId));
  const canEditConversations = useAtomValue(
    serverEnvironment.mutateCrewConversation.permissionAtom(environmentId),
  );
  const teamwork = useAtomCommand(serverEnvironment.mutateTeamwork, { reportFailure: false });
  const conversations = useAtomCommand(serverEnvironment.mutateCrewConversation, {
    reportFailure: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const retry = useRef<CrewConversationCommand | null>(null);
  const teamworkRetry = useRef<Parameters<typeof teamwork>[0] | null>(null);
  const run = async (
    execute: () => ReturnType<typeof teamwork> | ReturnType<typeof conversations>,
    settled: () => void,
  ) => {
    if (saving.current) return false;
    saving.current = true;
    setBusy(true);
    setError(null);
    const saved = await (async () => {
      const result = await execute();
      if (result._tag === "Success") {
        settled();
        return true;
      }
      const failure = squashAtomCommandFailure(result);
      if (isTeamworkError(failure) && failure.reason !== "storage") settled();
      setError(failure instanceof Error ? failure.message : "Could not save the project change.");
      return false;
    })().catch((failure: unknown) => {
      setError(failure instanceof Error ? failure.message : "Could not save the project change.");
      return false;
    });
    saving.current = false;
    setBusy(false);
    return saved;
  };
  return {
    error,
    canEdit: canEdit && current && !busy,
    canEditConversations: canEditConversations && current && !busy,
    act: async (action: TeamworkAction, expectedRevision = revision) => {
      if (expectedRevision === undefined || !canEdit || !current || saving.current) return false;
      const pending = teamworkRetry.current;
      const target =
        pending?.environmentId === environmentId &&
        pending.input.projectId === projectId &&
        JSON.stringify(pending.input.action) === JSON.stringify(action)
          ? pending
          : {
              environmentId,
              input: { projectId, expectedRevision, commandId: CommandId.make(uuidv4()), action },
            };
      teamworkRetry.current = target;
      return run(
        () => teamwork(target),
        () => {
          teamworkRetry.current = null;
        },
      );
    },
    change: async (action: CrewConversationAction) => {
      if (revision === undefined || !canEditConversations || !current || saving.current)
        return false;
      const pending = retry.current;
      const identical =
        pending &&
        sameCrewProject(pending.scope, scope) &&
        JSON.stringify(pending.action) === JSON.stringify(action);
      const input = identical
        ? pending
        : {
            scope,
            expectedRevision: revision,
            commandId: CommandId.make(uuidv4()),
            action,
          };
      retry.current = input;
      return run(
        () => conversations({ environmentId, input }),
        () => {
          retry.current = null;
        },
      );
    },
  };
}
