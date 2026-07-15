/**
 * Canvas overlays — the background-event Toast stack and the empty-canvas
 * call-to-action. Pure presentational; driven by props (Canvas owns the toast
 * queue + the spawn actions). Extracted to keep Canvas.tsx focused.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { AlertCircle, CheckCircle2, AlertTriangle, Sparkles, X } from "lucide-react";
import { useTileFocus } from "./canvas-camera";
import { toastKindOf, toastTtlMs, type Toast, type NoticeKind } from "./useAgentAwareness";

// ── Agent awareness (ported concept from herdr) ─────────────────────────────

/** Icon + verb per notice class. ONE accent (the app brand, set in CSS) is used
 *  across every kind — the kind is encoded by the icon SHAPE + the verb text
 *  (and a pulse on needs-you), never by a competing second color. Needs-you
 *  pulses (actionable); done/error are steady — only needs-you earns motion
 *  (pulsing everything is the slop tell). */
const NOTICE: Record<NoticeKind, { Icon: typeof AlertCircle; verb: string; pulse: boolean }> = {
  needs: { Icon: AlertCircle, verb: "needs your input", pulse: true },
  done: { Icon: CheckCircle2, verb: "finished — click to view", pulse: false },
  error: { Icon: AlertTriangle, verb: "failed — click to view", pulse: false },
};

/** "just now" / "Ns ago" — coarse, auto-updates on a 1s tick (Toasts only mounts
 *  while there's ≥1 toast, so the ticker costs nothing when the stack is empty). */
function relTime(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 2) return "just now";
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

/** Background-event toast stack — borderless glass cards. Click to fly to the
 *  tile + mark seen; hover the [×] to dismiss. One accent (the app brand) tints
 *  the icon, verb, and the TTL line; see `.hm-toast` in styles.css. */
/** Identity for the title — never a raw tile id (the status-bus fallback before a
 *  label has published), which isn't a name. */
function displayName(label: string): string {
  return label.startsWith("tile-") ? "agent" : label;
}

/** One toast card. Owns its own PAUSABLE auto-dismiss timer: it stops while the
 *  pointer is over the card (you're reading it / reaching for ×) AND while the
 *  window is blurred (you're away — the OS popup has it), and resumes with the
 *  remaining time. The countdown bar pauses in lockstep via a `.paused` class, so
 *  the visible progress always matches the real timer. (Emil/Sonner: a toast must
 *  never vanish under the pointer.) */
function ToastCard({
  t, now, leaving, onExpire, onFinish, onView,
}: {
  t: Toast;
  now: number;
  leaving: boolean;
  onExpire: (id: string) => void;
  onFinish: (id: string) => void;
  onView: (id: string) => void;
}) {
  const focus = useTileFocus();
  const k = toastKindOf(t);
  const { Icon, verb, pulse } = NOTICE[k];
  const ttl = toastTtlMs(t);
  const [hovered, setHovered] = useState(false);
  const [winBlurred, setWinBlurred] = useState(false);
  const paused = hovered || winBlurred;
  const remainingRef = useRef(ttl);
  const startRef = useRef(0);

  // Pause on window blur/focus (you're away → let the OS notification carry it).
  useEffect(() => {
    const blur = () => setWinBlurred(true);
    const focusIn = () => setWinBlurred(false);
    window.addEventListener("blur", blur);
    window.addEventListener("focus", focusIn);
    return () => { window.removeEventListener("blur", blur); window.removeEventListener("focus", focusIn); };
  }, []);

  // The pausable countdown. While running, a timeout fires onExpire; when it
  // PAUSES (or unmounts) the cleanup banks the elapsed time into `remaining`, so
  // resuming continues rather than restarting. leaving → no timer (exit playing).
  useEffect(() => {
    if (leaving || paused || remainingRef.current <= 0) return;
    startRef.current = Date.now();
    const id = setTimeout(() => onExpire(t.id), remainingRef.current);
    return () => {
      clearTimeout(id);
      remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startRef.current));
    };
  }, [paused, leaving, t.id, onExpire]);

  const go = () => { focus(t.tileId); onView(t.tileId); };
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${displayName(t.label)} ${verb}${t.frame ? ` in ${t.frame}` : ""}`}
      onClick={go}
      onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(); } }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`hm-toast ${leaving ? "hm-toast-out" : "hm-toast-in"} ${paused ? "paused" : ""} hm-soft group cursor-pointer`}
      style={{ "--ttl": `${ttl}ms` } as CSSProperties}
      onAnimationEnd={(ev) => {
        // Only the card's OWN exit animation retires it — the countdown bar and
        // the icon beat also bubble animationend up to here.
        if (ev.target === ev.currentTarget && leaving) onFinish(t.id);
      }}
    >
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <span
          aria-hidden
          className={`hm-toast-icon mt-px shrink-0 ${pulse ? "hm-toast-attn" : ""}`}
        >
          <Icon size={15} strokeWidth={2.25} />
        </span>
        <div className="flex flex-col min-w-0 flex-1 leading-tight">
          <span className="font-mono text-[13px] font-semibold tracking-[-0.01em] text-[var(--color-fg)] truncate">
            {displayName(t.label)}
          </span>
          <span className="hm-toast-verb text-[11.5px] font-medium mt-0.5">{verb}</span>
          {t.detail && (
            <span className="font-mono text-[11px] mt-1 text-[var(--color-fg2)] truncate">{t.detail}</span>
          )}
          <span className="text-[10.5px] tracking-[0.01em] mt-1 text-[var(--color-fg3)] truncate">
            {t.frame ? <>{t.frame} · </> : null}{relTime(t.at, now)}
          </span>
          {/* Inline actions (FUTURE SEAM — see Toast.actions). Renders a button row
              only when a toast supplies actions; the first use is Approve/Deny on a
              supervised-worker approval. stopPropagation so a button click doesn't
              also fire the card's focus-tile onClick; each action dismisses the toast. */}
          {t.actions && t.actions.length > 0 && (
            <div className="flex gap-1.5 mt-2">
              {t.actions.map((a) => (
                <button
                  key={a.label}
                  onClick={(ev) => { ev.stopPropagation(); a.run(); onExpire(t.id); }}
                  className={`px-2 py-1 rounded text-[11px] font-medium hm-soft ${
                    a.primary
                      ? "bg-[var(--color-brand)] text-white hover:opacity-90"
                      : "text-[var(--color-fg2)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg4)]"
                  }`}
                >
                  {a.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={(ev) => { ev.stopPropagation(); onExpire(t.id); }}
          className="shrink-0 -mr-1 -mt-1 size-5 grid place-items-center rounded text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg4)] opacity-0 group-hover:opacity-100 hm-soft"
          aria-label="Dismiss notification"
          title="dismiss"
        >
          <X size={12} />
        </button>
      </div>
      {/* Auto-dismiss progress line — shrinks over --ttl and pauses with .paused. */}
      <span aria-hidden className="hm-toast-bar" />
    </div>
  );
}

export function Toasts({
  toasts,
  onDismiss,
  onView,
}: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
  onView: (id: string) => void;
}) {
  // Live relative timestamps. One interval for the whole stack (cheap: 1-3 cards).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, []);

  // Exit animations need the node mounted while they play, so a dismissal marks
  // the card `leaving` first and drops it once the animation ends — rather than
  // yanking it from the DOM mid-air. `onAnimationEnd` ties the unmount to the
  // real animation, incl. the reduced-motion cross-fade.
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const beginDismiss = (id: string) =>
    setLeaving((s) => (s.has(id) ? s : new Set(s).add(id)));
  const finishDismiss = (id: string) => {
    setLeaving((s) => { const n = new Set(s); n.delete(id); return n; });
    onDismiss(id);
  };

  return (
    <div className="flex flex-col items-end gap-2 max-h-[60vh] overflow-y-auto pr-0.5">
      {toasts.map((t) => (
        <ToastCard
          key={t.id}
          t={t}
          now={now}
          leaving={leaving.has(t.id)}
          onExpire={beginDismiss}
          onFinish={finishDismiss}
          onView={onView}
        />
      ))}
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
