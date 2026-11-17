import { useAtomValue } from "@effect/atom-react";
import {
  createOutpostAttachmentReader,
  groupOutpostSessions,
  outpostHistoryAttachments,
  outpostHistoryText,
} from "@t3tools/client-runtime/state/polytoken";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type OutpostConnection,
  type OutpostFleet,
  type OutpostHistory,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Alert, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { OutpostSessionSurfaces } from "../polytoken/OutpostSessionSurfaces";
import { outpostEnvironment } from "../../state/polytoken";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

export function OutpostSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  return canRead ? <OutpostEnvironmentSettings environmentId={environmentId} /> : null;
}

function OutpostEnvironmentSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const fleets = useEnvironmentQuery(outpostEnvironment.fleets({ environmentId, input: {} }));
  const canSave = useAtomValue(outpostEnvironment.save.permissionAtom(environmentId));
  const [editing, setEditing] = useState<OutpostConnection | "new" | null>(null);
  return (
    <SettingsSection
      title="Outpost"
      footer="Connections and credentials belong to this environment. Disconnecting leaves external sessions running. Attaching sessions as T3 threads is unavailable."
    >
      <View className="gap-4 p-4">
        {fleets.error ? <Text accessibilityRole="alert">{fleets.error}</Text> : null}
        {fleets.isPending && !fleets.data ? <Text>Loading connections…</Text> : null}
        {fleets.data?.map((fleet) => (
          <OutpostConnectionView
            key={fleet.connection.id}
            environmentId={environmentId}
            fleet={fleet}
            onEdit={() => setEditing(fleet.connection)}
          />
        ))}
        {canSave ? (
          <Button label="Add Outpost connection" onPress={() => setEditing("new")} />
        ) : null}
        {editing ? (
          <ConnectionEditor
            key={typeof editing === "string" ? editing : editing.id}
            environmentId={environmentId}
            connection={editing === "new" ? null : editing}
            onClose={() => setEditing(null)}
          />
        ) : null}
      </View>
    </SettingsSection>
  );
}

function ConnectionEditor({
  environmentId,
  connection,
  onClose,
}: {
  environmentId: EnvironmentId;
  connection: OutpostConnection | null;
  onClose: () => void;
}) {
  const save = useAtomCommand(outpostEnvironment.save, { reportFailure: false });
  const [label, setLabel] = useState(connection?.label ?? "");
  const [url, setUrl] = useState(connection?.url ?? "");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <View className="gap-3 rounded-xl border border-border p-3">
      <Text>Name</Text>
      <TextInput
        accessibilityLabel="Outpost name"
        value={label}
        onChangeText={setLabel}
        className="rounded-lg border border-border p-3 text-foreground"
      />
      <Text>Outpost URL</Text>
      <TextInput
        accessibilityLabel="Outpost URL"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        value={url}
        onChangeText={setUrl}
        className="rounded-lg border border-border p-3 text-foreground"
      />
      <Text>
        {connection ? "Token (blank keeps saved token)" : "Bearer token with machine scope"}
      </Text>
      <TextInput
        accessibilityLabel="Outpost bearer token"
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        value={token}
        onChangeText={setToken}
        className="rounded-lg border border-border p-3 text-foreground"
      />
      {error ? <Text accessibilityRole="alert">{error}</Text> : null}
      <Button
        label="Save connection"
        loading={busy}
        disabled={!label.trim() || !url.trim() || (!connection && !token.trim())}
        onPress={async () => {
          setBusy(true);
          setError(null);
          const outcome = await settlePromise(async () => {
            const result = await save({
              environmentId,
              input: {
                ...(connection ? { id: connection.id } : {}),
                label: label.trim(),
                url: url.trim(),
                enabled: connection?.enabled ?? true,
                ...(token.trim() ? { token: token.trim() } : {}),
              },
            });
            if (AsyncResult.isFailure(result)) {
              const failure = squashAtomCommandFailure(result);
              setError(failure instanceof Error ? failure.message : "Could not save connection.");
            } else {
              setToken("");
              onClose();
            }
          });
          if (AsyncResult.isFailure(outcome)) {
            const error = squashAtomCommandFailure(outcome);
            setError(error instanceof Error ? error.message : "Could not save connection.");
          }

          setBusy(false);
        }}
      />
      <Button label="Cancel" tone="text" onPress={onClose} />
    </View>
  );
}

function OutpostConnectionView({
  environmentId,
  fleet,
  onEdit,
}: {
  environmentId: EnvironmentId;
  fleet: OutpostFleet;
  onEdit: () => void;
}) {
  const save = useAtomCommand(outpostEnvironment.save, { reportFailure: false });
  const test = useAtomCommand(outpostEnvironment.test, { reportFailure: false });
  const remove = useAtomCommand(outpostEnvironment.remove, { reportFailure: false });
  const action = useAtomCommand(outpostEnvironment.action, { reportFailure: false });
  const canSave = useAtomValue(outpostEnvironment.save.permissionAtom(environmentId));
  const canAct = useAtomValue(outpostEnvironment.action.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [visibleProjects, setVisibleProjects] = useState(10);
  const [visibleRows, setVisibleRows] = useState<Record<string, number>>({});
  const connection = fleet.connection;
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    const outcome = await settlePromise(async () => {
      await work();
    });
    if (AsyncResult.isFailure(outcome)) {
      const error = squashAtomCommandFailure(outcome);
      setNotice(error instanceof Error ? error.message : "Outpost request failed.");
    }

    setBusy(false);
  };
  const sessions = fleet.catalog?.sessions ?? [];
  const projects = groupOutpostSessions(fleet.catalog);
  return (
    <View className="gap-3 rounded-xl border border-border p-3">
      <Text className="font-t3-medium text-foreground">{connection.label}</Text>
      <Text selectable className="text-xs text-foreground-muted">
        {connection.url}
      </Text>
      <Text>
        {fleet.status}
        {fleet.checkedAt ? ` · Last checked ${fleet.checkedAt}` : ""}
      </Text>
      {fleet.error ? (
        <Text accessibilityRole="alert">{fleet.error} Displayed sessions may be stale.</Text>
      ) : null}
      {notice ? <Text>{notice}</Text> : null}
      {canSave ? (
        <View className="gap-2">
          <Button
            label="Test / reconnect"
            disabled={busy}
            onPress={() =>
              void run(async () => {
                const result = await test({
                  environmentId,
                  input: { connectionId: connection.id },
                });
                if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
                setNotice(result.value.error ?? "Connection tested successfully.");
              })
            }
          />
          <Button label="Edit" tone="text" disabled={busy} onPress={onEdit} />
          <Button
            label={connection.enabled ? "Disconnect" : "Connect"}
            tone="text"
            disabled={busy}
            onPress={() =>
              void run(async () => {
                const result = await save({
                  environmentId,
                  input: { ...connection, enabled: !connection.enabled },
                });
                if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
              })
            }
          />
          <Button
            label="Remove connection"
            tone="text"
            disabled={busy}
            onPress={() =>
              void run(async () => {
                const result = await remove({
                  environmentId,
                  input: { connectionId: connection.id },
                });
                if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
              })
            }
          />
        </View>
      ) : null}
      {projects.slice(0, visibleProjects).map((project) => (
        <View key={project.id} className="gap-2">
          <Text selectable className="font-t3-medium text-foreground">
            {project.path}
          </Text>
          {(["running", "stopped"] as const).map((group) => {
            const rows = project[group];
            const key = `${project.id}:${group}`;
            const count = visibleRows[key] ?? 50;
            return rows.length ? (
              <View key={group} className="gap-2">
                <Text className="text-xs text-foreground-muted">{group}</Text>
                {rows.slice(0, count).map((session) => (
                  <View key={session.id} className="gap-2 rounded-lg border border-border p-2">
                    <Text>
                      {session.title ?? session.id} · {session.lifecycle_state}
                      {session.busy ? " · Busy" : ""}
                      {session.attention ? " · Needs attention" : ""}
                      {fleet.status === "stale" ||
                      (session.freshness !== "fresh" && group === "running")
                        ? " · Stale observation"
                        : ""}
                    </Text>
                    {session.branch_name ? (
                      <Text className="text-xs text-foreground-muted">{session.branch_name}</Text>
                    ) : null}
                    {connection.enabled &&
                    session.lifecycle_state === "running" &&
                    session.availability?.read ? (
                      <OutpostSessionSurfaces
                        environmentId={environmentId}
                        connectionId={connection.id}
                        sessionId={session.id}
                      />
                    ) : null}
                    {connection.enabled && session.availability?.history ? (
                      <Button
                        label="Stopped transcript"
                        size="compact"
                        onPress={() => setSelected(selected === session.id ? null : session.id)}
                      />
                    ) : null}
                    {canAct && connection.enabled
                      ? (["stop", "resume", "reap"] as const)
                          .filter((kind) => session.availability?.[kind])
                          .map((kind) => (
                            <Button
                              key={kind}
                              label={
                                kind === "stop"
                                  ? "Stop session"
                                  : kind === "resume"
                                    ? "Resume session"
                                    : "Reap session"
                              }
                              tone={kind === "reap" ? "danger" : "text"}
                              disabled={busy}
                              onPress={() =>
                                Alert.alert(
                                  `${kind} external session?`,
                                  kind === "reap"
                                    ? "Stops the daemon, destroys its worktree, and deletes the session record."
                                    : kind === "stop"
                                      ? "Terminates the external daemon. It can be resumed later."
                                      : "Launches a fresh daemon for this external session.",
                                  [
                                    { text: "Cancel", style: "cancel" },
                                    {
                                      text: kind,
                                      style: kind === "reap" ? "destructive" : "default",
                                      onPress: () =>
                                        void run(async () => {
                                          const result = await action({
                                            environmentId,
                                            input: {
                                              connectionId: connection.id,
                                              sessionId: session.id,
                                              action: kind,
                                            },
                                          });
                                          if (AsyncResult.isFailure(result))
                                            throw squashAtomCommandFailure(result);
                                          setSelected(null);
                                        }),
                                    },
                                  ],
                                )
                              }
                            />
                          ))
                      : null}
                    {selected === session.id && connection.enabled ? (
                      <Transcript
                        key={session.id}
                        environmentId={environmentId}
                        connectionId={connection.id}
                        sessionId={session.id}
                      />
                    ) : null}
                  </View>
                ))}
                {rows.length > count ? (
                  <Button
                    label={`Show more sessions (${rows.length - count} remaining)`}
                    onPress={() =>
                      setVisibleRows((previous) => ({ ...previous, [key]: count + 50 }))
                    }
                  />
                ) : null}
              </View>
            ) : null;
          })}
        </View>
      ))}
      {projects.length > visibleProjects ? (
        <Button
          label="Show more projects"
          onPress={() => setVisibleProjects((count) => count + 10)}
        />
      ) : null}
      {fleet.status === "connected" && sessions.length === 0 ? (
        <Text>No external sessions.</Text>
      ) : null}
    </View>
  );
}

function Transcript({
  environmentId,
  connectionId,
  sessionId,
}: {
  environmentId: EnvironmentId;
  connectionId: string;
  sessionId: string;
}) {
  const read = useAtomCommand(outpostEnvironment.history, { reportFailure: false });
  const attachment = useAtomCommand(outpostEnvironment.attachment, { reportFailure: false });
  const [readChunk] = useState(createOutpostAttachmentReader);
  const [history, setHistory] = useState<OutpostHistory | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chunk, setChunk] = useState<{
    id: string;
    next: number;
    total: number;
    text: string;
  } | null>(null);
  const load = async (next: boolean) => {
    setBusy(true);
    setError(null);
    setChunk(null);
    const outcome = await settlePromise(async () => {
      const result = await read({
        environmentId,
        input: {
          connectionId,
          sessionId,
          ...(next && history?.page.next_page
            ? { checkpoint: history.page.checkpoint_id, nextPage: history.page.next_page }
            : {}),
        },
      });
      if (AsyncResult.isFailure(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Could not read transcript.");
      } else if (next && history?.source_identity !== result.value.source_identity) {
        setError("History source changed. Refresh the transcript.");
      } else {
        setHistory(result.value);
      }
    });
    if (AsyncResult.isFailure(outcome)) {
      const error = squashAtomCommandFailure(outcome);
      setError(error instanceof Error ? error.message : "Could not read transcript.");
    }

    setBusy(false);
  };
  return (
    <View className="gap-2">
      <Button
        label={history ? "Refresh transcript" : "Load current stopped transcript"}
        disabled={busy}
        onPress={() => void load(false)}
      />
      {error ? <Text accessibilityRole="alert">{error}</Text> : null}
      {history ? (
        <>
          <Text>
            Page {history.page_number + 1} / {history.page_count} · {history.page.total_items}{" "}
            records
            {history.page.truncated ? " · Some payloads are attachments or exceed page bounds" : ""}
          </Text>
          {history.page.items.map((item) => (
            <Text
              selectable
              className="font-mono text-xs text-foreground"
              key={`${item.lineage}:${item.raw_index}`}
            >
              {outpostHistoryText(item.body)}
            </Text>
          ))}
          {history.page.next_page ? (
            <Button label="Next page" disabled={busy} onPress={() => void load(true)} />
          ) : null}
          {outpostHistoryAttachments(history).map((id) => (
            <Button
              key={id}
              label={`${chunk?.id === id && chunk.next < chunk.total ? "Next attachment chunk" : "Read attachment"} ${id}`}
              disabled={busy}
              onPress={async () => {
                setBusy(true);
                setError(null);
                const outcome = await settlePromise(async () => {
                  const offset = chunk?.id === id && chunk.next < chunk.total ? chunk.next : 0;
                  const result = await attachment({
                    environmentId,
                    input: {
                      connectionId,
                      sessionId,
                      artifactId: id,
                      checkpoint: history.page.checkpoint_id,
                      offset,
                    },
                  });
                  if (AsyncResult.isFailure(result)) {
                    const failure = squashAtomCommandFailure(result);
                    setError(
                      failure instanceof Error ? failure.message : "Could not read attachment.",
                    );
                  } else {
                    setChunk(readChunk(history.page.checkpoint_id, result.value));
                  }
                });
                if (AsyncResult.isFailure(outcome)) {
                  const error = squashAtomCommandFailure(outcome);
                  setError(error instanceof Error ? error.message : "Could not read attachment.");
                }

                setBusy(false);
              }}
            />
          ))}
          {chunk ? (
            <>
              <Text>
                Attachment {chunk.id} · {chunk.next} / {chunk.total} bytes
              </Text>
              <Text selectable className="font-mono text-xs text-foreground">
                {chunk.text}
              </Text>
            </>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
