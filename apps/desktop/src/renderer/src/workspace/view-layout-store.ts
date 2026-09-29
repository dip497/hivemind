/**
 * view-layout-store — per-view, per-repo, VERSIONED layout blobs.
 *
 * Every view owns its arrangement/navigation state (canvas: tile positions,
 * sizes, viewport; windows: minimized tabs + active tab; a 3D view: camera +
 * object placements). That state is stored apart from the workspace core blob
 * (frames / tiles / membership / names — canvas-persistence.ts) so a view can be
 * added, removed, or change its schema without touching the core or any other
 * view. Each blob is `{ v, data }`; a blob at another version starts fresh.
 *
 * A view's arrangement is the workspace's, shared by every window and (later) person on it; what
 * is one person's own (a camera, the tab they are on) is marked `personal` and kept on this device.
 *
 * Pure functions + one small hook. This module owns the versioning; where the
 * blobs are kept (main's workspace store) is workspace-store-client.ts.
 * Best-effort, same policy as canvas-persistence.
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { readPersonal, readView, writePersonal, writeView } from "./workspace-store-client";

export interface ViewLayoutSpec<T> {
  viewId: string;
  version: number;
  /** Fresh state when nothing (current) is stored. */
  initial: () => T;
  /** One person's, not the workspace's: kept on this device, never in the workspace document.
   *  Until this device has its own, it starts from what the document held before (R5). */
  personal?: boolean;
}

export function loadViewLayout<T>(spec: ViewLayoutSpec<T>, repoPath: string | null): T {
  if (!repoPath) return spec.initial();
  const stored = (spec.personal ? readPersonal(repoPath, spec.viewId) : null) ?? readView(repoPath, spec.viewId);
  return stored && stored.v === spec.version ? (stored.data as T) : spec.initial();
}

export function saveViewLayout<T>(spec: ViewLayoutSpec<T>, repoPath: string | null, data: T): void {
  if (!repoPath) return;
  (spec.personal ? writePersonal : writeView)(repoPath, spec.viewId, { v: spec.version, data });
}

/**
 * Debounced persistence for ANY value: trailing-debounced write, flushed on
 * repo-key change (under the OLD key), on unmount (a view unmounts on every
 * view switch) and on beforeunload — so the last ~250 ms of edits are never
 * lost to a pending timer. The single mechanism behind both the per-view
 * layouts and the runtime's canvas geometry.
 *
 * It saves `value` as it renders, and returns `schedule` for a value that has
 * not rendered yet: a state setter calls it, so an edit made just before the
 * component unmounts is kept even though React never renders it. The value an
 * owner renders with a new key is not saved: every owner (the Workspace, a view)
 * replaces it with the new key's own layout on the next render. `flush` writes
 * what is pending now, for an owner that must read the store back after it (undo).
 */
export function useDebouncedSave<T>(
  repoPath: string | null, value: T, write: (repoPath: string, value: T) => void, debounceMs = 250,
): { schedule: (value: T) => void; flush: () => void } {
  const pending = useRef<{ key: string; value: T; timer: ReturnType<typeof setTimeout> } | null>(null);
  const writeRef = useRef(write);
  writeRef.current = write;
  const keyRef = useRef(repoPath);
  const delayRef = useRef(debounceMs);
  delayRef.current = debounceMs;
  const flush = useRef(() => {
    const p = pending.current;
    if (!p) return;
    clearTimeout(p.timer);
    pending.current = null;
    writeRef.current(p.key, p.value);
  });
  const schedule = useRef((v: T) => {
    const key = keyRef.current;
    if (!key) return;
    if (pending.current) clearTimeout(pending.current.timer);
    const timer = setTimeout(() => { pending.current = null; writeRef.current(key, v); }, delayRef.current);
    pending.current = { key, value: v, timer };
  });
  useEffect(() => {
    const keyChanged = keyRef.current !== repoPath;
    keyRef.current = repoPath;
    if (!repoPath) return;
    // A change of key with a write still pending → persist it under the old key first.
    if (pending.current && pending.current.key !== repoPath) flush.current();
    // The value rendered with a new key is still the old key's: its owner loads the new
    // key's next. Saving it now would write one workspace's layout under another's name.
    if (keyChanged) return;
    // Already scheduled by a setter before it rendered: keep that timer.
    if (pending.current && Object.is(pending.current.value, value)) return;
    schedule.current(value);
  }, [repoPath, value, debounceMs]);
  useEffect(() => {
    const f = () => flush.current();
    window.addEventListener("beforeunload", f);
    return () => { window.removeEventListener("beforeunload", f); f(); };
  }, []);
  return { schedule: schedule.current, flush: flush.current };
}

/**
 * React binding: state initialised from the blob, reloaded when the repo key
 * changes, persisted through `useDebouncedSave`. The setter hands every new
 * layout to the save at once, so a view that unmounts before rendering its
 * last edit (a view switch in the same tick) still keeps it.
 */
export function useViewLayout<T>(spec: ViewLayoutSpec<T>, repoPath: string | null, debounceMs = 250): [T, Dispatch<SetStateAction<T>>] {
  const [state, setState] = useState<T>(() => loadViewLayout(spec, repoPath));
  // The newest layout asked for, rendered or not; functional updates build on it.
  const latest = useRef(state);
  const specRef = useRef(spec);
  specRef.current = spec;
  // Repo switch → that repo's layout. Skip the first run (useState already loaded).
  const lastKey = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (lastKey.current === undefined) { lastKey.current = repoPath; return; }
    if (lastKey.current === repoPath) return;
    lastKey.current = repoPath;
    latest.current = loadViewLayout(specRef.current, repoPath);
    setState(latest.current);
  }, [repoPath]);
  const write = useCallback((key: string, v: T) => saveViewLayout(specRef.current, key, v), []);
  const { schedule } = useDebouncedSave(repoPath, state, write, debounceMs);
  const set = useCallback((action: SetStateAction<T>) => {
    const next = typeof action === "function" ? (action as (prev: T) => T)(latest.current) : action;
    if (Object.is(next, latest.current)) return;
    latest.current = next;
    schedule(next);
    setState(next);
  }, [schedule]);
  return [state, set];
}
