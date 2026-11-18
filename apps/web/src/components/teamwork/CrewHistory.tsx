import { useState } from "react";
import type { EnvironmentId, ProjectId, TeamworkAction, ThreadId } from "@t3tools/contracts";
import { crewHistoryText } from "@t3tools/shared/crewHistory";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { CrewArtifactStatus } from "./CrewVerification";

export function CrewHistory({
  environmentId,
  projectId,
  revision,
  archiveEnabled,
  artifactsEnabled,
  disabled,
  act,
  onOpenThread,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  revision: number;
  archiveEnabled: boolean;
  artifactsEnabled: boolean;
  disabled: boolean;
  act: (action: TeamworkAction) => Promise<boolean>;
  onOpenThread: (id: ThreadId) => void;
}) {
  const [archived, setArchived] = useState(false);
  const [before, setBefore] = useState<number>();
  const [selected, setSelected] = useState<string>();
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const query = useEnvironmentQuery(
    serverEnvironment.teamworkHistory({
      environmentId,
      input: {
        projectId,
        beforeRevision: before ?? revision + 1,
        ...(archiveEnabled
          ? { archived, query: search, ...(selected ? { initiativeId: selected } : {}) }
          : {}),
      },
    }),
  );
  const data = query.data;
  const next =
    data?.nextBeforeRevision ??
    (data?.nextBeforeRevision === undefined && data?.events.length === 40
      ? data.events.at(-1)?.revision
      : undefined);
  return (
    <div className="space-y-3">
      {archiveEnabled && (
        <>
          <div className="flex gap-2">
            {[false, true].map((value) => (
              <Button
                key={String(value)}
                size="sm"
                variant={archived === value ? "default" : "outline"}
                onClick={() => {
                  setArchived(value);
                  setBefore(undefined);
                  setSelected(undefined);
                }}
              >
                {value ? "Archive" : "Activity"}
              </Button>
            ))}
          </div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setSearch(text);
              setBefore(undefined);
              setSelected(undefined);
            }}
          >
            <Input
              aria-label="Search Crew history"
              placeholder="Search decisions and evidence"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={200}
            />
            <Button size="sm" type="submit">
              Search
            </Button>
          </form>
        </>
      )}
      {query.error && <p role="alert">{query.error}</p>}
      {!data && !query.error && <p>Loading history…</p>}
      {data && !data.events.length && !data.archives?.length && (
        <p className="text-sm">No matching history.</p>
      )}
      {data?.archives?.map((entry) => (
        <div key={entry.id} className="space-y-2 rounded border p-3">
          <p>
            {entry.title} · {entry.taskCount} tasks
          </p>
          <p className="text-xs text-muted-foreground">
            Archived {new Date(entry.archivedAt).toLocaleString()}
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setSelected(entry.id)}>
              Inspect evidence
            </Button>
            <Button
              size="sm"
              disabled={disabled}
              onClick={async () => {
                if (await act({ type: "initiative.restore", id: entry.id })) {
                  setSelected(undefined);
                  setBefore(undefined);
                }
              }}
            >
              Restore paused
            </Button>
          </div>
        </div>
      ))}
      {data?.archive && (
        <section className="space-y-3" aria-label="Archived initiative">
          <h3 className="font-medium">{data.archive.initiative.title}</h3>
          <p className="whitespace-pre-wrap text-sm">{data.archive.initiative.brief}</p>
          {data.archive.tasks.map((task) => (
            <details key={task.id} className="rounded border p-3">
              <summary>
                {task.title} · {task.status}
              </summary>
              <p className="whitespace-pre-wrap text-sm">{task.brief}</p>
              <p className="whitespace-pre-wrap text-sm">Accept when: {task.criteria}</p>
              <p className="whitespace-pre-wrap text-sm">{task.evidence}</p>
              {artifactsEnabled && task.submission && (
                <CrewArtifactStatus
                  key={task.submission.revision}
                  environmentId={environmentId}
                  input={{ projectId, artifactTaskId: task.id }}
                />
              )}
              {task.review && (
                <p className="whitespace-pre-wrap text-sm">Review: {task.review.evidence}</p>
              )}
              {task.ownerThreadId && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onOpenThread(task.ownerThreadId!)}
                >
                  Open worker
                </Button>
              )}
            </details>
          ))}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setArchived(false);
              setBefore(undefined);
            }}
          >
            Initiative activity
          </Button>
        </section>
      )}
      {data?.events.map((event) => (
        <details key={event.revision} className="rounded border p-3">
          <summary className="cursor-pointer text-sm">
            {event.action.type.replaceAll(".", " ")} · {new Date(event.createdAt).toLocaleString()}
          </summary>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm">
            {crewHistoryText(event.action)}
          </p>
          {event.actorThreadId && (
            <Button size="sm" variant="ghost" onClick={() => onOpenThread(event.actorThreadId!)}>
              Open source conversation
            </Button>
          )}
        </details>
      ))}
      {next != null && (
        <Button size="sm" variant="outline" onClick={() => setBefore(next)}>
          Older history
        </Button>
      )}
      {(before !== undefined || selected !== undefined) && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setBefore(undefined);
            setSelected(undefined);
          }}
        >
          Latest history
        </Button>
      )}
    </div>
  );
}
