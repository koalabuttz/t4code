import { useState } from "react";
import type {
  EnvironmentId,
  TeamworkContext,
  TeamworkSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import { crewHistoryText } from "@t3tools/shared/crewHistory";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";

export function CrewContextView({
  environmentId,
  state,
  preview,
  onOpenThread,
}: {
  environmentId: EnvironmentId;
  state: TeamworkSnapshot;
  preview: TeamworkContext | null;
  onOpenThread: (id: ThreadId) => void;
}) {
  const [selectedThreadId, setThreadId] = useState(state.coordinatorThreadId);
  const members = [
    ...new Set(
      [state.coordinatorThreadId, ...state.tasks.map((t) => t.ownerThreadId)].filter(
        (id): id is ThreadId => id !== null,
      ),
    ),
  ];
  const threadId =
    selectedThreadId && members.includes(selectedThreadId)
      ? selectedThreadId
      : state.coordinatorThreadId;
  const [source, setSource] = useState<TeamworkContext["sources"][number] | null>(null);
  const delivered = useEnvironmentQuery(
    threadId
      ? serverEnvironment.teamworkHistory({
          environmentId,
          input: { projectId: state.projectId, contextThreadId: threadId },
        })
      : null,
  );
  const history = useEnvironmentQuery(
    source
      ? serverEnvironment.teamworkHistory({
          environmentId,
          input: {
            projectId: state.projectId,
            ...(source.kind === "task"
              ? { taskId: source.id, beforeRevision: source.revision + 1 }
              : source.kind === "initiative"
                ? { initiativeId: source.id, beforeRevision: source.revision + 1 }
                : { atRevision: source.revision }),
          },
        })
      : null,
  );
  const packet = delivered.data?.context?.packet;
  return (
    <div className="space-y-3">
      <p className="text-sm">
        Inspect the context supplied to a conversation. Corrections affect future packets; already
        delivered packets remain historical evidence.
      </p>
      <label className="text-sm">
        Conversation{" "}
        <select
          value={threadId ?? ""}
          className="max-w-full rounded border bg-background p-2"
          onChange={(e) => setThreadId(members.find((id) => id === e.target.value) ?? null)}
        >
          {members.map((id) => (
            <option key={id} value={id}>
              {id === state.coordinatorThreadId
                ? "Coordinator"
                : (state.tasks.find((t) => t.ownerThreadId === id)?.title ?? "Worker")}
            </option>
          ))}
        </select>
      </label>
      <Button size="sm" variant="outline" onClick={delivered.refresh}>
        Refresh delivered context
      </Button>
      {delivered.error && <p role="alert">{delivered.error}</p>}
      {packet ? (
        <>
          <p className="text-xs text-muted-foreground">
            Delivered at revision {packet.revision} · {packet.bytes} bytes · {packet.omitted}{" "}
            sources omitted to fit the allowance
          </p>
          <pre className="whitespace-pre-wrap break-words rounded border p-3 text-sm">
            {packet.text}
          </pre>
          {packet.sources.map((item) => (
            <div
              key={`${item.kind}:${item.id}`}
              className="flex flex-wrap items-center gap-2 text-sm"
            >
              <span>
                {item.title} · {item.reason} · revision {item.revision}
              </span>
              <Button size="sm" variant="ghost" onClick={() => setSource(item)}>
                Inspect source
              </Button>
              {item.threadId && (
                <Button size="sm" variant="ghost" onClick={() => onOpenThread(item.threadId!)}>
                  Source conversation
                </Button>
              )}
            </div>
          ))}
        </>
      ) : (
        <p className="text-sm">No Crew context delivery is recorded for this conversation yet.</p>
      )}
      {source && (
        <section className="space-y-2 rounded border p-3">
          <h3 className="font-medium">{source.title} · source history</h3>
          {history.error && <p role="alert">{history.error}</p>}
          {history.data?.events.map((event) => (
            <p key={event.revision} className="whitespace-pre-wrap text-sm">
              Revision {event.revision} · {event.action.type}
              {"\n"}
              {crewHistoryText(event.action)}
            </p>
          ))}
        </section>
      )}
      {preview && (
        <details>
          <summary className="cursor-pointer text-sm">Current coordinator context preview</summary>
          <p className="text-xs text-muted-foreground">
            The actual packet is limited by the next turn's available context allowance.
          </p>
          <pre className="whitespace-pre-wrap break-words p-3 text-sm">{preview.text}</pre>
        </details>
      )}
    </div>
  );
}
