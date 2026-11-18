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
  type OutpostSession,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { useEnvironments } from "../../state/environments";
import { outpostEnvironment } from "../../state/polytoken";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { requestConfirmDialog } from "../../confirmDialog";
import { Button } from "../ui/button";
import { OutpostSessionSurfaces } from "../polytoken/OutpostSessionSurfaces";
import { Input } from "../ui/input";
import { SettingsSection } from "./settingsLayout";

export function OutpostSettings() {
  const { environments } = useEnvironments();
  const readable = useEnvironmentsWithScope(environments, AuthOrchestrationReadScope);
  const hosts = environments.filter(
    (e) =>
      e.connection.phase === "connected" &&
      e.serverConfig?.environment.capabilities.outpostFleet &&
      readable.has(e.environmentId),
  );
  return hosts.map((host) => (
    <OutpostEnvironmentSettings
      key={host.environmentId}
      environmentId={host.environmentId}
      label={host.serverConfig?.environment.label ?? host.environmentId}
    />
  ));
}

function OutpostEnvironmentSettings({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const fleets = useEnvironmentQuery(outpostEnvironment.fleets({ environmentId, input: {} }));
  const canSave = useAtomValue(outpostEnvironment.save.permissionAtom(environmentId));
  const [editing, setEditing] = useState<OutpostConnection | "new" | null>(null);
  return (
    <SettingsSection title={`Outpost · ${label}`}>
      <div className="space-y-4 p-4">
        {fleets.error ? <p role="alert">{fleets.error}</p> : null}
        {fleets.isPending && !fleets.data ? <p>Loading Outpost connections…</p> : null}
        {fleets.data?.map((fleet) => (
          <OutpostConnectionView
            key={fleet.connection.id}
            environmentId={environmentId}
            fleet={fleet}
            onEdit={() => setEditing(fleet.connection)}
          />
        ))}
        {canSave ? (
          <Button variant="outline" size="sm" onClick={() => setEditing("new")}>
            Add Outpost connection
          </Button>
        ) : null}
        {editing ? (
          <OutpostConnectionEditor
            key={typeof editing === "string" ? editing : editing.id}
            environmentId={environmentId}
            connection={editing === "new" ? null : editing}
            onClose={() => setEditing(null)}
          />
        ) : null}
      </div>
    </SettingsSection>
  );
}

function OutpostConnectionEditor({
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
    <form
      className="space-y-3 rounded-lg border p-3"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        const outcome = await settlePromise(async () => {
          const result = await save({
            environmentId,
            input: {
              ...(connection ? { id: connection.id } : {}),
              label,
              url,
              enabled: connection?.enabled ?? true,
              ...(token.trim() ? { token: token.trim() } : {}),
            },
          });
          if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
          setToken("");
          onClose();
        });
        if (AsyncResult.isFailure(outcome)) {
          const error = squashAtomCommandFailure(outcome);
          setError(error instanceof Error ? error.message : "Could not save connection.");
        }
        setBusy(false);
      }}
    >
      <label className="block space-y-1">
        <span>Name</span>
        <Input required value={label} onChange={(e) => setLabel(e.target.value)} />
      </label>
      <label className="block space-y-1">
        <span>Outpost URL</span>
        <Input
          required
          type="url"
          placeholder="http://outpost-host:port"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      <label className="block space-y-1">
        <span>
          Bearer token {connection ? "(leave blank to keep saved token)" : "with machine scope"}
        </span>
        <Input
          type="password"
          autoComplete="off"
          required={!connection}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </label>
      {error ? <p role="alert">{error}</p> : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          Save connection
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
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
  const remove = useAtomCommand(outpostEnvironment.remove, { reportFailure: false });
  const test = useAtomCommand(outpostEnvironment.test, { reportFailure: false });
  const action = useAtomCommand(outpostEnvironment.action, { reportFailure: false });
  const canSave = useAtomValue(outpostEnvironment.save.permissionAtom(environmentId));
  const canAct = useAtomValue(outpostEnvironment.action.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [visibleProjects, setVisibleProjects] = useState(10);
  const [visibleRows, setVisibleRows] = useState<Record<string, number>>({});
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
  const connection = fleet.connection;
  const invokeAction = (session: OutpostSession, kind: "stop" | "resume" | "reap") =>
    run(async () => {
      const confirmed = await requestConfirmDialog(
        kind === "reap"
          ? "Reap this external session? This stops its daemon, destroys its worktree, and deletes its session record."
          : kind === "stop"
            ? "Stop this external session? This terminates its daemon. It can be resumed later."
            : "Resume this external session? This launches a fresh daemon.",
        { variant: kind === "reap" ? "destructive" : "default" },
      );
      if (!confirmed) return;
      const result = await action({
        environmentId,
        input: { connectionId: connection.id, sessionId: session.id, action: kind },
      });
      if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
      setSelected(null);
    });
  const sessions = fleet.catalog?.sessions ?? [];
  const projects = groupOutpostSessions(fleet.catalog);
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div>
        <strong>{connection.label}</strong>
        <p className="break-all text-xs text-muted-foreground">{connection.url}</p>
        <p className="text-sm">
          {fleet.status}
          {fleet.checkedAt ? ` · Last checked ${fleet.checkedAt}` : ""}
        </p>
      </div>
      {fleet.error ? (
        <p role="alert" className="text-sm text-destructive">
          {fleet.error} Displayed sessions may be stale.
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm">
          {notice}
        </p>
      ) : null}
      {canSave ? (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await test({
                  environmentId,
                  input: { connectionId: connection.id },
                });
                if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
                setNotice(result.value.error ?? "Connection tested successfully.");
              })
            }
          >
            Test / reconnect
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onEdit}>
            Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await save({
                  environmentId,
                  input: { ...connection, enabled: !connection.enabled },
                });
                if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
              })
            }
          >
            {connection.enabled ? "Disconnect" : "Connect"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await remove({
                  environmentId,
                  input: { connectionId: connection.id },
                });
                if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
              })
            }
          >
            Remove connection
          </Button>
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Disconnecting or removing this connection leaves external sessions running. Attaching
        sessions as T3 threads is unavailable.
      </p>
      {projects.slice(0, visibleProjects).map((project) => (
        <div key={project.id} className="space-y-2">
          <h4 className="break-all text-sm font-medium">{project.path}</h4>
          {(["running", "stopped"] as const).map((group) => {
            const rows = project[group];
            const key = `${project.id}:${group}`;
            const count = visibleRows[key] ?? 50;
            return rows.length ? (
              <div key={group} className="space-y-2">
                <p className="text-xs uppercase text-muted-foreground">{group}</p>
                {rows.slice(0, count).map((session) => (
                  <div key={session.id} className="space-y-1 rounded border p-2 text-sm">
                    <p>
                      {session.title ?? session.id} · {session.lifecycle_state}
                      {session.busy ? " · Busy" : ""}
                      {session.attention ? " · Needs attention" : ""}
                      {fleet.status === "stale" ||
                      (session.freshness !== "fresh" && group === "running")
                        ? " · Stale observation"
                        : ""}
                    </p>
                    {session.branch_name ? (
                      <p className="text-xs text-muted-foreground">{session.branch_name}</p>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                      {connection.enabled && session.availability?.history ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setSelected(selected === session.id ? null : session.id)}
                        >
                          Stopped transcript
                        </Button>
                      ) : null}
                      {canAct && connection.enabled
                        ? (["stop", "resume", "reap"] as const)
                            .filter((kind) => session.availability?.[kind])
                            .map((kind) => (
                              <Button
                                key={kind}
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void invokeAction(session, kind)}
                              >
                                {kind === "stop"
                                  ? "Stop session"
                                  : kind === "resume"
                                    ? "Resume session"
                                    : "Reap session"}
                              </Button>
                            ))
                        : null}
                    </div>
                    {connection.enabled &&
                    session.lifecycle_state === "running" &&
                    session.availability?.read ? (
                      <OutpostSessionSurfaces
                        environmentId={environmentId}
                        connectionId={connection.id}
                        sessionId={session.id}
                      />
                    ) : null}

                    {selected === session.id && connection.enabled ? (
                      <OutpostTranscript
                        key={session.id}
                        environmentId={environmentId}
                        connectionId={connection.id}
                        sessionId={session.id}
                      />
                    ) : null}
                  </div>
                ))}
                {rows.length > count ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setVisibleRows((previous) => ({ ...previous, [key]: count + 50 }))
                    }
                  >
                    Show more sessions ({rows.length - count} remaining)
                  </Button>
                ) : null}
              </div>
            ) : null;
          })}
        </div>
      ))}
      {projects.length > visibleProjects ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => setVisibleProjects((count) => count + 10)}
        >
          Show more projects
        </Button>
      ) : null}
      {fleet.status === "connected" && sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No external sessions.</p>
      ) : null}
    </div>
  );
}

function OutpostTranscript({
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
      if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
      if (next && history?.source_identity !== result.value.source_identity)
        throw new Error("History source changed. Refresh the transcript.");
      setHistory(result.value);
    });
    if (AsyncResult.isFailure(outcome)) {
      const error = squashAtomCommandFailure(outcome);
      setError(error instanceof Error ? error.message : "Could not read transcript.");
    }
    setBusy(false);
  };
  return (
    <div className="space-y-2 border-t pt-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void load(false)}>
        {history ? "Refresh transcript" : "Load current stopped transcript"}
      </Button>
      {error ? <p role="alert">{error}</p> : null}
      {history ? (
        <>
          <p className="text-xs text-muted-foreground">
            Page {history.page_number + 1} / {history.page_count} · {history.page.total_items}{" "}
            records
            {history.page.truncated ? " · Some payloads are attachments or exceed page bounds" : ""}
          </p>
          <div className="max-h-96 overflow-auto">
            {history.page.items.map((item) => (
              <pre
                className="mb-3 whitespace-pre-wrap break-words text-xs"
                key={`${item.lineage}:${item.raw_index}`}
              >
                {outpostHistoryText(item.body)}
              </pre>
            ))}
          </div>
          {history.page.next_page ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void load(true)}>
              Next page
            </Button>
          ) : null}
          {outpostHistoryAttachments(history).map((id) => (
            <Button
              key={id}
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={async () => {
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
                  if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
                  setChunk(readChunk(history.page.checkpoint_id, result.value));
                });
                if (AsyncResult.isFailure(outcome)) {
                  const error = squashAtomCommandFailure(outcome);
                  setError(error instanceof Error ? error.message : "Could not read attachment.");
                }
                setBusy(false);
              }}
            >
              {chunk?.id === id && chunk.next < chunk.total
                ? "Next attachment chunk"
                : "Read attachment"}{" "}
              {id}
            </Button>
          ))}
          {chunk ? (
            <div>
              <p className="text-xs">
                Attachment {chunk.id} · {chunk.next} / {chunk.total} bytes
              </p>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
                {chunk.text}
              </pre>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
