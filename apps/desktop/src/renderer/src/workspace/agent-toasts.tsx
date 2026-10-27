/**
 * Agent toasts — an agent that finishes, fails or needs you while you look
 * elsewhere pings here, bottom-right, in every view. The runtime draws the
 * stack over the active view: each card owns its own dismiss timer, so a stack
 * drawn by one view only kept every toast raised in the others until that view
 * came back.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { CircleAlert, CircleCheck, TriangleAlert, X } from "../components/icons";
import { Button } from "../components/ui/button";
import { toastKindOf, toastTtlMs, type Toast, type NoticeKind } from "../useAgentAwareness";
import { DecideButtons, useCut } from "../wait-decide";

// ── Agent awareness ─────────────────────────────────────────────────────────

/** Icon + verb per notice class. ONE accent (the app brand, set in CSS) is used
 *  across every kind — the kind is encoded by the icon SHAPE + the verb text
 *  (and a pulse on needs-you), never by a competing second color. Needs-you
 *  pulses (actionable); done/error are steady — only needs-you earns motion
 *  (pulsing everything is the slop tell). */
const NOTICE: Record<NoticeKind, { Icon: typeof CircleAlert; verb: string; pulse: boolean }> = {
  needs: { Icon: CircleAlert, verb: "needs your input", pulse: true },
  done: { Icon: CircleCheck, verb: "finished — click to view", pulse: false },
  error: { Icon: TriangleAlert, verb: "failed — click to view", pulse: false },
};

/** "just now" / "Ns ago" — coarse, auto-updates on a 1s tick (Toasts only mounts
 *  while there's ≥1 toast, so the ticker costs nothing when the stack is empty). */
function relTime(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 2) return "just now";
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

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
  const k = toastKindOf(t);
  const { Icon, verb, pulse } = NOTICE[k];
  const ttl = toastTtlMs(t);
  const [hovered, setHovered] = useState(false);
  const [winBlurred, setWinBlurred] = useState(false);
  const paused = hovered || winBlurred;
  const remainingRef = useRef(ttl);
  const startRef = useRef(0);
  const detail = useRef<HTMLSpanElement>(null);
  const cut = useCut(detail, t.detail ?? "", !!t.decide);

  // The same tile told again (its toast keeps its id): its time starts again.
  useEffect(() => { remainingRef.current = ttl; }, [t.at, ttl]);

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
  }, [paused, leaving, t.id, t.at, onExpire]);

  const go = () => onView(t.tileId);
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
          <Icon size={15} />
        </span>
        <div className="flex flex-col min-w-0 flex-1 leading-tight">
          <span className="font-mono text-body font-semibold tracking-[-0.01em] text-[var(--color-fg)] truncate">
            {displayName(t.label)}
          </span>
          <span className="hm-toast-verb text-label font-medium mt-0.5">{verb}</span>
          {t.detail && (
            <span ref={detail} className="font-mono text-count mt-1 text-[var(--color-fg2)] truncate">{t.detail}</span>
          )}
          <span className="text-count tracking-[0.01em] mt-1 text-[var(--color-fg3)] truncate">
            {t.frame ? <>{t.frame} · </> : null}{relTime(t.at, now)}
          </span>
          {/* A permission answered from here: Deny and Allow, or Review when what it allows is
              not all in sight. A press on them never reaches the card, which shows the tile. */}
          {t.decide && <DecideButtons tile={t.tileId} name={displayName(t.label)} waiting={t.decide} cut={cut} className="mt-2 -ml-2.5" />}
        </div>
        <Button reveal="hidden"
          variant="ghost"
          size="icon-2xs"
          onClick={(ev) => { ev.stopPropagation(); onExpire(t.id); }}
          className="-mr-1 -mt-1"
          aria-label="Dismiss notification"
          title="dismiss"
        >
          <X />
        </Button>
      </div>
      {/* Auto-dismiss progress line — shrinks over --ttl and pauses with .paused. */}
      <span aria-hidden className="hm-toast-bar" />
    </div>
  );
}

/** Background-event toast stack — borderless solid cards. Click to show the
 *  tile + mark seen; hover the [×] to dismiss. One accent (the app brand) tints
 *  the icon, verb, and the TTL line; see `.hm-toast` in styles.css. */
function Toasts({
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
  const anyToast = toasts.length > 0;
  useEffect(() => {
    if (!anyToast) return;
    setNow(Date.now());
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [anyToast]);

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

  // A card slides in and out from 16px to the right. The stack reaches the window's edge and keeps
  // its cards 14px in from it, so the slide stays inside its own padding: overflowing the stack
  // gave it a sideways scrollbar for the length of the slide, which lifted every card by its height.
  return (
    <div className="flex flex-col items-end gap-2 max-h-[60vh] overflow-y-auto overflow-x-hidden pr-3.5">
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

/** The page's other notices (sonner, main.tsx) share the bottom-right corner
 *  and stack above this one by this height, and the widgets' Hide toggle rises
 *  by it: the stack's height and the gap above it, 0px when there is none. */
const AGENT_TOASTS_HEIGHT = "--agent-toasts-height";

/** The stack, bottom-right in the page's notification layer (over widgets). It
 *  stands left of a widget column floating along the window's right edge, by the
 *  width the widget layer publishes, so no card hides that column's lower rows. */
export function AgentToasts({ toasts, onDismiss, onView }: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
  /** Show the tile in the active view and mark it seen. */
  onView: (tileId: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const any = toasts.length > 0;
  useEffect(() => {
    const root = document.documentElement.style;
    const el = ref.current;
    if (!any || !el) { root.setProperty(AGENT_TOASTS_HEIGHT, "0px"); return; }
    const ro = new ResizeObserver(() => root.setProperty(AGENT_TOASTS_HEIGHT, `${Math.ceil(el.getBoundingClientRect().height) + 8}px`));
    ro.observe(el);
    return () => { ro.disconnect(); root.setProperty(AGENT_TOASTS_HEIGHT, "0px"); };
  }, [any]);
  if (!any) return null;
  return (
    <div ref={ref} className="fixed bottom-3 right-[var(--widgets-right-inset,0px)] z-(--layer-notifications)" data-notifications>
      <Toasts toasts={toasts} onDismiss={onDismiss} onView={onView} />
    </div>
  );
}
