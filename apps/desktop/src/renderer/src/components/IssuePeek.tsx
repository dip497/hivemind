import { useEffect, useRef, useState } from "react";
import { Play, FileQuestion, X } from "lucide-react";
import type { AcceptanceItem, Issue, IssueState, LinkType } from "@hivemind/core/types";
import {
  useCommentOnIssue,
  useDeleteIssue,
  useIssue,
  useLinkIssue,
  useMoveIssue,
  useUnlinkIssue,
  useUpdateIssue,
  useUpdateState,
  useWorkspaces,
} from "../queries";
import {
  STATE_COLOR,
  STATE_LABEL,
  STATE_ORDER,
  StateIcon,
  LabelChip,
  Avatar,
} from "./StateMeta";

interface Props {
  root: string | null;
  id: string | null;
  onClose: () => void;
}

export function IssuePeek({ root, id, onClose }: Props) {
  const { data: issue, isLoading, isError, error } = useIssue(root, id ?? undefined);
  const update = useUpdateState();
  const patch = useUpdateIssue();
  const comment = useCommentOnIssue();
  const del = useDeleteIssue();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't close on Esc while typing into an input — let the field swallow it.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!id) return null;

  return (
    <div className="fixed inset-0 z-40 pointer-events-none">
      <div
        onClick={onClose}
        className="absolute inset-0 bg-black/40 pointer-events-auto animate-in fade-in duration-150"
      />
      <aside
        ref={ref}
        className="absolute right-0 top-0 h-full w-[560px] max-w-[80vw] bg-[var(--color-bg2)] border-l border-[var(--color-line)] flex flex-col pointer-events-auto shadow-2xl animate-in slide-in-from-right duration-200"
      >
        {isLoading ? (
          <div className="grid place-items-center h-full text-[var(--color-fg3)] text-[12px]">loading…</div>
        ) : !issue ? (
          // Settled with no issue — not found (wrong root for this id, or it was
          // deleted), or the read errored. Either way: show it, don't hang on
          // "loading…" forever.
          <div className="grid place-items-center h-full px-6">
            <div className="flex flex-col items-center gap-3 text-center max-w-[320px]">
              <FileQuestion size={28} className="text-[var(--color-fg3)]" />
              <div className="text-[13px] font-medium text-[var(--color-fg)]">
                {isError ? "Couldn't load this issue" : "Issue not found"}
              </div>
              <p className="text-[11.5px] text-[var(--color-fg3)] break-words">
                {isError
                  ? (error instanceof Error ? error.message : String(error))
                  : `“${id}” isn't in this workspace — it may belong to a different frame or have been deleted.`}
              </p>
              <button
                onClick={onClose}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[11.5px] text-[var(--color-fg2)] hover:text-[var(--color-fg)] border border-[var(--color-line2)] hover:bg-[var(--color-bg3)] cursor-pointer"
              >
                <X size={13} /> Close
              </button>
            </div>
          </div>
        ) : (
          <>
            <header className="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-line)]">
              <span className="font-mono text-[11px] text-[var(--color-fg3)] tabular-nums">{issue.id}</span>
              {issue.github != null && (
                <span className="font-mono text-[11px] text-[var(--color-info)]">#{issue.github}</span>
              )}
              <div className="ml-auto flex items-center gap-1">
                <button
                  onClick={async () => {
                    // 1. Ensure the repo has the hive MCP + hive-work skill so a
                    //    spawned claude can actually work the issue (idempotent).
                    //    Without this, claude has no hive_* tools and silently
                    //    does nothing — the gap users hit.
                    const repoDir = root ? root.replace(/\/\.hivemind\/?$/, "") : null;
                    if (repoDir) {
                      try { await window.hive.installAgentic(repoDir); } catch { /* best-effort */ }
                    }
                    // 2. Spawn claude with the work prompt ATTACHED. The tile
                    //    delivers it to itself the first time it's ready (see
                    //    claude-bus queueWork/claimWork) — this survives the
                    //    workspace picker and never races claude+MCP startup,
                    //    unlike the old blind setTimeout(2500) send-to-"latest".
                    //    The hive-work skill auto-triggers on the issue key.
                    const work = `Work on ${issue.id}: load it via hive_get_issue, complete the acceptance criteria, and end with hive_set_state. Title: "${issue.title}".`;
                    // Route through the claude target picker (this/new when 1+,
                    // select/new when 2+, straight-spawn when none).
                    window.dispatchEvent(
                      new CustomEvent("hivemind:deliver-to-claude", { detail: { text: work } }),
                    );
                    // 3. Close the peek so the focused claude tile is visible.
                    onClose();
                  }}
                  className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md text-[11.5px] font-semibold text-white bg-[var(--color-brand)] hover:opacity-90 cursor-pointer"
                  title="Set up agents (if needed), spawn claude, and tell it to work on this issue"
                >
                  <Play size={11} fill="currentColor" strokeWidth={0} aria-hidden />
                  Work on this
                </button>
                <span aria-hidden className="mx-0.5 h-5 w-px bg-[var(--color-line2)]" />
                <button
                  onClick={() => {
                    if (!root) return;
                    if (!confirm(`Delete ${issue.id}? This removes the markdown file.`)) return;
                    del.mutate(
                      { root, id: issue.id },
                      { onSuccess: onClose },
                    );
                  }}
                  className="size-7 grid place-items-center rounded-md text-[var(--color-fg3)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-err)] cursor-pointer"
                  title="Delete issue"
                  aria-label="Delete issue"
                  disabled={del.isPending}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden><path d="M3 4h8M5 4V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1M4 4l1 8a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1l1-8" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
                <button
                  onClick={onClose}
                  className="size-7 grid place-items-center rounded-md text-[var(--color-fg3)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)] cursor-pointer"
                  title="Close (Esc)"
                  aria-label="Close (Esc)"
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
                </button>
              </div>
            </header>
            <div className="flex-1 overflow-y-auto grid grid-cols-[1fr_220px]">
              <div className="px-5 py-4 border-r border-[var(--color-line)] min-w-0">
                <EditableTitle
                  value={issue.title}
                  onSave={(v) => root && patch.mutate({ root, id: issue.id, patch: { title: v } })}
                />
                <Section title="Description">
                  <EditableDescription
                    value={issue.sections.description}
                    onSave={(v) =>
                      root && patch.mutate({ root, id: issue.id, patch: { description: v } })
                    }
                  />
                </Section>
                <Section title="Acceptance criteria">
                  <AcEditor
                    items={issue.sections.acceptanceCriteria}
                    onChange={(next) =>
                      root &&
                      patch.mutate({
                        root,
                        id: issue.id,
                        patch: { acceptanceCriteria: next },
                      })
                    }
                  />
                </Section>
                <Section title="Relations">
                  <RelationsSection root={root} issue={issue} onClose={onClose} />
                </Section>
                <Section title="Activity">
                  {issue.sections.activity.length > 0 && (
                    <ol className="space-y-2 mb-3">
                      {issue.sections.activity.slice().reverse().map((a, i) => (
                        <li key={i} className="text-[12px] text-[var(--color-fg2)]">
                          <div className="flex items-baseline gap-2">
                            <span className="font-mono text-[10.5px] text-[var(--color-fg2)]">{relTime(a.at)}</span>
                            <span className="font-medium text-[var(--color-fg)]">{a.who}</span>
                          </div>
                          <div className="mt-0.5">{a.message}</div>
                        </li>
                      ))}
                    </ol>
                  )}
                  <CommentComposer
                    pending={comment.isPending}
                    onSubmit={(msg) =>
                      root && comment.mutate({ root, id: issue.id, message: msg })
                    }
                  />
                </Section>
              </div>
              <aside className="px-4 py-4 space-y-3">
                <PropRow label="State">
                  <StateSelect
                    value={issue.state}
                    onChange={(s) => root && update.mutate({ root, id: issue.id, state: s, note: "set from peek" })}
                  />
                </PropRow>
                <PropRow label="Assignee">
                  {issue.assignee ? (
                    <div className="flex items-center gap-1.5">
                      <Avatar id={issue.assignee.id} size={18} />
                      <span className="text-[12px] text-[var(--color-fg)] truncate">{issue.assignee.id}</span>
                    </div>
                  ) : (
                    <span className="text-[11.5px] text-[var(--color-fg2)]">Unassigned</span>
                  )}
                </PropRow>
                <PropRow label="Parent">
                  {issue.parent ? (
                    <span className="font-mono text-[11px] text-[var(--color-fg)]">{issue.parent}</span>
                  ) : (
                    <span className="text-[11.5px] text-[var(--color-fg2)]">—</span>
                  )}
                </PropRow>
                <PropRow label="Labels">
                  {issue.labels.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {issue.labels.map((l) => <LabelChip key={l} label={l} />)}
                    </div>
                  ) : (
                    <span className="text-[11.5px] text-[var(--color-fg2)]">—</span>
                  )}
                </PropRow>
                <PropRow label="Created">
                  <span className="text-[11.5px] text-[var(--color-fg2)]">{relTime(issue.created)}</span>
                </PropRow>
                <PropRow label="Updated">
                  <span className="text-[11.5px] text-[var(--color-fg2)]">{relTime(issue.updated)}</span>
                </PropRow>
                {issue.github != null && (
                  <PropRow label="GitHub">
                    <span className="font-mono text-[11px] text-[var(--color-info)]">#{issue.github}</span>
                  </PropRow>
                )}
              </aside>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-5">
      <div className="u-eyebrow mb-2">{title}</div>
      {children}
    </div>
  );
}

function PropRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="u-eyebrow mb-1">{label}</div>
      {children}
    </div>
  );
}

function StateSelect({ value, onChange }: { value: IssueState; onChange: (s: IssueState) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const fn = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full inline-flex items-center gap-1.5 px-2 py-1 text-[11.5px] bg-[var(--color-bg3)] border border-[var(--color-line2)] rounded-md hover:border-[var(--color-fg3)] cursor-pointer"
        style={{ color: STATE_COLOR[value] }}
      >
        <StateIcon state={value} size={12} />
        <span>{STATE_LABEL[value]}</span>
        <svg width="9" height="9" viewBox="0 0 10 10" className="ml-auto text-[var(--color-fg3)]"><path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" /></svg>
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-full bg-[var(--color-bg3)] border border-[var(--color-line2)] rounded-md shadow-xl p-1">
          {STATE_ORDER.map((s) => (
            <button
              key={s}
              onClick={() => { onChange(s); setOpen(false); }}
              className="w-full flex items-center gap-1.5 px-1.5 py-1 rounded-md text-[11.5px] text-left cursor-pointer hover:bg-[var(--color-bg4)]"
              style={{ color: STATE_COLOR[s] }}
            >
              <StateIcon state={s} size={12} />
              <span>{STATE_LABEL[s]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Markdownish({ text }: { text: string }) {
  // minimal markdown — paragraphs, bullets, code. No external dep.
  const lines = text.trim().split("\n");
  const blocks: React.ReactNode[] = [];
  let para: string[] = [];
  let ul: string[] = [];
  const flush = () => {
    if (para.length) {
      blocks.push(<p key={blocks.length} className="text-[13px] text-[var(--color-fg)] leading-relaxed mb-2">{para.join(" ")}</p>);
      para = [];
    }
    if (ul.length) {
      blocks.push(
        <ul key={blocks.length} className="list-disc pl-5 mb-2 space-y-1 text-[13px] text-[var(--color-fg)]">
          {ul.map((b, i) => <li key={i}>{b}</li>)}
        </ul>
      );
      ul = [];
    }
  };
  for (const ln of lines) {
    if (/^\s*[-*]\s/.test(ln)) {
      if (para.length) flush();
      ul.push(ln.replace(/^\s*[-*]\s/, ""));
    } else if (!ln.trim()) {
      flush();
    } else {
      if (ul.length) flush();
      para.push(ln.trim());
    }
  }
  flush();
  return <div>{blocks}</div>;
}

// ── editable widgets ──────────────────────────────────────────────────

function EditableTitle({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  if (!editing) {
    return (
      <h1
        tabIndex={0}
        onDoubleClick={() => setEditing(true)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); setEditing(true); } }}
        title="Double-click (or Enter) to edit"
        className="text-[18px] font-semibold text-[var(--color-fg)] tracking-tight leading-tight cursor-text hover:bg-[var(--color-bg3)] focus-visible:bg-[var(--color-bg3)] rounded px-1 -mx-1"
      >
        {value}
      </h1>
    );
  }
  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft.trim() && draft !== value) onSave(draft.trim());
        setEditing(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(value);
          setEditing(false);
        }
      }}
      className="w-full text-[18px] font-semibold tracking-tight leading-tight bg-[var(--color-bg3)] border border-[var(--color-brand)] rounded px-1 -mx-1 text-[var(--color-fg)] focus:outline-none"
    />
  );
}

function EditableDescription({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  if (!editing) {
    return (
      <div className="group relative">
        {value.trim() ? (
          <Markdownish text={value} />
        ) : (
          <p className="text-[12px] text-[var(--color-fg2)] italic">No description.</p>
        )}
        <button
          onClick={() => setEditing(true)}
          className="absolute top-0 right-0 opacity-0 group-hover:opacity-100 transition-opacity text-[10.5px] text-[var(--color-fg3)] hover:text-[var(--color-fg)] px-1.5 py-0.5 bg-[var(--color-bg3)] rounded border border-[var(--color-line2)]"
        >
          edit
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <textarea
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={Math.max(4, draft.split("\n").length + 1)}
        className="w-full font-mono text-[12px] bg-[var(--color-bg)] border border-[var(--color-line2)] rounded p-2 text-[var(--color-fg)] focus:outline-none focus:border-[var(--color-brand)] focus:ring-1 focus:ring-[var(--color-brand)]"
      />
      <div className="flex gap-2 justify-end">
        <button
          onClick={() => { setDraft(value); setEditing(false); }}
          className="text-[11px] text-[var(--color-fg2)] hover:text-[var(--color-fg)] px-2 py-0.5"
        >
          Cancel
        </button>
        <button
          onClick={() => { if (draft !== value) onSave(draft); setEditing(false); }}
          className="text-[11px] font-medium text-white bg-[var(--color-brand)] hover:opacity-90 px-2 py-0.5 rounded"
        >
          Save
        </button>
      </div>
    </div>
  );
}

function AcEditor({
  items,
  onChange,
}: {
  items: AcceptanceItem[];
  onChange: (next: AcceptanceItem[]) => void;
}) {
  const [draft, setDraft] = useState("");
  function toggle(i: number) {
    onChange(items.map((c, idx) => (idx === i ? { ...c, done: !c.done } : c)));
  }
  function remove(i: number) {
    onChange(items.filter((_, idx) => idx !== i));
  }
  function add() {
    if (!draft.trim()) return;
    onChange([...items, { done: false, text: draft.trim() }]);
    setDraft("");
  }
  return (
    <>
      <ul className="space-y-1">
        {items.map((c, i) => (
          <li key={i} className="group flex items-start gap-2 text-[12.5px] text-[var(--color-fg)]">
            <button
              role="checkbox"
              aria-checked={c.done}
              aria-label={c.text}
              onClick={() => toggle(i)}
              className="mt-0.5 size-3.5 shrink-0 rounded-sm border grid place-items-center cursor-pointer"
              style={{
                background: c.done ? "var(--color-state-done)" : "transparent",
                borderColor: c.done ? "var(--color-state-done)" : "var(--color-line2)",
              }}
              title={c.done ? "Mark incomplete" : "Mark done"}
            >
              {c.done && (
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d="M2 5L4 7L8 3" stroke="#ffffff" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
              )}
            </button>
            <span className={`flex-1 ${c.done ? "text-[var(--color-fg3)] line-through" : ""}`}>{c.text}</span>
            <button
              onClick={() => remove(i)}
              aria-label={`Remove "${c.text}"`}
              className="opacity-40 group-hover:opacity-100 focus-visible:opacity-100 text-[var(--color-fg3)] hover:text-[var(--color-err)] text-[14px] leading-none cursor-pointer"
              title="Remove"
            >×</button>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder="+ Add criterion"
          className="flex-1 bg-[var(--color-bg)] border border-[var(--color-line2)] rounded px-2 py-1 text-[12px] text-[var(--color-fg)] focus:outline-none focus:border-[var(--color-brand)] focus:ring-1 focus:ring-[var(--color-brand)]"
        />
        <button
          onClick={add}
          disabled={!draft.trim()}
          className="text-[11px] px-2 py-1 rounded bg-[var(--color-bg3)] text-[var(--color-fg2)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg4)] disabled:opacity-40"
        >
          Add
        </button>
      </div>
    </>
  );
}

function CommentComposer({
  pending,
  onSubmit,
}: {
  pending: boolean;
  onSubmit: (msg: string) => void;
}) {
  const [draft, setDraft] = useState("");
  function send() {
    if (!draft.trim()) return;
    onSubmit(draft.trim());
    setDraft("");
  }
  return (
    <div className="space-y-1">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          }
        }}
        placeholder="Add a comment…  (⌘↵ to post)"
        rows={2}
        className="w-full font-mono text-[12px] bg-[var(--color-bg)] border border-[var(--color-line2)] rounded p-2 text-[var(--color-fg)] focus:outline-none focus:border-[var(--color-brand)] resize-y"
      />
      <div className="flex justify-end">
        <button
          onClick={send}
          disabled={!draft.trim() || pending}
          className="text-[11px] font-medium px-2 py-1 rounded bg-[var(--color-brand)] text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {pending ? "Posting…" : "Comment"}
        </button>
      </div>
    </div>
  );
}

// Link types a user can set by hand (moved-to/from are provenance, set by
// transfer). Reciprocal is recorded automatically on the other issue.
const LINK_TYPES: LinkType[] = ["relates", "blocks", "blocked-by", "duplicates", "parent-of", "child-of"];

function RelationsSection({ root, issue, onClose }: { root: string | null; issue: Issue; onClose: () => void }) {
  const workspaces = useWorkspaces().data ?? [];
  const move = useMoveIssue();
  const link = useLinkIssue();
  const unlink = useUnlinkIssue();
  const [linking, setLinking] = useState(false);
  const [linkId, setLinkId] = useState("");
  const [linkType, setLinkType] = useState<LinkType>("relates");
  const [dest, setDest] = useState("");

  const links = issue.links ?? [];
  const myPrefix = issue.id.split("-")[0];
  const otherWorkspaces = workspaces.filter((w) => w.prefix !== myPrefix);

  function submitLink() {
    const other = linkId.trim().toUpperCase();
    if (!root || !/^[A-Z][A-Z0-9]{1,9}-\d+(\.\d+)*$/.test(other)) return;
    link.mutate(
      { root, id: issue.id, otherId: other, type: linkType },
      { onSuccess: () => { setLinkId(""); setLinking(false); } },
    );
  }

  return (
    <div className="space-y-2">
      {links.length > 0 ? (
        <ul className="space-y-1">
          {links.map((l) => (
            <li key={`${l.id}:${l.type}`} className="group flex items-center gap-1.5 text-[12px]">
              <span className="shrink-0 rounded px-1 py-0.5 text-[9.5px] font-mono uppercase tracking-wide bg-[var(--color-bg3)] text-[var(--color-fg3)]">
                {l.type}
              </span>
              <button
                className="font-mono text-[11.5px] text-[var(--color-info)] hover:underline truncate"
                title={`open ${l.id}`}
                onClick={() => window.dispatchEvent(new CustomEvent<string>("hivemind:open-issue", { detail: l.id }))}
              >
                {l.id}
              </button>
              <button
                onClick={() => root && unlink.mutate({ root, id: issue.id, otherId: l.id })}
                aria-label={`Remove link to ${l.id}`}
                className="ml-auto opacity-40 group-hover:opacity-100 focus-visible:opacity-100 text-[var(--color-fg3)] hover:text-[var(--color-err)] text-[14px] leading-none cursor-pointer"
                title="Remove link"
              >×</button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[11.5px] text-[var(--color-fg2)] italic">No linked issues.</p>
      )}

      {linking ? (
        <div className="flex items-center gap-1.5">
          <input
            autoFocus
            value={linkId}
            onChange={(e) => setLinkId(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitLink(); if (e.key === "Escape") setLinking(false); }}
            placeholder="OTHER-ID"
            className="flex-1 min-w-0 bg-[var(--color-bg)] border border-[var(--color-line2)] rounded px-2 py-1 text-[12px] font-mono text-[var(--color-fg)] focus:outline-none focus:border-[var(--color-brand)] focus:ring-1 focus:ring-[var(--color-brand)]"
          />
          <select
            value={linkType}
            onChange={(e) => setLinkType(e.target.value as LinkType)}
            className="bg-[var(--color-bg)] border border-[var(--color-line2)] rounded px-1 py-1 text-[10.5px] text-[var(--color-fg2)] focus:outline-none focus:border-[var(--color-brand)] focus:ring-1 focus:ring-[var(--color-brand)]"
          >
            {LINK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <button
            onClick={submitLink}
            disabled={link.isPending}
            className="text-[11px] px-2 py-1 rounded bg-[var(--color-brand)] text-white hover:opacity-90 disabled:opacity-40"
          >Add</button>
        </div>
      ) : (
        <button
          onClick={() => setLinking(true)}
          className="text-[11px] text-[var(--color-fg2)] hover:text-[var(--color-fg)] px-1.5 py-0.5 rounded border border-[var(--color-line2)] hover:bg-[var(--color-bg3)]"
        >+ Link issue</button>
      )}

      {otherWorkspaces.length > 0 && (
        <div className="flex items-center gap-1.5 pt-1">
          <span className="text-[10.5px] text-[var(--color-fg2)]">Transfer:</span>
          <select
            value={dest}
            onChange={(e) => setDest(e.target.value)}
            className="bg-[var(--color-bg)] border border-[var(--color-line2)] rounded px-1 py-1 text-[10.5px] text-[var(--color-fg2)] focus:outline-none focus:border-[var(--color-brand)] focus:ring-1 focus:ring-[var(--color-brand)]"
          >
            <option value="">workspace…</option>
            {otherWorkspaces.map((w) => <option key={w.prefix} value={w.prefix}>{w.title} ({w.prefix})</option>)}
          </select>
          <button
            disabled={!root || !dest || move.isPending}
            onClick={() => root && dest && move.mutate({ root, id: issue.id, destPrefix: dest, mode: "copy" })}
            className="text-[10.5px] px-1.5 py-1 rounded bg-[var(--color-bg3)] text-[var(--color-fg2)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg4)] disabled:opacity-40"
            title="Copy this issue into the selected workspace (source kept, linked)"
          >Copy</button>
          <button
            disabled={!root || !dest || move.isPending}
            onClick={() =>
              root && dest && move.mutate(
                { root, id: issue.id, destPrefix: dest, mode: "move" },
                {
                  // Source is gone after a move — close this peek and open the
                  // freshly-created issue in its new workspace.
                  onSuccess: (res) => {
                    onClose();
                    setTimeout(() => window.dispatchEvent(new CustomEvent<string>("hivemind:open-issue", { detail: res.newId })), 60);
                  },
                },
              )
            }
            className="text-[10.5px] px-1.5 py-1 rounded bg-[var(--color-bg3)] text-[var(--color-fg2)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg4)] disabled:opacity-40"
            title="Move this issue into the selected workspace (source deleted)"
          >Move</button>
        </div>
      )}
    </div>
  );
}

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}
