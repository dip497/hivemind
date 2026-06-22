/**
 * PlanReviewBody — the annotation surface. Renders the plan as discrete blocks,
 * lets the user mark them up (whole-block pinpoint OR text-range selection →
 * comment / delete / quick-label / global comment), lists the marks in a side
 * panel, and turns them into structured feedback on "Request changes".
 *
 * Decision flow is owned by the parent tile via `onDecide(decision, feedback)`:
 *   - Approve              → onDecide("allow")
 *   - Request changes      → onDecide("deny", exportAnnotations(...))  (≥1 mark)
 *                            or a free-text box when there are no marks yet.
 */
import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { Check, MessageSquare, X, MessagesSquare } from "lucide-react";
import { parsePlanToBlocks, exportAnnotations } from "./blocks";
import { type Annotation, type PlanBlock } from "./types";
import { ReviewPopover, CommentBox, ActionToolbar } from "../review-ui";

const MarkdownPreview = lazy(() =>
  import("../markdown-preview").then((m) => ({ default: m.MarkdownPreview })),
);

const uid = () => (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2));

type Pending = {
  blockId: string | null;
  originalText: string;
  anchor: { x: number; y: number };
  stage: "choose" | "comment";
};

export function PlanReviewBody({
  plan,
  fontScale,
  sent,
  onDecide,
}: {
  plan: string;
  fontScale: number;
  sent: boolean;
  onDecide: (decision: "allow" | "deny", feedback?: string) => void;
}) {
  const blocks = useMemo(() => parsePlanToBlocks(plan), [plan]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [draft, setDraft] = useState("");
  const [freeText, setFreeText] = useState<string | null>(null); // no-mark fallback box
  const scrollRef = useRef<HTMLDivElement>(null);

  const annsFor = (id: string) => annotations.filter((a) => a.blockId === id);
  const add = (a: Omit<Annotation, "id" | "createdAt">) =>
    setAnnotations((cur) => [...cur, { ...a, id: uid(), createdAt: Date.now() }]);
  const remove = (id: string) => setAnnotations((cur) => cur.filter((a) => a.id !== id));

  const openFor = (blockId: string | null, originalText: string, clientX: number, clientY: number) => {
    const box = scrollRef.current?.getBoundingClientRect();
    setDraft("");
    setPending({
      blockId,
      originalText,
      anchor: { x: clientX - (box?.left ?? 0), y: clientY - (box?.top ?? 0) + (scrollRef.current?.scrollTop ?? 0) },
      stage: "choose",
    });
  };

  // Text selection inside a block → open the action toolbar at the selection.
  const onMouseUp = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString().trim();
    if (!text) return;
    let node = sel.anchorNode as HTMLElement | null;
    while (node && node.nodeType === 3) node = node.parentElement;
    const blockEl = node?.closest?.("[data-block-id]") as HTMLElement | null;
    if (!blockEl) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    openFor(blockEl.dataset.blockId ?? null, text, rect.left + rect.width / 2, rect.bottom);
  };

  const commit = (kind: Annotation["kind"], opts?: { comment?: string; quickLabel?: string }) => {
    if (!pending) return;
    add({ blockId: pending.blockId, kind, originalText: pending.originalText, ...opts });
    setPending(null);
    setDraft("");
    window.getSelection()?.removeAllRanges();
  };

  const requestChanges = () => {
    if (annotations.length > 0) { onDecide("deny", exportAnnotations(blocks, annotations)); return; }
    setFreeText(""); // nothing marked → let them type plain feedback
  };

  const count = annotations.length;

  return (
    <div className="flex-1 min-h-0 grid grid-cols-[1fr_232px]">
      {/* ── plan blocks ───────────────────────────────────────────────── */}
      <div
        ref={scrollRef}
        className="relative overflow-auto px-5 py-4 border-r border-[var(--color-line)]"
        style={{ zoom: fontScale }}
        onMouseUp={onMouseUp}
      >
        {blocks.map((b) => (
          <BlockView key={b.id} block={b} marks={annsFor(b.id)} onPinpoint={openFor} />
        ))}

        {pending && (
          <ReviewPopover anchor={pending.anchor} onClose={() => setPending(null)}>
            {pending.stage === "choose" ? (
              <ActionToolbar
                onComment={() => setPending({ ...pending, stage: "comment" })}
                onDelete={() => commit("deletion")}
                onQuickLabel={(label, tip) => commit("comment", { quickLabel: label, comment: tip })}
              />
            ) : (
              <CommentBox
                value={draft}
                onChange={setDraft}
                onCancel={() => setPending({ ...pending, stage: "choose" })}
                onSubmit={() => draft.trim() && commit("comment", { comment: draft.trim() })}
              />
            )}
          </ReviewPopover>
        )}
      </div>

      {/* ── annotation panel + actions ────────────────────────────────── */}
      <aside className="flex flex-col min-h-0 bg-[var(--color-bg2)]">
        <div className="px-3 py-2 border-b border-[var(--color-line)] flex items-center gap-2">
          <span className="text-[11px] font-semibold text-[var(--color-fg)]">Annotations</span>
          <span className="text-[11px] text-[var(--color-fg3)] tabular-nums">{count}</span>
          <button
            onClick={() => openForGlobal()}
            className="nodrag ml-auto inline-flex items-center gap-1 text-[10.5px] text-[var(--color-fg2)] hover:text-[var(--color-fg)] cursor-pointer"
            title="general comment about the whole plan"
          >
            <MessagesSquare size={12} /> General
          </button>
        </div>

        <div className="flex-1 overflow-auto p-2 flex flex-col gap-1.5">
          {count === 0 ? (
            <p className="text-[11px] text-[var(--color-fg3)] leading-relaxed px-1 pt-1">
              Select text in the plan, or hover a block, to comment or mark for removal. Or approve as-is.
            </p>
          ) : (
            annotations.map((a) => <AnnotationCard key={a.id} a={a} onRemove={() => remove(a.id)} />)
          )}
        </div>

        <div className="p-2 border-t border-[var(--color-line)] flex flex-col gap-1.5">
          <button
            disabled={sent}
            onClick={requestChanges}
            className="nodrag inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-[var(--color-fg)] bg-[var(--color-bg)] border border-[var(--color-line2)] rounded hover:border-[var(--color-fg3)] disabled:opacity-40 transition-colors cursor-pointer"
          >
            <MessageSquare size={13} /> Request changes{count > 0 ? ` (${count})` : ""}
          </button>
          <button
            disabled={sent}
            onClick={() => onDecide("allow")}
            className="nodrag inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-white bg-[var(--color-brand)] rounded hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity cursor-pointer"
          >
            <Check size={13} /> Approve plan
          </button>
        </div>
      </aside>

      {/* No marks → plain feedback box overlay. */}
      {freeText !== null && (
        <div className="absolute inset-0 z-50 bg-black/40 grid place-items-center p-6" onMouseDown={() => setFreeText(null)}>
          <div className="w-[440px] max-w-full bg-[var(--color-bg2)] border border-[var(--color-line)] rounded-xl p-3 flex flex-col gap-2" onMouseDown={(e) => e.stopPropagation()}>
            <span className="text-[12px] font-semibold text-[var(--color-fg)]">Request changes</span>
            <textarea
              autoFocus value={freeText} onChange={(e) => setFreeText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && freeText.trim()) onDecide("deny", freeText.trim()); if (e.key === "Escape") setFreeText(null); }}
              rows={5} placeholder="What should change? Goes back to the agent (⌘/Ctrl+Enter to send)."
              className="nodrag w-full resize-y bg-[var(--color-bg)] border border-[var(--color-line2)] rounded-md px-2.5 py-2 text-[12.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-brand)] placeholder:text-[var(--color-fg3)]"
            />
            <div className="flex items-center gap-2">
              <button onClick={() => setFreeText(null)} className="nodrag px-3 py-1.5 text-[12px] text-[var(--color-fg2)] hover:text-[var(--color-fg)] cursor-pointer">Cancel</button>
              <button disabled={!freeText.trim() || sent} onClick={() => onDecide("deny", freeText.trim())}
                className="nodrag ml-auto px-3 py-1.5 text-[12px] font-medium text-white bg-[var(--color-brand)] rounded hover:opacity-90 disabled:opacity-40 cursor-pointer">
                Send feedback
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  function openForGlobal() {
    const box = scrollRef.current?.getBoundingClientRect();
    setDraft("");
    setPending({ blockId: null, originalText: "", stage: "comment", anchor: { x: (box?.width ?? 300) / 2 - 110, y: 12 } });
  }
}

/** One plan block: rendered markdown + a hover gutter for whole-block marks +
 *  visual state for any marks anchored to it. */
function BlockView({
  block,
  marks,
  onPinpoint,
}: {
  block: PlanBlock;
  marks: Annotation[];
  onPinpoint: (blockId: string, text: string, x: number, y: number) => void;
}) {
  const deleted = marks.some((m) => m.kind === "deletion");
  const commented = marks.some((m) => m.kind === "comment");
  const accent = deleted ? "var(--color-danger, #e5484d)" : commented ? "var(--color-brand)" : "transparent";
  return (
    <div
      data-block-id={block.id}
      className="group relative rounded-md pl-3 pr-8 -ml-3 my-0.5 transition-colors hover:bg-[var(--color-bg3)]/40"
      style={{ borderLeft: `2px solid ${accent}`, opacity: deleted ? 0.55 : 1, textDecoration: deleted ? "line-through" : undefined }}
    >
      <Suspense fallback={<pre className="text-[11px] text-[var(--color-fg3)] whitespace-pre-wrap">{block.text}</pre>}>
        <MarkdownPreview source={block.raw} className="md-preview" />
      </Suspense>
      <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity flex gap-0.5">
        <button
          title="comment on this block"
          onClick={(e) => onPinpoint(block.id, block.text, e.clientX, e.clientY)}
          className="nodrag size-5 grid place-items-center rounded bg-[var(--color-bg2)] border border-[var(--color-line2)] text-[var(--color-fg3)] hover:text-[var(--color-fg)] cursor-pointer"
        >
          <MessageSquare size={11} />
        </button>
      </div>
    </div>
  );
}

function AnnotationCard({ a, onRemove }: { a: Annotation; onRemove: () => void }) {
  const tint =
    a.kind === "deletion" ? "var(--color-danger, #e5484d)" : "var(--color-brand)";
  const label = a.kind === "deletion" ? "Delete" : a.kind === "global" ? "General" : a.quickLabel ?? "Comment";
  return (
    <div className="rounded-md border border-[var(--color-line2)] bg-[var(--color-bg)] p-1.5 text-[11px]" style={{ borderLeft: `2px solid ${tint}` }}>
      <div className="flex items-center gap-1.5">
        <span className="font-medium text-[var(--color-fg)]">{label}</span>
        <button onClick={onRemove} className="nodrag ml-auto size-4 grid place-items-center rounded text-[var(--color-fg3)] hover:text-[var(--color-fg)] cursor-pointer" title="remove">
          <X size={11} />
        </button>
      </div>
      {a.originalText && (
        <div className="mt-0.5 text-[10.5px] text-[var(--color-fg3)] line-clamp-2 italic">“{a.originalText}”</div>
      )}
      {a.comment && a.kind !== "deletion" && (
        <div className="mt-0.5 text-[10.5px] text-[var(--color-fg2)] line-clamp-3">{a.comment}</div>
      )}
    </div>
  );
}

