/**
 * Notes pinned on the board: a person's for an agent, and an agent's for the person (`hive ctl
 * pin`). They are review comments with a place on the board (core's review), kept in the workspace,
 * where `hive ctl notes` reads and answers them. A pin follows what it is pinned to, stays one size
 * at any zoom, and opens to say what was said; a note is sent to an agent as a page's note is.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useInternalNode, useStore, ViewportPortal } from "@xyflow/react";
import { byAgent, onBoard, statusOf, type BoardComment } from "@hivemind/core/review-shape";
import { Check, MessageSquare, Trash, X } from "../components/icons";
import { Button } from "../components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { toast } from "sonner";
import type { Point } from "./board-model";

/** Where a new note goes. */
export interface NoteAt {
  on?: string;
  x: number;
  y: number;
  canvas: Point;
}

const ZOOM = (s: { transform: [number, number, number] }): number => s.transform[2];
/** How often an open note asks again: a reply may come in a folder no watch sees. */
const OPEN_NOTE_ASKS_MS = 5000;
const REVIEW_FILE_END = "/.hivemind/review.json";

/** The agents of this workspace, as a note can be sent to them. */
const agentsChanged = "hivemind:board-agents";
let agents: ReadonlyArray<{ id: string; name: string }> = [];
export function tellBoardAgents(list: ReadonlyArray<{ id: string; name: string }>): void {
  agents = list;
  window.dispatchEvent(new Event(agentsChanged));
}
function useBoardAgents(): ReadonlyArray<{ id: string; name: string }> {
  const [list, setList] = useState(agents);
  useEffect(() => {
    const changed = () => setList(agents);
    window.addEventListener(agentsChanged, changed);
    return () => window.removeEventListener(agentsChanged, changed);
  }, []);
  return list;
}

function useBoardNotes(repo: string, polling: boolean): { notes: BoardComment[]; reload: () => void } {
  const [notes, setNotes] = useState<BoardComment[]>([]);
  const reload = useCallback(() => {
    void window.hive.reviewList(repo).then((all) => setNotes(all.filter(onBoard)), () => {});
  }, [repo]);
  useEffect(() => {
    reload();
    return window.hive.onFsChanged(repo, ({ paths }) => { if (paths.some((p) => p.endsWith(REVIEW_FILE_END))) reload(); });
  }, [repo, reload]);
  useEffect(() => {
    if (!polling) return undefined;
    const t = setInterval(reload, OPEN_NOTE_ASKS_MS);
    return () => clearInterval(t);
  }, [polling, reload]);
  return { notes, reload };
}

async function sendNote(repo: string, id: string, target: string): Promise<void> {
  const text = await window.hive.reviewMessage(repo, [id]);
  if (text) window.dispatchEvent(new CustomEvent("hivemind:send-to-agent", { detail: { text, target } }));
}

/** The pinned notes of `repo`, open ones and any whose card is open. */
export function BoardNotes({ repo }: { repo: string }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const { notes, reload } = useBoardNotes(repo, openId !== null);
  const shown = useMemo(() => notes.filter((n) => !n.resolved || n.id === openId), [notes, openId]);
  useEffect(() => {
    window.addEventListener("hivemind:board-notes-changed", reload);
    return () => window.removeEventListener("hivemind:board-notes-changed", reload);
  }, [reload]);
  if (shown.length === 0) return null;
  return (
    <ViewportPortal>
      {shown.map((n) => (
        <Pin key={n.id} note={n} repo={repo} open={n.id === openId} onToggle={() => setOpenId((cur) => (cur === n.id ? null : n.id))} onChange={reload} />
      ))}
    </ViewportPortal>
  );
}

function Pin({ note, repo, open, onToggle, onChange }: { note: BoardComment; repo: string; open: boolean; onToggle: () => void; onChange: () => void }) {
  const node = useInternalNode(note.board.on ?? "");
  const zoom = useStore(ZOOM);
  // What it was pinned to is gone: it stays out of the way, in `hive ctl notes`.
  if (note.board.on && !node) return null;
  const x = (node?.internals.positionAbsolute.x ?? 0) + note.board.x;
  const y = (node?.internals.positionAbsolute.y ?? 0) + note.board.y;
  return (
    <div className="nodrag nopan absolute left-0 top-0" style={{ transform: `translate(${x}px, ${y}px) scale(${1 / zoom})`, transformOrigin: "0 0", pointerEvents: "all", zIndex: 1200 }} data-board-note={note.id} data-note-status={statusOf(note)}>
      <button type="button" aria-label={`note: ${note.body.slice(0, 60)}`} aria-expanded={open} data-note-pin onClick={onToggle}
        className={`flex size-7 -translate-x-1/2 -translate-y-full items-center justify-center rounded-full rounded-bl-none shadow-[var(--hm-shadow-popover)] ${byAgent(note) ? "bg-[var(--color-accent)]" : "bg-[var(--color-warn)]"} text-[var(--color-bg)]`}>
        <MessageSquare className="size-3.5" />
      </button>
      {open && <NoteCard note={note} repo={repo} onClose={onToggle} onChange={onChange} />}
    </div>
  );
}

function NoteCard({ note, repo, onClose, onChange }: { note: BoardComment; repo: string; onClose: () => void; onChange: () => void }) {
  const agentsHere = useBoardAgents();
  const [reply, setReply] = useState("");
  const [target, setTarget] = useState(agentsHere[0]?.id ?? "");
  const [sent, setSent] = useState(false);
  const act = (done: Promise<unknown>) => void done.then(onChange, () => {});
  return (
    <div className="hm-island absolute left-3 top-0 flex w-[300px] flex-col gap-2 rounded-xl p-3 text-label text-[var(--color-fg)]" data-note-card>
      <div className="flex items-center gap-1 text-count text-[var(--color-fg3)]">
        <span className="min-w-0 flex-1 truncate">{note.author === "you" ? "You" : note.author}{note.board.what ? ` on ${note.board.what}` : ""}</span>
        <span data-note-state>{statusOf(note)}</span>
        <Button variant="ghost" size="icon-2xs" aria-label="close note" onClick={onClose}><X /></Button>
      </div>
      <p className="whitespace-pre-wrap break-words">{note.body}</p>
      {(note.replies ?? []).map((r, i) => (
        <p key={i} className="whitespace-pre-wrap break-words border-l-2 border-[var(--color-line2)] pl-2" data-note-reply><span className="text-[var(--color-fg3)]">{r.author === "you" ? "You" : r.author}: </span>{r.body}</p>
      ))}
      {note.summary && <p className="text-[var(--color-fg2)]" data-note-summary>{note.summary}</p>}
      <textarea value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply" aria-label="reply" rows={2}
        className="nodrag nopan nowheel resize-none rounded-md bg-[var(--color-bg2)] p-2 outline-none" />
      <div className="flex items-center gap-1">
        {!note.resolved
          ? <Button size="xs" variant="ghost" onClick={() => act(window.hive.reviewResolve(repo, note.id))}><Check />Done</Button>
          : <Button size="xs" variant="ghost" onClick={() => act(window.hive.reviewReopen(repo, note.id))}>Reopen</Button>}
        <Button size="xs" variant="ghost" aria-label="delete note" onClick={() => act(window.hive.reviewDelete(repo, note.id))}><Trash /></Button>
        <span className="flex-1" />
        {reply.trim() && <Button size="xs" variant="secondary" data-note-send-reply onClick={() => { const body = reply.trim(); setReply(""); act(window.hive.reviewReply(repo, note.id, body)); }}>Reply</Button>}
      </div>
      {!note.resolved && agentsHere.length > 0 && (
        <div className="flex items-center gap-1">
          <Select value={target} onValueChange={(v) => { setTarget(v); setSent(false); }}>
            <SelectTrigger size="sm" aria-label="send to agent" className="min-w-0 flex-1" data-note-agent><SelectValue /></SelectTrigger>
            <SelectContent>{agentsHere.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent>
          </Select>
          <Button size="xs" variant="secondary" disabled={!target} data-note-send onClick={() => { void sendNote(repo, note.id, target).then(() => setSent(true)); }}>{sent ? "Sent" : "Send"}</Button>
        </div>
      )}
    </div>
  );
}

/** The choice of sending the note to no agent: a list item's value cannot be empty. */
const NOBODY = "nobody";

/** Writing a new note, where it was asked for; sent to the agent chosen, or left for one to find. */
export function NoteDraft({ repo, at, onDone }: { repo: string; at: NoteAt; onDone: () => void }) {
  const agentsHere = useBoardAgents();
  const zoom = useStore(ZOOM);
  const [body, setBody] = useState("");
  const [target, setTarget] = useState(() => (at.on && agentsHere.some((a) => a.id === at.on) ? at.on : agentsHere[0]?.id ?? ""));
  const [failed, setFailed] = useState<string | null>(null);
  const save = async () => {
    const words = body.trim();
    if (!words) return;
    try {
      const note = await window.hive.boardNote(repo, { body: words, ...(at.on ? { on: at.on } : {}), at: { x: at.x, y: at.y } });
      if (target) await sendNote(repo, note.id, target);
      window.dispatchEvent(new Event("hivemind:board-notes-changed"));
      toast(target ? "Note pinned and sent" : "Note pinned", {
        action: { label: "Undo", onClick: () => { void window.hive.reviewDelete(repo, note.id).then(() => window.dispatchEvent(new Event("hivemind:board-notes-changed"))); } },
      });
      onDone();
    } catch (e) {
      setFailed((e as Error).message);
    }
  };
  return (
    <ViewportPortal>
      <div className="hm-island nodrag nopan absolute left-0 top-0 flex w-[300px] flex-col gap-2 rounded-xl p-3 text-label" data-note-card data-note-draft
        style={{ transform: `translate(${at.canvas.x}px, ${at.canvas.y}px) scale(${1 / zoom})`, transformOrigin: "0 0", pointerEvents: "all", zIndex: 1200 }}>
        <textarea autoFocus value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder="Say what you mean" aria-label="note"
          className="nodrag nopan nowheel resize-none rounded-md bg-[var(--color-bg2)] p-2 text-[var(--color-fg)] outline-none"
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.stopPropagation(); onDone(); }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); }
          }} />
        {agentsHere.length > 0 && (
          <Select value={target || NOBODY} onValueChange={(v) => setTarget(v === NOBODY ? "" : v)}>
            <SelectTrigger size="sm" aria-label="send to agent" className="w-full" data-note-agent><SelectValue /></SelectTrigger>
            <SelectContent>
              {agentsHere.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
              <SelectItem value={NOBODY}>Nobody yet</SelectItem>
            </SelectContent>
          </Select>
        )}
        {failed && <p className="text-[var(--color-err)]" role="alert">{failed}</p>}
        <div className="flex justify-end gap-1">
          <Button size="xs" variant="ghost" onClick={onDone}>Cancel</Button>
          <Button size="xs" variant="secondary" disabled={!body.trim()} data-note-save onClick={() => void save()}>{target ? "Send" : "Pin"}</Button>
        </div>
      </div>
    </ViewportPortal>
  );
}
