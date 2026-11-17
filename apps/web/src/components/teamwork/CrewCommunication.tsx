import { useState } from "react";
import { useAtom } from "@effect/atom-react";
import { crewMessageDraft } from "@t3tools/client-runtime/state/crew";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import type {
  ScopedProjectRef,
  TeamworkAction,
  TeamworkReadResult,
  TeamworkSnapshot,
} from "@t3tools/contracts";
import { crewMessageRecipients } from "./crewPanel.logic";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

export function CrewCommunication({
  state,
  project,
  threads,
  initiativeId,
  deliveries,
  disabled,
  act,
  onResume,
}: {
  state: TeamworkSnapshot;
  project: ScopedProjectRef;
  threads: Parameters<typeof crewMessageRecipients>[0]["threads"];
  initiativeId: string | null;
  deliveries: TeamworkReadResult["deliveries"];
  disabled: boolean;
  act: (action: TeamworkAction) => Promise<boolean>;
  onResume: () => void;
}) {
  const [draft, setDraft] = useAtom(crewMessageDraft(scopedProjectKey(project)));
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const active =
    state.initiatives.find((initiative) => initiative.id === initiativeId)?.status === "active";
  const { members, recipients, invalidRecipients, canAsk } = crewMessageRecipients({
    snapshot: state,
    initiativeId,
    project,
    threads,
    selected: draft.recipients,
  });
  const asking = draft.intent === "ask";
  const sendDisabled =
    disabled || sending || !draft.text.trim() || (asking && (!active || !canAsk));
  return (
    <section aria-label="Crew communication" className="space-y-3">
      <form
        className="space-y-3"
        onSubmit={async (event) => {
          event.preventDefault();
          if (sendDisabled) return;
          setSending(true);
          setNotice(asking ? "Saving request and queueing delivery…" : "Saving note…");
          const saved = await act({
            type: "board.post",
            initiativeId,
            text: asking ? `Please respond to this request:\n\n${draft.text}` : draft.text,
            recipients: asking ? recipients : [],
          });
          setSending(false);
          setNotice(
            saved
              ? asking
                ? "Request saved for delivery. Delivery status appears with the board entry; delivery is not an answer. Your draft is retained."
                : "Note saved quietly; no agent turn was started."
              : "Could not save. Your draft is retained; try again.",
          );
          if (saved && !asking)
            setDraft((current) => (current === draft ? { ...current, text: "" } : current));
        }}
      >
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant={asking ? "secondary" : "ghost"}
            onClick={() => setDraft({ ...draft, intent: "ask" })}
          >
            Ask crew
          </Button>
          <Button
            type="button"
            size="sm"
            variant={!asking ? "secondary" : "ghost"}
            onClick={() => setDraft({ ...draft, intent: "note" })}
          >
            Save a note
          </Button>
        </div>
        <p className="text-sm">
          {asking
            ? "Request an agent response from the selected recipients."
            : "Record a quiet update on the board without notifying an agent."}
        </p>
        <Textarea
          aria-label="Crew message draft"
          placeholder={
            asking ? "What do you need the crew to answer?" : "Save a decision or update"
          }
          value={draft.text}
          onChange={(event) => setDraft({ ...draft, text: event.target.value })}
          maxLength={11950}
          required
        />
        {asking && (
          <fieldset className="space-y-2">
            <legend className="text-sm">Recipients (choose at least one)</legend>
            {members.map((member) => (
              <label key={member.id} className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={recipients.includes(member.id)}
                  disabled={
                    disabled ||
                    sending ||
                    (!recipients.includes(member.id) && recipients.length >= 8)
                  }
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      recipients: event.target.checked
                        ? [...draft.recipients, member.id]
                        : draft.recipients.filter((id) => id !== member.id),
                    })
                  }
                />
                {member.label}
              </label>
            ))}
            {!members.length && (
              <p className="text-sm">
                No current participant conversation is available. Choose an available coordinator or
                worker before asking.
              </p>
            )}
            {invalidRecipients.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm">
                  Unavailable saved recipients:{" "}
                  {invalidRecipients
                    .map((id) =>
                      id === state.coordinatorThreadId
                        ? "Project coordinator"
                        : (state.tasks.find((task) => task.ownerThreadId === id)?.title ?? id),
                    )
                    .join(", ")}
                  . Their conversations are missing, deleted, outside this project/environment, or
                  no longer participating. Remove them before asking; your draft is retained.
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={sending}
                  onClick={() => setDraft({ ...draft, recipients })}
                >
                  Remove unavailable recipients
                </Button>
              </div>
            )}
          </fieldset>
        )}
        {asking && !active && (
          <div className="space-y-2">
            <p className="text-sm">
              Only an active initiative can notify agents. Your message is retained. Resume a paused
              initiative explicitly before asking; a note can be saved now.
            </p>
            <Button type="button" size="sm" variant="outline" onClick={onResume}>
              Inspect resume prerequisites
            </Button>
          </div>
        )}
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={sendDisabled}>
            {sending ? "Saving…" : asking ? "Send request" : "Save note quietly"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={sending}
            onClick={() => {
              setDraft({ ...draft, text: "" });
              setNotice(null);
            }}
          >
            Clear draft
          </Button>
        </div>
        {notice && (
          <p role="status" className="text-sm">
            {notice}
          </p>
        )}
      </form>
      {state.board
        .filter((entry) => entry.initiativeId === initiativeId || entry.initiativeId === null)
        .toReversed()
        .map((entry) => {
          const delivery = deliveries.filter(
            (item) =>
              item.kind === "message" &&
              entry.revision !== undefined &&
              item.id.startsWith(`${state.projectId}:${entry.revision}:`),
          );
          return (
            <article key={entry.id} className="space-y-2 rounded border p-3">
              <p className="text-xs text-muted-foreground">
                {entry.initiativeId === null ? "Project note · " : ""}
                {entry.authorThreadId === null
                  ? "You"
                  : entry.authorThreadId === state.coordinatorThreadId
                    ? "Coordinator"
                    : (state.tasks.find((task) => task.ownerThreadId === entry.authorThreadId)
                        ?.title ?? "Crew participant")}{" "}
                · {new Date(entry.createdAt).toLocaleString()}
              </p>
              <p className="whitespace-pre-wrap text-sm">{entry.text}</p>
              {entry.recipients.length === 0 ? (
                <p className="text-xs">Quiet note · no agent notification requested</p>
              ) : (
                <>
                  <p className="text-xs">
                    Requested recipients:{" "}
                    {entry.recipients
                      .map((id) => members.find((member) => member.id === id)?.label ?? id)
                      .join(", ")}
                    . Delivery does not confirm a response.
                  </p>
                  {!delivery.length && (
                    <p className="text-xs">
                      Delivery details are not available in the current history window.
                    </p>
                  )}
                  {delivery.map((item) => (
                    <div key={item.id} className="flex flex-wrap items-center gap-2 text-sm">
                      <span>
                        {members.find((member) => member.id === item.threadId)?.label ??
                          item.threadId}
                        :{" "}
                        {item.status === "pending"
                          ? "Delivery pending"
                          : item.status === "delivered"
                            ? "Delivered; answer not confirmed"
                            : item.status === "failed"
                              ? "Delivery failed"
                              : "Delivery cancelled"}
                      </span>
                      {item.status === "failed" && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={disabled || !active}
                          onClick={() => void act({ type: "delivery.retry", id: item.id })}
                        >
                          Retry delivery
                        </Button>
                      )}
                      {item.status === "failed" && !active && (
                        <Button size="sm" variant="outline" onClick={onResume}>
                          Inspect resume prerequisites
                        </Button>
                      )}
                    </div>
                  ))}
                </>
              )}
            </article>
          );
        })}
    </section>
  );
}
