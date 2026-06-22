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
import type { FrameState } from "./canvas-persistence";

type TileMeta = { label: string; status: TileStatusKind; seen: boolean };
export interface Toast { id: string; tileId: string; label: string; status: TileStatusKind }

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
  const pushToast = useCallback((t: Omit<Toast, "id">) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((ts) => {
      // Collapse a prior toast for the same tile — only the latest state matters.
      const kept = ts.filter((x) => x.tileId !== t.tileId);
      return [...kept, { ...t, id }];
    });
    // Blocked (needs you) lingers; a "done" notice is lower-stakes — auto-clear.
    const ttl = t.status === "blocked" || t.status === "permission" || t.status === "question" ? 12000 : 7000;
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
      // Skip the "finished" path for:
      //  - SYNTHETIC idles: a stuck "working" decayed because output stopped (a
      //    state correction, not a completion) — toasting/notifying for each would
      //    flood the screen (the "filling laggy" report); the status still updates.
      //  - background workflow workers (report:false), gathered in bulk.
      // needs-you is kept either way: an unattended blocked worker still needs help.
      const finished = rawFinished && !e.synthetic && !isBackgroundTile(e.tileId);
      // "seen" = user is looking (tile selected) OR nothing noteworthy happened.
      const seen = selected ? true : finished || needsHuman ? false : old?.seen ?? true;
      const next = new Map(prev);
      next.set(e.tileId, { label: e.label, status: e.status, seen });
      commitStatuses(next);
      // Toast only for background events — suppress when the tile is selected.
      if (!selected && (needsHuman || finished)) {
        pushToast({ tileId: e.tileId, label: e.label, status: e.status });
      }
      // Native OS notification for the SAME transitions, NOT gated on selection
      // (if the whole window is unfocused you're away). Main suppresses it when
      // the window IS focused. One state machine, two surfaces.
      if (needsHuman || finished) {
        const fid = frameOfRef.current[e.tileId];
        const fr = fid ? framesRef.current.find((f) => f.id === fid) : undefined;
        try {
          window.hive.notifyAgent({
            tileId: e.tileId,
            label: e.label,
            kind: needsHuman ? "needs" : "done",
            frame: fr?.title,
          });
        } catch { /* preload missing in some test harnesses */ }
      }
    });
    return off;
  }, [commitStatuses, pushToast, frameOfRef, framesRef]);

  return { toasts, dismissToast, markSeen, selectedTileIdsRef };
}
