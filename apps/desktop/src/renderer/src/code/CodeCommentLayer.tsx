/**
 * Asking about code in the Code tile: a bar over a selection (Ask an agent, Explain, Change…,
 * Comment), the box a question is written in, and the thread a gutter mark opens. Drawn over the
 * editor; the comments themselves live in each file's editor state (`code-comments.ts`).
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { codeCommentsMessage, codeRef, onCode, statusOf, type CodeComment, type ReviewIntent } from "@hivemind/core/review-shape";
import { toast } from "sonner";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import type { OpenFiles } from "../editor-files";
import { deliverToAgent } from "./review-store";
import { anchorIn, codeCommentsField, movedAnchors, setCodeComments } from "./code-comments";

/** What the editor tells the layer: each view update, and a gutter mark clicked. */
export class CommentLayerBus {
  private updates = new Set<(u: ViewUpdate) => void>();
  private opens = new Set<(ids: string[]) => void>();
  updated(u: ViewUpdate) { for (const f of this.updates) f(u); }
  openThread(ids: string[]) { for (const f of this.opens) f(ids); }
  onUpdate(f: (u: ViewUpdate) => void) { this.updates.add(f); return () => { this.updates.delete(f); }; }
  onOpen(f: (ids: string[]) => void) { this.opens.add(f); return () => { this.opens.delete(f); }; }
}

/** Store where the file's comments are now; call it only while the editor matches the disk. */
export function storeMoves(repoPath: string, state: EditorState | null): void {
  if (!state) return;
  for (const { id, to } of movedAnchors(state)) void window.hive.reviewMove(repoPath, id, to).catch(() => {});
}

type Compose = { kind: "ask" | "change" | "comment"; path: string; from: number; to: number };

const ASKS: Record<Compose["kind"], { placeholder: string; send: string; intent?: ReviewIntent }> = {
  ask: { placeholder: "Ask about these lines", send: "Send", intent: "question" },
  change: { placeholder: "What should change?", send: "Send", intent: "change" },
  comment: { placeholder: "Comment", send: "Add comment" },
};
const EXPLAIN = "Explain what these lines do and why.";

interface Props {
  repoPath: string;
  tileId?: string;
  tabs: string[];
  /** The file the editor shows, when its text is there. */
  shown: string | null;
  /** Bumped each time a file's state is put in the editor. */
  mounted: number;
  view: () => EditorView | null;
  files: () => OpenFiles;
  bus: CommentLayerBus;
  /** What the layer is drawn in; the editor fills it. */
  box: RefObject<HTMLDivElement | null>;
}

export function CodeCommentLayer({ repoPath, tileId, tabs, shown, mounted, view, files, bus, box }: Props) {
  const [comments, setComments] = useState<CodeComment[]>([]);
  const [selection, setSelection] = useState<{ from: number; to: number } | null>(null);
  const [compose, setCompose] = useState<Compose | null>(null);
  const [thread, setThread] = useState<string[] | null>(null);
  const [unsent, setUnsent] = useState<string[]>([]);
  const [, setFrame] = useState(0);

  const load = useCallback(() => {
    void window.hive.reviewList(repoPath).then((all) => setComments(all.filter(onCode)), () => {});
  }, [repoPath]);
  useEffect(() => {
    load();
    return window.hive.onFsChanged(repoPath, ({ paths }) => { if (paths.some((p) => p.endsWith("/.hivemind/review.json"))) load(); });
  }, [repoPath, load]);

  // Each open file's state holds its comments; a clean file's moved ones are stored at once.
  useEffect(() => {
    const v = view();
    const open = files();
    for (const tab of tabs) {
      if (!open.has(tab)) continue;
      open.update(tab, v, { effects: setCodeComments.of(comments.filter((c) => c.file === tab)) });
      if (!open.unsaved(tab, v)) storeMoves(repoPath, open.stateOf(tab, v));
    }
  }, [comments, tabs, mounted, repoPath, view, files]);

  // Typing redraws nothing unless something is drawn.
  const drawn = !!(selection || compose || thread);
  const drawnRef = useRef(drawn);
  drawnRef.current = drawn;
  useEffect(() => {
    const offUpdate = bus.onUpdate((u) => {
      const main = u.state.selection.main;
      setSelection((was) => (main.empty ? null : was && was.from === main.from && was.to === main.to ? was : { from: main.from, to: main.to }));
      if (drawnRef.current && (u.geometryChanged || u.viewportChanged || u.docChanged)) setFrame((n) => n + 1);
    });
    const offOpen = bus.onOpen((ids) => { setCompose(null); setThread(ids); });
    return () => { offUpdate(); offOpen(); };
  }, [bus]);
  useEffect(() => { setSelection(null); setThread(null); setCompose(null); }, [shown]);

  // Keep what is drawn beside its line while the editor scrolls.
  const scroller = view()?.scrollDOM;
  useEffect(() => {
    if (!scroller || !drawn) return;
    const moved = () => setFrame((n) => n + 1);
    scroller.addEventListener("scroll", moved, { passive: true });
    return () => scroller.removeEventListener("scroll", moved);
  }, [scroller, drawn]);

  /** Where `pos` is drawn, in the layer's own pixels (the canvas may be zoomed). */
  const at = (pos: number, below: boolean): { left: number; top: number } | null => {
    const v = view();
    const host = box.current;
    if (!v || !host) return null;
    const c = v.coordsAtPos(Math.min(pos, v.state.doc.length));
    if (!c) return null;
    const r = host.getBoundingClientRect();
    const scale = r.width / (host.offsetWidth || 1) || 1;
    return { left: Math.max(4, (c.left - r.left) / scale), top: ((below ? c.bottom : c.top) - r.top) / scale };
  };

  const send = (list: CodeComment[]) => {
    if (!list.length) return;
    const v = view();
    deliverToAgent(codeCommentsMessage(list, (c) => files().unsaved(c.file, v)), tileId);
    setUnsent((was) => was.filter((id) => !list.some((c) => c.id === id)));
  };
  const unsentComments = () => comments.filter((c) => unsent.includes(c.id) && !c.resolved);

  const add = async (kind: Compose["kind"] | "explain", from: number, to: number, body: string): Promise<CodeComment | null> => {
    const v = view();
    const path = shown;
    if (!v || !path || !body.trim()) return null;
    const doc = v.state.doc;
    const last = to > from && doc.lineAt(to).from === to ? doc.lineAt(to - 1).number : doc.lineAt(to).number;
    const anchor = anchorIn(doc, doc.lineAt(from).number, last);
    const intent = kind === "explain" ? "question" : ASKS[kind].intent;
    try {
      const made = await window.hive.reviewAdd(repoPath, { file: path, ...anchor, body: body.trim(), ...(intent ? { intent } : {}) });
      setComments((was) => [...was, made]);
      return made;
    } catch (e) {
      toast.error("Could not keep the comment", { description: (e as Error).message });
      return null;
    }
  };

  const act = async (kind: Compose["kind"] | "explain") => {
    const v = view();
    if (!v || !selection || !shown) return;
    if (kind !== "explain") { setCompose({ kind, path: shown, ...selection }); return; }
    const made = await add("explain", selection.from, selection.to, EXPLAIN);
    if (made) send([...unsentComments(), made]);
  };

  const submit = async (body: string) => {
    if (!compose) return;
    const made = await add(compose.kind, compose.from, compose.to, body);
    setCompose(null);
    if (!made) return;
    if (compose.kind === "comment") setUnsent((was) => [...was, made.id]);
    else send([...unsentComments(), made]);
    view()?.focus();
  };

  const v = view();
  const placed = v && thread ? v.state.field(codeCommentsField, false)?.filter((p) => thread.includes(p.comment.id)) ?? [] : [];
  const threadAt = placed.length ? at(Math.max(...placed.map((p) => p.to)), true) : null;
  const barAt = selection && shown && !compose && !thread ? at(selection.from, false) : null;
  const composeAt = compose ? at(compose.to, true) : null;
  const waiting = unsentComments();

  return (
    <>
      {barAt && (
        <div
          data-code-selection-bar
          className="absolute z-20 flex items-center gap-0.5 rounded-md border border-[var(--color-line2)] bg-[var(--color-bg3)] p-0.5 shadow-[var(--hm-shadow-float)]"
          style={{ left: barAt.left, top: Math.max(0, barAt.top - 28) }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <Button variant="ghost" size="2xs" onClick={() => void act("ask")}>Ask an agent</Button>
          <Button variant="ghost" size="2xs" onClick={() => void act("explain")}>Explain</Button>
          <Button variant="ghost" size="2xs" onClick={() => void act("change")}>Change…</Button>
          <Button variant="ghost" size="2xs" onClick={() => void act("comment")}>Comment</Button>
        </div>
      )}
      {compose && composeAt && (
        <ComposeBox key={`${compose.kind}:${compose.from}`} kind={compose.kind} at={composeAt} onSubmit={(b) => void submit(b)} onCancel={() => { setCompose(null); view()?.focus(); }} />
      )}
      {thread && threadAt && (
        <div
          data-code-thread
          className="absolute z-20 flex w-80 max-w-[90%] flex-col gap-2 rounded-lg border border-[var(--color-line2)] bg-[var(--color-bg2)] p-2 shadow-[var(--hm-shadow-float)]"
          style={{ left: threadAt.left, top: threadAt.top + 2 }}
          onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setThread(null); } }}
        >
          <div className="flex items-center">
            <span className="text-label text-[var(--color-fg2)]">{placed.length === 1 ? "Comment" : `${placed.length} comments`}</span>
            <Button variant="ghost" size="icon-micro" className="ml-auto" aria-label="close thread" onClick={() => setThread(null)}>×</Button>
          </div>
          {placed.map((p) => (
            <Thread key={p.comment.id} repoPath={repoPath} comment={p.comment} outdated={p.outdated} onChanged={load} onSend={() => send([p.comment])} />
          ))}
        </div>
      )}
      {waiting.length > 0 && (
        <div className="absolute bottom-2 right-3 z-20 flex items-center gap-1 rounded-md border border-[var(--color-line2)] bg-[var(--color-bg3)] p-1 shadow-[var(--hm-shadow-float)]" data-code-comments-waiting>
          <span className="px-1 text-count text-[var(--color-fg2)]">{waiting.length} comment{waiting.length === 1 ? "" : "s"} not sent</span>
          <Button size="2xs" onClick={() => send(waiting)}>Send to an agent</Button>
        </div>
      )}
    </>
  );
}

function ComposeBox({ kind, at, onSubmit, onCancel }: { kind: Compose["kind"]; at: { left: number; top: number }; onSubmit: (body: string) => void; onCancel: () => void }) {
  const [body, setBody] = useState("");
  const ask = ASKS[kind];
  return (
    <div
      data-code-compose={kind}
      className="absolute z-20 flex w-80 max-w-[90%] flex-col gap-2 rounded-lg border border-[var(--color-line2)] bg-[var(--color-bg2)] p-2 shadow-[var(--hm-shadow-float)]"
      style={{ left: at.left, top: at.top + 2 }}
    >
      <Textarea
        autoFocus
        value={body}
        placeholder={ask.placeholder}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); }
          else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (body.trim()) onSubmit(body); }
        }}
      />
      <div className="flex justify-end gap-1.5">
        <Button variant="ghost" size="xs" onClick={onCancel}>Cancel</Button>
        <Button size="xs" disabled={!body.trim()} onClick={() => onSubmit(body)}>{ask.send}</Button>
      </div>
    </div>
  );
}

function Thread({ repoPath, comment: c, outdated, onChanged, onSend }: { repoPath: string; comment: CodeComment; outdated: boolean; onChanged: () => void; onSend: () => void }) {
  const [reply, setReply] = useState("");
  const status = statusOf(c);
  const run = (what: Promise<unknown>) => void what.then(onChanged, (e: Error) => toast.error("Could not change the comment", { description: e.message }));
  return (
    <div data-code-comment={c.id} className="flex flex-col gap-1.5 border-t border-[var(--color-line)] pt-1.5 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-1.5 text-count text-[var(--color-fg3)]">
        <span className="font-mono truncate">{codeRef(c)}</span>
        {c.intent && <span>{c.intent}</span>}
        <span>{status}</span>
        {outdated && <span className="text-[var(--color-warn)]" title="Its lines are no longer in the file">outdated</span>}
      </div>
      <div className="whitespace-pre-wrap text-label text-[var(--color-fg)]">{c.body}</div>
      {(c.replies ?? []).map((r, i) => (
        <div key={i} className="ml-2 border-l border-[var(--color-line2)] pl-2 text-label">
          <span className="text-count text-[var(--color-fg3)]">{r.author}</span>
          <div className="whitespace-pre-wrap text-[var(--color-fg)]">{r.body}</div>
        </div>
      ))}
      {c.summary && <div className="text-count text-[var(--color-fg2)]">{c.summary}</div>}
      <Textarea value={reply} placeholder="Reply" className="min-h-8" onChange={(e) => setReply(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && reply.trim()) { e.preventDefault(); run(window.hive.reviewReply(repoPath, c.id, reply.trim())); setReply(""); } }} />
      <div className="flex flex-wrap gap-1">
        <Button size="2xs" variant="outline" disabled={!reply.trim()} onClick={() => { run(window.hive.reviewReply(repoPath, c.id, reply.trim())); setReply(""); }}>Reply</Button>
        {!c.resolved && <Button size="2xs" variant="outline" onClick={onSend}>Send to an agent</Button>}
        {c.resolved
          ? <Button size="2xs" variant="ghost" onClick={() => run(window.hive.reviewReopen(repoPath, c.id))}>Reopen</Button>
          : <Button size="2xs" variant="ghost" onClick={() => run(window.hive.reviewResolve(repoPath, c.id))}>Resolve</Button>}
        <Button size="2xs" variant="ghost-destructive" className="ml-auto" onClick={() => run(window.hive.reviewDelete(repoPath, c.id))}>Delete</Button>
      </div>
    </div>
  );
}
