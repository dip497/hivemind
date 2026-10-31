/**
 * Notes on a Browser tile's page: point at an element, at several (Ctrl or ⌘ held) or drag over an
 * area, say what to do, and send the notes to an agent. They are review comments on the page
 * (core's review), kept in the workspace, where `hive review` reads and answers them; their pins
 * on the page show where each stands. What is on the page is read in main (page-notes.ts).
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { byAgent, onPage, statusOf, type PageBox, type PageComment, type PageElement, type ReviewIntent } from "@hivemind/core/review-shape";
import { pageFileUrl } from "../../shared/page-file-url";
import { Bot, Check, MessageSquare, Pause, Play, Trash, X as XIcon } from "./components/icons";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";

/** A pointer that moves this far while pressed is dragging an area, not clicking. */
const DRAG_PX = 8;

/** What a note in the making points at. */
interface Draft {
  elements: PageElement[];
  area?: PageBox;
  /** Where its box shows, in the layer's pixels. */
  at: { x: number; y: number };
}

/** The page's notes in this workspace, followed as they change on disk. */
export function usePageNotes(repoPath: string, url: string | undefined): [PageComment[], () => void] {
  const [notes, setNotes] = useState<PageComment[]>([]);
  const load = useCallback(() => {
    void window.hive.reviewList(repoPath).then(
      (all) => setNotes(all.filter((c): c is PageComment => onPage(c) && c.page.url === url)),
      () => {},
    );
  }, [repoPath, url]);
  useEffect(() => {
    load();
    return window.hive.onFsChanged(repoPath, ({ paths }) => { if (paths.some((p) => p.endsWith("/.hivemind/review.json"))) load(); });
  }, [repoPath, load]);
  return [notes, load];
}

const INTENTS: { id: ReviewIntent; label: string }[] = [{ id: "fix", label: "Fix" }, { id: "change", label: "Change" }, { id: "question", label: "Question" }];

/** The box a note is written in, beside what it points at. */
function NoteBox({ draft, onSave, onCancel }: { draft: Draft; onSave: (body: string, intent: ReviewIntent) => void; onCancel: () => void }) {
  const [body, setBody] = useState("");
  const [intent, setIntent] = useState<ReviewIntent>("fix");
  const what = draft.area ? `Area, ${draft.elements.length} element${draft.elements.length === 1 ? "" : "s"}` : draft.elements.map((e) => e.name).join(", ");
  return (
    <div
      data-note-box
      className="absolute z-20 w-72 rounded-lg border border-[var(--color-line2)] bg-[var(--color-bg2)] p-2 shadow-lg flex flex-col gap-2"
      style={{ left: draft.at.x, top: draft.at.y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="text-label text-[var(--color-fg2)] truncate" title={what}>{what}</div>
      <Textarea
        autoFocus
        value={body}
        placeholder="What should change?"
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && body.trim()) { e.preventDefault(); onSave(body, intent); }
          if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
        }}
        className="nodrag"
      />
      <div className="flex items-center gap-1">
        {INTENTS.map((i) => (
          <Button key={i.id} size="xs" variant={intent === i.id ? "secondary" : "ghost"} aria-pressed={intent === i.id} onClick={() => setIntent(i.id)}>{i.label}</Button>
        ))}
        <span className="flex-1" />
        <Button size="xs" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button size="xs" disabled={!body.trim()} onClick={() => onSave(body, intent)}>Add note</Button>
      </div>
    </div>
  );
}

/** Over the page while annotating: what the pointer is on is outlined; a click notes it, Ctrl or ⌘
 *  and a click gathers several, and a drag notes an area. */
function AnnotateLayer({ tileId, repoPath, onNoted }: { tileId: string; repoPath: string; onNoted: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [gathered, setGathered] = useState<PageElement[]>([]);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x: number; y: number } | null>(null);
  const press = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef(0);
  const [error, setError] = useState<string | null>(null);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
  };
  const boxAt = (x: number, y: number, w: number, h: number) => ({ x: Math.min(x, w - 300), y: Math.min(y + 12, h - 160) });

  useEffect(() => () => { cancelAnimationFrame(frame.current); void window.hive.browserHighlight(tileId, null).catch(() => {}); }, [tileId]);

  const onMove = (e: ReactPointerEvent) => {
    const p = local(e);
    if (press.current && (drag || Math.hypot(p.x - press.current.x, p.y - press.current.y) > DRAG_PX)) {
      setDrag({ x0: press.current.x, y0: press.current.y, x: p.x, y: p.y });
      return;
    }
    if (draft) return;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      void window.hive.browserHighlight(tileId, { fx: Math.min(1, Math.max(0, p.x / p.w)), fy: Math.min(1, Math.max(0, p.y / p.h)) }).catch(() => {});
    });
  };

  const onUp = async (e: ReactPointerEvent) => {
    const start = press.current;
    press.current = null;
    if (!start || draft) return;
    const p = local(e);
    setError(null);
    try {
      if (drag) {
        setDrag(null);
        const x = Math.min(drag.x0, p.x), y = Math.min(drag.y0, p.y);
        const w = Math.abs(p.x - drag.x0), h = Math.abs(p.y - drag.y0);
        const got = await window.hive.browserPickArea(tileId, x / p.w, y / p.h, w / p.w, h / p.h);
        setDraft({ elements: got.elements, area: got.area, at: boxAt(x, y + h, p.w, p.h) });
        return;
      }
      const el = await window.hive.browserPick(tileId, p.x / p.w, p.y / p.h);
      if (!el) return;
      if (e.ctrlKey || e.metaKey) {
        setGathered((g) => (g.some((o) => o.selector === el.selector) ? g.filter((o) => o.selector !== el.selector) : [...g, el]));
        return;
      }
      const elements = gathered.some((o) => o.selector === el.selector) ? gathered : [...gathered, el];
      setGathered([]);
      setDraft({ elements, at: boxAt(p.x, p.y, p.w, p.h) });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const save = async (body: string, intent: ReviewIntent) => {
    if (!draft) return;
    try {
      await window.hive.browserNote(tileId, repoPath, { body: body.trim(), intent, elements: draft.elements, ...(draft.area ? { area: draft.area } : {}) });
      setDraft(null);
      onNoted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      ref={ref}
      data-annotate-layer
      className="nodrag nopan nowheel absolute inset-0 z-10 cursor-crosshair"
      style={{ touchAction: "none" }}
      // What the layer takes is a note, never a click on the page under it.
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      onMouseMove={(e) => e.stopPropagation()}
      onPointerDown={(e) => { if (e.button === 0 && !draft) { press.current = local(e); (e.target as HTMLElement).setPointerCapture?.(e.pointerId); } }}
      onPointerMove={onMove}
      onPointerUp={(e) => void onUp(e)}
      onPointerLeave={() => { if (!press.current) void window.hive.browserHighlight(tileId, null).catch(() => {}); }}
      onKeyDown={(e) => { if (e.key === "Escape") { setDraft(null); setGathered([]); } }}
      tabIndex={-1}
    >
      {drag && (
        <div
          data-annotate-area
          className="absolute border-2 border-dashed border-[var(--color-accent)] bg-[color-mix(in_oklab,var(--color-accent)_12%,transparent)] pointer-events-none"
          style={{ left: Math.min(drag.x0, drag.x), top: Math.min(drag.y0, drag.y), width: Math.abs(drag.x - drag.x0), height: Math.abs(drag.y - drag.y0) }}
        />
      )}
      {gathered.length > 0 && !draft && (
        <div data-annotate-gathered className="absolute left-2 top-2 rounded-md bg-[var(--color-bg2)] border border-[var(--color-line2)] px-2 py-1 text-label pointer-events-none">
          {gathered.length} picked: click one more to write the note
        </div>
      )}
      {error && <div role="alert" className="absolute left-2 bottom-2 rounded-md bg-[var(--color-bg2)] border border-[var(--color-err)] px-2 py-1 text-label text-[var(--color-err)]">{error}</div>}
      {draft && <NoteBox draft={draft} onSave={(b, i) => void save(b, i)} onCancel={() => setDraft(null)} />}
    </div>
  );
}

const STATUS_WORD = { open: "Open", seen: "Seen", resolved: "Done", dismissed: "Dismissed" } as const;

/** The proof kept on a note: a video plays here, an image shows. */
function NoteAttachments({ repoPath, names }: { repoPath: string; names: string[] }) {
  return (
    <div className="flex flex-col gap-1" data-note-attachments>
      {names.map((name) => {
        const src = window.hive.resourceUrl(pageFileUrl(repoPath, name));
        const look = "nodrag nopan max-h-40 max-w-full self-start rounded-md border border-[var(--color-line)]";
        return /\.(webm|mp4)$/.test(name)
          ? <video key={name} src={src} controls preload="metadata" className={look} data-note-attachment={name} />
          : <img key={name} src={src} alt={name} className={look} data-note-attachment={name} />;
      })}
    </div>
  );
}

/** The notes on this page: where each stands, and what can be done with it. */
function NotesList({ repoPath, notes, onChanged }: { repoPath: string; notes: PageComment[]; onChanged: () => void }) {
  const act = (p: Promise<unknown>) => void p.then(onChanged, onChanged);
  if (!notes.length) return <p className="px-3 py-2 text-label text-[var(--color-fg3)]">No notes on this page yet.</p>;
  return (
    <ol className="flex flex-col divide-y divide-[var(--color-line)]" data-page-notes-list>
      {notes.map((c, i) => {
        const status = statusOf(c);
        return (
          <li key={c.id} className="px-3 py-2 flex flex-col gap-1" data-page-note={c.id} data-status={status}>
            <div className="flex items-center gap-2 text-label">
              <span className="font-semibold">{i + 1}</span>
              <span className="text-[var(--color-fg3)] truncate flex-1">{c.page.area ? "Area" : c.page.elements[0]?.name}</span>
              {byAgent(c) && <span className="flex items-center gap-1 text-[var(--color-fg2)]" data-note-author title={`Left by the agent ${c.author}`}><Bot className="size-3" />{c.author}</span>}
              <span className="text-[var(--color-fg2)]">{STATUS_WORD[status]}</span>
            </div>
            <div className="text-body whitespace-pre-wrap">{c.body}</div>
            {c.attachments?.length ? <NoteAttachments repoPath={repoPath} names={c.attachments} /> : null}
            {c.summary && <div className="text-label text-[var(--color-fg2)]">↳ {c.summary}</div>}
            {(c.replies ?? []).map((r) => <div key={r.at} className="text-label text-[var(--color-fg2)]">↳ {r.author}: {r.body}</div>)}
            <div className="flex gap-1">
              {status === "resolved" || status === "dismissed"
                ? <Button size="xs" variant="ghost" onClick={() => act(window.hive.reviewReopen(repoPath, c.id))}>Reopen</Button>
                : <Button size="xs" variant="ghost" onClick={() => act(window.hive.reviewResolve(repoPath, c.id))}><Check />Done</Button>}
              <Button size="xs" variant="ghost" aria-label="delete note" onClick={() => act(window.hive.reviewDelete(repoPath, c.id))}><Trash /></Button>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** A Browser tile's notes: its toolbar button, the annotate bar under the address bar (with the
 *  page's notes), the layer over the page, and the page's pins. */
export function usePageAnnotate({ tileId, repoPath, url, loads }: {
  tileId: string;
  repoPath: string;
  url: string | undefined;
  /** Counts the page's loads: a new document has none of the pins. */
  loads: number;
}): { button: ReactNode; bar: ReactNode; layer: ReactNode } {
  const [annotating, setAnnotating] = useState(false);
  const [still, setStill] = useState(false);
  const [notes, reload] = usePageNotes(repoPath, url);
  const [sent, setSent] = useState<string | null>(null);

  useEffect(() => {
    const pins = notes.map((c, i) => ({ n: i + 1, status: statusOf(c), selector: c.page.elements[0]?.selector, box: c.page.area ?? c.page.elements[0]!.box, byAgent: byAgent(c) }));
    void window.hive.browserPins(tileId, pins).catch(() => {});
  }, [tileId, notes, loads]);
  useEffect(() => { if (!annotating && still) { setStill(false); void window.hive.browserHoldStill(tileId, false).catch(() => {}); } }, [annotating, still, tileId]);

  const open = notes.filter((c) => !c.resolved);
  const send = async () => {
    const text = await window.hive.reviewMessage(repoPath, open.map((c) => c.id));
    if (!text) return;
    window.dispatchEvent(new CustomEvent("hivemind:deliver-to-agent", { detail: { text } }));
    setSent(`${open.length} sent`);
  };

  return {
    button: (
      <Button variant={annotating ? "secondary" : "ghost"} size="icon-2xs" className="nodrag" aria-pressed={annotating}
        onClick={() => setAnnotating((v) => !v)} aria-label="annotate" title="Notes on this page for an agent">
        <MessageSquare />
      </Button>
    ),
    bar: annotating && (
      <div className="flex flex-col border-b border-[var(--color-line)] bg-[var(--color-bg4)]" data-annotate-bar>
        <div className="h-8 flex items-center gap-1 px-2 text-label">
          <span className="text-[var(--color-fg2)] truncate flex-1">Click to note · Ctrl or ⌘ and click for several · drag over an area</span>
          <Button size="xs" variant={still ? "secondary" : "ghost"} aria-pressed={still} className="nodrag"
            onClick={() => { const next = !still; setStill(next); void window.hive.browserHoldStill(tileId, next).catch(() => {}); }}
            title="Hold the page's animations and videos still">{still ? <Play /> : <Pause />}{still ? "Let go" : "Hold still"}</Button>
          <Button size="xs" className="nodrag" disabled={!open.length} onClick={() => void send()} data-send-notes>
            <Bot />Send {open.length || ""} to an agent
          </Button>
          {sent && <span className="text-[var(--color-fg3)]">{sent}</span>}
          <Button size="icon-2xs" variant="ghost" className="nodrag" aria-label="stop annotating" onClick={() => setAnnotating(false)}><XIcon /></Button>
        </div>
        <div className="max-h-48 overflow-auto border-t border-[var(--color-line)]"><NotesList repoPath={repoPath} notes={notes} onChanged={reload} /></div>
      </div>
    ),
    layer: annotating && <AnnotateLayer tileId={tileId} repoPath={repoPath} onNoted={() => { setSent(null); reload(); }} />,
  };
}
