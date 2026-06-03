/**
 * Canvas overlays — the background-event Toast stack and the empty-canvas
 * call-to-action. Pure presentational; driven by props (Canvas owns the toast
 * queue + the spawn actions). Extracted to keep Canvas.tsx focused.
 */
import { Sparkles } from "lucide-react";
import { useTileFocus } from "./canvas-camera";
import type { TileStatusKind } from "./agent-status-bus";

// ── Agent awareness (ported concept from herdr) ─────────────────────────────
type ChipMeta = { label: string; status: TileStatusKind; seen: boolean };

/** Map a tile's status (+ done-unseen flag) to dot color / pulse / short label.
 *  herdr's 4-state model: working (amber) · needs-you (red) · done-unseen
 *  (blue) · idle-seen (green). exited = gray. */
function statusViz(m?: ChipMeta): { color: string; pulse: boolean; text: string } {
  if (!m) return { color: "var(--color-fg3)", pulse: false, text: "…" };
  switch (m.status) {
    case "working":
      // Working is steady amber, NOT pulsing — reserve motion for the
      // actionable "needs you" state only (pulsing everything is the slop tell).
      return { color: "var(--color-warn)", pulse: false, text: "working" };
    case "blocked":
    case "permission":
    case "question":
      return { color: "var(--color-err)", pulse: true, text: "needs you" };
    case "exited":
      return { color: "var(--color-fg3)", pulse: false, text: "exited" };
    case "idle":
    default:
      // "done" (finished while unseen) is informational, not actionable — it
      // gets a distinct sky accent + a ring (see SessionChips) but does NOT
      // pulse. Only "needs you" (actionable) pulses.
      return m.seen
        ? { color: "var(--color-ok)", pulse: false, text: "idle" }
        : { color: "var(--color-accent)", pulse: false, text: "done" };
  }
}

/** Background-event toast stack. Blocked = red (needs you); done = blue. Click
 *  to fly to the tile + dismiss. */
export function Toasts({
  toasts,
  onDismiss,
  onView,
}: {
  toasts: { id: string; tileId: string; label: string; status: TileStatusKind }[];
  onDismiss: (id: string) => void;
  onView: (id: string) => void;
}) {
  const focus = useTileFocus();
  return (
    <div className="flex flex-col items-end gap-1.5 max-h-[60vh] overflow-y-auto">
      {toasts.map((t) => {
        const v = statusViz({ label: t.label, status: t.status, seen: false });
        const needsYou =
          t.status === "blocked" || t.status === "permission" || t.status === "question";
        return (
          <div
            key={t.id}
            role="button"
            tabIndex={0}
            onClick={() => { focus(t.tileId); onView(t.tileId); }}
            onKeyDown={(ev) => { if (ev.key === "Enter") { focus(t.tileId); onView(t.tileId); } }}
            className="hm-island group flex items-center gap-2 pl-2.5 pr-1.5 py-1.5 cursor-pointer min-w-[180px]"
            style={{ borderColor: v.color }}
          >
            <span
              aria-hidden
              className={`size-2 rounded-full ${v.pulse ? "animate-pulse" : ""}`}
              style={{ background: v.color }}
            />
            <div className="flex flex-col leading-tight">
              <span className="font-mono text-[11px] text-[var(--color-fg)]">{t.label}</span>
              <span className="text-[10px]" style={{ color: v.color }}>
                {needsYou ? "needs your input" : "finished — click to view"}
              </span>
            </div>
            <button
              onClick={(ev) => { ev.stopPropagation(); onDismiss(t.id); }}
              className="ml-auto text-[var(--color-fg3)] hover:text-[var(--color-fg)] opacity-0 group-hover:opacity-100 transition-opacity"
              title="dismiss"
            >×</button>
          </div>
        );
      })}
    </div>
  );
}

export function CanvasEmptyState({
  repoPath,
  onShowTree,
  onShowShell,
  onShowDiff,
  onSpawnClaude,
  onInitWorkspace,
}: {
  repoPath: string | null;
  onShowTree: () => void;
  onShowShell: () => void;
  onShowDiff: () => void;
  onSpawnClaude: () => void;
  /** When set (folder open, no .hivemind/), surface an init action. */
  onInitWorkspace?: () => void;
}) {
  // Hierarchy, not a 4-up card grid: one confident primary action (spawn an
  // agent) sits above a quiet row of secondary surface links. Asymmetry +
  // clear weight reads as designed, not generated.
  const secondary = [
    { label: "Open terminal", hint: "⌘T", action: onShowShell, disabled: false },
    { label: "Open workbench", hint: "⌘B", action: onShowTree, disabled: !repoPath },
    { label: "Open diff", hint: "⌘D", action: onShowDiff, disabled: !repoPath },
  ];
  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center">
      <div className="pointer-events-auto w-full max-w-[440px] px-8">
        <div className="u-eyebrow mb-2">Empty canvas</div>
        <h2 className="text-[20px] font-semibold text-[var(--color-fg)] tracking-tight leading-tight">
          Start with an agent.
        </h2>
        <p className="text-[12.5px] text-[var(--color-fg2)] mt-1.5 leading-relaxed">
          Nothing renders until you ask for it. Spawn Claude, or mount a tool below.
        </p>

        {/* Primary: full-width confident action */}
        <button
          onClick={onSpawnClaude}
          className="mt-5 w-full flex items-center gap-3 rounded-lg border border-[var(--color-line2)] bg-[var(--color-bg3)] hover:border-[var(--color-brand)] hover:bg-[var(--color-bg4)] transition-colors px-3.5 py-3 text-left group"
        >
          <span aria-hidden className="grid place-items-center size-8 shrink-0 rounded-md bg-[var(--color-bg4)] text-[var(--color-brand)] group-hover:bg-[var(--color-brand)] group-hover:text-white transition-colors">
            <Sparkles size={16} />
          </span>
          <span className="flex-1 min-w-0">
            <span className="block text-[13px] font-medium text-[var(--color-fg)]">Talk to Claude</span>
            <span className="block text-[11.5px] text-[var(--color-fg3)] leading-snug">A dedicated session in its own tile</span>
          </span>
          <kbd className="font-mono text-[10px] text-[var(--color-fg3)] group-hover:text-[var(--color-fg2)] transition-colors shrink-0">⌘\</kbd>
        </button>

        {/* When launched in a non-hivemind folder, surface init right next to
            the primary action. This is the empty-state path the removed top-left
            switcher used to own; the ⌘K palette has the same item too. */}
        {onInitWorkspace && (
          <button
            onClick={onInitWorkspace}
            className="mt-2 w-full flex items-center gap-3 rounded-lg border border-[var(--color-line2)] hover:border-[var(--color-brand)] hover:bg-[var(--color-bg3)] transition-colors px-3.5 py-2.5 text-left group"
          >
            <span aria-hidden className="grid place-items-center size-7 shrink-0 rounded-md bg-[var(--color-bg3)] text-[var(--color-warn)] group-hover:bg-[var(--color-brand)] group-hover:text-white transition-colors">
              <Sparkles size={14} />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-[12.5px] font-medium text-[var(--color-fg)]">Initialize workspace here…</span>
              <span className="block text-[11px] text-[var(--color-fg3)] leading-snug">Creates a .hivemind/ so issues + agents can run</span>
            </span>
          </button>
        )}

        {/* Secondary: quiet horizontal rule of links */}
        <div className="mt-3 flex items-center gap-1">
          {secondary.map((s) => (
            <button
              key={s.label}
              onClick={s.action}
              disabled={s.disabled}
              title={s.disabled ? "needs an open repo" : s.label}
              className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11.5px] transition-colors ${
                s.disabled
                  ? "text-[var(--color-fg3)] opacity-40 cursor-not-allowed"
                  : "text-[var(--color-fg2)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)]"
              }`}
            >
              {s.label}
              <kbd className="font-mono text-[9.5px] text-[var(--color-fg3)]">{s.hint}</kbd>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
