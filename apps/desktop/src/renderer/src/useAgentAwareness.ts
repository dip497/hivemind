/** Agent status transitions → in-app toast (not for a selected tile), and main's notice desk
 *  (OS pop-up and sound, notice-desk.ts). `noticeOf` decides which
 *  transitions are told; the screen reader's line (workspace/announcer.ts) asks it too. */
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { subscribeStatus, type StatusEvent, type TileStatusKind } from "./agent-status-bus";
import { isBackgroundTile } from "./worker-tiles";
import { getNotificationSettings } from "./notification-settings";
import { shouldNotify } from "../../shared/notification-settings.js";
import type { FrameState } from "./canvas-persistence";
import { statusLook } from "./workspace/status-look";
import { subscribeWait, waitOf, type AgentWait } from "./agent-waits";
import { lineFor } from "./row-line";
import { decidable } from "./wait-decide";
import { oneLine } from "@hivemind/agent-host/one-line";

type TileMeta = { label: string; status: TileStatusKind; seen: boolean };

/** The verb-class of a toast / OS popup — drives accent color, icon and copy.
 *  Derived from a status transition: needs-you (any status that looks "needs"),
 *  finished (working→idle, or clean exit code 0), or error (working→exited,
 *  non-zero). Kept separate from TileStatusKind so a single "error" kind can
 *  overlay an `exited` status with red styling + the exit code in the body. */
export type NoticeKind = "needs" | "done" | "error";

export interface Toast {
  id: string;
  tileId: string;
  label: string;
  status: TileStatusKind;
  /** Notice class (drives accent/icon/copy). Optional for back-compat with the
   *  worktree handlers, which pass only {tileId,label,status} and get `needs`
   *  derived from a blocked status. */
  kind?: NoticeKind;
  /** One-line failure detail shown under the label (error kind), e.g.
   *  "exit code 137" / "killed by signal 9". */
  detail?: string;
  /** The frame (workspace) name — shown as muted context so you know WHICH
   *  project's agent poked you, mirroring the native popup's body. */
  frame?: string;
  /** Creation ts — the rich toast renders a relative "just now" / "12s" stamp. */
  at: number;
  /** A needs-you toast's wait, once the agent feed tells it, when it can be allowed or denied from
   *  the toast (wait-decide.tsx): its Deny and Allow are drawn under the context line. */
  decide?: AgentWait;
  /** When the wait the toast shows began: once it ends, the toast goes. */
  waited?: number;
}

/**
 * What a status change tells the person, or null for nothing. `prev`: the tile's status before
 * this one (undefined: the first seen of it).
 *  - needs: it waits for a person (a permission, a question, a plan to review, an approval,
 *    blocked), from any state: what wears the "needs" look. A background worker that needs you
 *    still does.
 *  - done: a working agent finished its turn, or closed cleanly (exit code 0). Not a synthetic
 *    idle: a stuck "working" corrected, or the person interrupting it.
 *  - error: a working agent's process died, with a non-zero code or none known.
 * Only a tile that was working can finish or fail: a plain shell never says it works, so its exit
 * stays quiet. A background worker (a workflow's, `report:false`) is gathered in bulk: its end is
 * not told one by one.
 */
export function noticeOf(prev: TileStatusKind | undefined, e: StatusEvent): NoticeKind | null {
  // A supervised worker's approval is its lead's to give (an agent), not the person's: its mark shows
  // it, and nothing is said.
  if (statusLook(e.status) === "needs") return e.status === "awaiting_approval" ? null : "needs";
  if (prev !== "working" || isBackgroundTile(e.tileId)) return null;
  if (e.status === "idle") return e.synthetic ? null : "done";
  if (e.status === "exited") return e.exitCode === 0 ? "done" : "error";
  return null;
}

/** The notice class for a toast, deriving it from the status when the caller
 *  didn't set `kind` explicitly (the worktree handlers pass only a status). */
export function toastKindOf(t: { kind?: NoticeKind; status: TileStatusKind }): NoticeKind {
  if (t.kind) return t.kind;
  if (statusLook(t.status) === "needs") return "needs";
  if (t.status === "exited") return "error";
  return "done";
}

/** Auto-dismiss delay. Needs-you / crashed demand attention and linger; a clean
 *  finish is lower-stakes and clears faster. Single source of truth — the toast
 *  UI reads the same value to draw its shrinking progress line in sync. */
export function toastTtlMs(t: { kind?: NoticeKind; status: TileStatusKind }): number {
  const k = toastKindOf(t);
  return k === "needs" || k === "error" ? 12000 : 7000;
}

export interface AgentAwarenessCtx {
  /** Populated with pushToast so earlier-declared worktree handlers can toast. */
  pushToastRef: MutableRefObject<((t: { tileId: string; label: string; status: TileStatusKind }) => void) | null>;
  frameOfRef: MutableRefObject<Record<string, string>>;
  framesRef: MutableRefObject<FrameState[]>;
}

export function useAgentAwareness(ctx: AgentAwarenessCtx) {
  const { pushToastRef, frameOfRef, framesRef } = ctx;

  const [, setStatuses] = useState<Map<string, TileMeta>>(() => new Map());
  // Mirror so the bus listener reads the PREVIOUS status synchronously (to
  // detect working→idle "done") without side effects inside a setState updater.
  const statusesRef = useRef<Map<string, TileMeta>>(new Map());
  // Signature of the ATTENTION set (unseen tiles + their status) at the last
  // Canvas re-render. We only re-render when THIS changes — see commitStatuses.
  const renderSigRef = useRef("");
  // Which tiles the user currently has selected — drives toast suppression +
  // marks done tiles seen. The render writes this on selection.
  const selectedTileIdsRef = useRef<Set<string>>(new Set());

  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismissToast = useCallback((id: string) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);
  const pushToast = useCallback((t: Omit<Toast, "id" | "at"> & { at?: number }) => {
    const at = t.at ?? Date.now();
    setToasts((ts) => {
      // A prior toast for the same tile is replaced, only the latest state matters, and keeps its
      // id: its card stays mounted and starts its time again.
      const was = ts.find((x) => x.tileId === t.tileId);
      const id = was?.id ?? `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      return [...ts.filter((x) => x.tileId !== t.tileId), { ...t, id, at }];
    });
    // Auto-dismiss is owned by the CARD (a pausable timer that stops on hover and
    // on window-blur), so a toast never vanishes while you're reading it or
    // reaching for its ×. See ToastCard in workspace/agent-toasts.tsx.
  }, []);

  // A needs-you toast says what its agent waits on, and offers Allow and Deny when it can: the wait
  // comes with the agent feed, up to 250 ms after the status that raised the toast, so the toast is
  // filled in place as it comes (agent-waits.ts), and goes once the wait ends (answered here, on its
  // tile or elsewhere). A done toast says the tile's last line, read once (`tile.readLines`).
  const needsTiles = useMemo(() => toasts.filter((t) => toastKindOf(t) === "needs").map((t) => t.tileId).sort().join("\n"), [toasts]);
  useEffect(() => {
    if (!needsTiles) return undefined;
    const fill = (tile: string) => {
      const waiting = waitOf(tile)?.waiting;
      setToasts((ts) => {
        const t = ts.find((x) => x.tileId === tile);
        if (!t || toastKindOf(t) !== "needs") return ts;
        if (!waiting) return t.waited === undefined ? ts : ts.filter((x) => x !== t);
        const detail = lineFor(waiting, undefined);
        const decide = decidable(waiting) ? waiting : undefined;
        if (t.detail === detail && t.decide === decide && t.waited === waiting.since) return ts;
        return ts.map((x) => (x === t ? { ...t, detail, decide, waited: waiting.since } : x));
      });
    };
    const offs = needsTiles.split("\n").map((tile) => { fill(tile); return subscribeWait(tile, () => fill(tile)); });
    return () => { for (const off of offs) off(); };
  }, [needsTiles]);
  const sayLine = useCallback((tile: string) => {
    void window.hive.tileLinesRead?.([tile]).then(({ lines }) => {
      const detail = oneLine(lines[tile] ?? "");
      if (!detail) return;
      setToasts((ts) => ts.map((t) => (t.tileId === tile && toastKindOf(t) === "done" && t.detail !== detail ? { ...t, detail } : t)));
    }, () => { /* an older host reads no lines */ });
  }, []);

  // Expose pushToast to the (earlier-declared) bind/unbind worktree handlers.
  useEffect(() => { pushToastRef.current = pushToast; }, [pushToast, pushToastRef]);

  const commitStatuses = useCallback((m: Map<string, TileMeta>) => {
    statusesRef.current = m;
    // CRITICAL: re-render the Canvas ONLY when the attention set actually changes
    // (which tiles are done-unseen / need-you). An agent that's steadily WORKING
    // re-publishes its status (and churns its title/label) ~every second; without
    // this gate, every such tick called setStatuses → Canvas re-render → react-flow
    // re-render → the mouse cursor flickered (z-fighting) and input janked while
    // you typed into a working tile. statusesRef stays current for done-detection
    // regardless; only the highlight-relevant transitions trigger a render.
    const sig = [...m.entries()]
      .filter(([, v]) => !v.seen)
      .map(([k, v]) => `${k}:${v.status}`)
      .sort()
      .join("|");
    if (sig === renderSigRef.current) return;
    renderSigRef.current = sig;
    setStatuses(m);
  }, []);

  // Mark tiles as seen (clears done-unseen + dismisses their toasts).
  const markSeen = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    const prev = statusesRef.current;
    let changed = false;
    const next = new Map(prev);
    for (const id of ids) {
      const m = next.get(id);
      if (m && !m.seen) { next.set(id, { ...m, seen: true }); changed = true; }
    }
    if (changed) commitStatuses(next);
    // Return the SAME array reference when nothing matches — otherwise every
    // selection-change emits a fresh [] and, because `nodes` is rebuilt each
    // render, react-flow re-fires onSelectionChange → infinite loop (React #185).
    setToasts((ts) => (ts.some((t) => ids.includes(t.tileId)) ? ts.filter((t) => !ids.includes(t.tileId)) : ts));
  }, [commitStatuses]);

  useEffect(() => {
    const off = subscribeStatus((e) => {
      const selected = selectedTileIdsRef.current.has(e.tileId);
      const prev = statusesRef.current;
      const old = prev.get(e.tileId);
      const kind = noticeOf(old?.status, e);
      const crashed = kind === "error";
      // "seen" = user is looking (tile selected) OR nothing noteworthy happened.
      const seen = selected ? true : kind ? false : old?.seen ?? true;
      const next = new Map(prev);
      next.set(e.tileId, { label: e.label, status: e.status, seen });
      commitStatuses(next);
      if (!kind) return;
      // The project context, once, for both surfaces. `frame` is the frame title (a worktree's
      // branch); `repo` is the repo dir basename — the fallback context so a bare "claude" is
      // still pinned to a project when the frame has no title. Both surfaces read the same fields.
      const fid = frameOfRef.current[e.tileId];
      const fr = fid ? framesRef.current.find((f) => f.id === fid) : undefined;
      const repo = ((fr?.worktreePath ?? fr?.workspacePath) || "")
        .split("/").filter(Boolean).pop() || undefined;
      // Toast only for background events — suppress when the tile is selected.
      // Gated by user prefs (master / per-kind / DND) for the in-app surface.
      if (!selected && shouldNotify(getNotificationSettings(), kind, "inApp")) {
        pushToast({
          tileId: e.tileId,
          label: e.label,
          status: e.status,
          kind,
          ...(crashed ? { detail: e.detail ?? (e.exitCode !== undefined ? `exit code ${e.exitCode}` : undefined) } : {}),
          ...(fr?.title ? { frame: fr.title } : repo ? { frame: repo } : {}),
        });
        if (kind === "done") sayLine(e.tileId);
      }
      // Main's notice desk hears every window's copy of the same change and makes it one event:
      // the OS pop-up while no window has the focus, and the sound, under the same settings. Every
      // change goes, so its pop-up and sound settings hold even with toasts off. `selected`: a
      // finished sound is skipped while the person looks at that tile (main counts it only while
      // this window has the focus).
      try {
        window.hive.notifyAgent?.({
          tileId: e.tileId,
          label: e.label,
          kind,
          ...(selected ? { selected } : {}),
          ...(fr?.title ? { frame: fr.title } : {}),
          ...(repo ? { repo } : {}),
          ...(crashed
            ? { ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}), ...(e.detail ? { detail: e.detail } : {}) }
            : {}),
        });
      } catch { /* preload missing in some test harnesses */ }
    });
    return off;
  }, [commitStatuses, pushToast, sayLine, frameOfRef, framesRef]);

  return { toasts, dismissToast, markSeen, selectedTileIdsRef };
}
