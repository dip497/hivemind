/**
 * useAgentAwareness — the herdr-style agent status → toast / OS-notification
 * state machine, lifted from Canvas.tsx. Subscribes to the agent-status bus,
 * tracks per-tile status + done-unseen, raises an in-app toast (suppressed when
 * the tile is selected) and a native notification (suppressed by main when the
 * window is focused) on the SAME transitions. Returns the toast list + the
 * markSeen action + the selected-tiles ref the render wires into selection.
 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { subscribeStatus, type TileStatusKind } from "./agent-status-bus";
import { isBackgroundTile } from "./worker-tiles";
import { getNotificationSettings } from "./notification-settings";
import { shouldNotify } from "../../shared/notification-settings.js";
import type { FrameState } from "./canvas-persistence";

type TileMeta = { label: string; status: TileStatusKind; seen: boolean };

/** The verb-class of a toast / OS popup — drives accent color, icon and copy.
 *  Derived from a status transition: needs-you (blocked/permission/question),
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
}

/** The notice class for a toast, deriving it from the status when the caller
 *  didn't set `kind` explicitly (the worktree handlers pass only a status). */
export function toastKindOf(t: { kind?: NoticeKind; status: TileStatusKind }): NoticeKind {
  if (t.kind) return t.kind;
  if (t.status === "blocked" || t.status === "permission" || t.status === "question") return "needs";
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
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const at = t.at ?? Date.now();
    setToasts((ts) => {
      // Collapse a prior toast for the same tile — only the latest state matters.
      const kept = ts.filter((x) => x.tileId !== t.tileId);
      return [...kept, { ...t, id, at }];
    });
    const ttl = toastTtlMs(t);
    setTimeout(() => dismissToast(id), ttl);
  }, [dismissToast]);

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
      const rawFinished = e.status === "idle" && old?.status === "working"; // done now
      const needsHuman =
        e.status === "blocked" || e.status === "permission" || e.status === "question";
      // A WORKING agent whose process just DIED. This is the failure mode that
      // was previously silent (a non-zero exit only painted grey inline text):
      // a crash, an OOM-kill, a failed build that took the shell down. Only a
      // tile that was actually working can "crash" — a plain shell's exit has no
      // prior working status (it never publishes one) so this stays quiet for it.
      // Background workers are gathered in bulk and excluded like `finished`.
      const exitedFromWorking = e.status === "exited" && old?.status === "working" && !isBackgroundTile(e.tileId);
      // exitCode 0 = the agent closed cleanly (e.g. /exit) → reads as "done",
      // not alarm-red. Unknown/missing code or non-zero → error.
      const cleanExit = exitedFromWorking && e.exitCode === 0;
      const crashed = exitedFromWorking && e.exitCode !== 0;
      // Skip the "finished" path for:
      //  - SYNTHETIC idles: a stuck "working" decayed because output stopped (a
      //    state correction, not a completion) — toasting/notifying for each would
      //    flood the screen (the "filling laggy" report); the status still updates.
      //  - background workflow workers (report:false), gathered in bulk.
      // needs-you is kept either way: an unattended blocked worker still needs help.
      const finished = (rawFinished && !e.synthetic) || cleanExit;
      // "seen" = user is looking (tile selected) OR nothing noteworthy happened.
      const seen = selected ? true : finished || needsHuman || crashed ? false : old?.seen ?? true;
      const next = new Map(prev);
      next.set(e.tileId, { label: e.label, status: e.status, seen });
      commitStatuses(next);
      // Resolve the notice class + the frame context once, for both surfaces.
      const kind: NoticeKind = crashed ? "error" : needsHuman ? "needs" : "done";
      const fid = frameOfRef.current[e.tileId];
      const fr = fid ? framesRef.current.find((f) => f.id === fid) : undefined;
      // Toast only for background events — suppress when the tile is selected.
      // Gated by user prefs (master / per-kind / DND) for the in-app surface.
      if (!selected && (needsHuman || finished || crashed) && shouldNotify(getNotificationSettings(), kind, "inApp")) {
        pushToast({
          tileId: e.tileId,
          label: e.label,
          status: e.status,
          kind,
          ...(crashed ? { detail: e.detail ?? (e.exitCode !== undefined ? `exit code ${e.exitCode}` : undefined) } : {}),
          ...(fr?.title ? { frame: fr.title } : {}),
        });
      }
      // Native OS notification for the SAME transitions, NOT gated on selection
      // (if the whole window is unfocused you're away). Main suppresses it when
      // the window IS focused AND applies the same prefs for the osPopups
      // surface. One state machine, two surfaces. We still forward every event
      // so the OS-surface pref is honored even when the in-app one is off.
      if (needsHuman || finished || crashed) {
        try {
          window.hive.notifyAgent({
            tileId: e.tileId,
            label: e.label,
            kind,
            ...(fr?.title ? { frame: fr.title } : {}),
            ...(crashed
              ? { ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}), ...(e.detail ? { detail: e.detail } : {}) }
              : {}),
          });
        } catch { /* preload missing in some test harnesses */ }
      }
    });
    return off;
  }, [commitStatuses, pushToast, frameOfRef, framesRef]);

  return { toasts, dismissToast, markSeen, selectedTileIdsRef };
}
