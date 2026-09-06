/**
 * view-layout-store — per-view, per-repo, VERSIONED layout blobs.
 *
 * Every view owns its arrangement/navigation state (canvas: tile positions,
 * sizes, viewport; windows: minimized tabs + active tab; a 3D view: camera +
 * object placements). That state is stored apart from the workspace core blob
 * (frames / tiles / membership / names — canvas-persistence.ts) so a view can be
 * added, removed, or change its schema without touching the core or any other
 * view. Each blob is `{ v, data }`; a version mismatch hands the raw payload to
 * the view's `migrate`, which returns the new shape or null (= start fresh).
 *
 * Pure functions + one small hook. Best-effort storage (private mode / quota →
 * silently no-op), same policy as canvas-persistence.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export const VIEW_LAYOUT_KEY = (viewId: string, repoPath: string): string =>
  `hivemind:view-layout:${viewId}:${repoPath}`;

interface Envelope { v: number; data: unknown }

export interface ViewLayoutSpec<T> {
  viewId: string;
  version: number;
  /** Fresh state when nothing is stored and no legacy source applies. */
  initial: () => T;
  /** Bring an older `{v, data}` payload (or a null = no blob at all, so the
   *  view can import from a pre-plugin legacy key for `repoPath`) to the current
   *  shape. Return null to fall back to `initial()`. Throwing is treated as null. */
  migrate?: (data: unknown, fromVersion: number | null, repoPath: string) => T | null;
}

export function loadViewLayout<T>(spec: ViewLayoutSpec<T>, repoPath: string | null): T {
  if (typeof window === "undefined" || !repoPath) return spec.initial();
  const tryMigrate = (data: unknown, from: number | null): T => {
    try { return spec.migrate?.(data, from, repoPath) ?? spec.initial(); } catch { return spec.initial(); }
  };
  try {
    const raw = window.localStorage.getItem(VIEW_LAYOUT_KEY(spec.viewId, repoPath));
    if (!raw) return tryMigrate(null, null);
    const env = JSON.parse(raw) as Partial<Envelope>;
    if (typeof env.v !== "number") return tryMigrate(null, null);
    if (env.v === spec.version) return env.data as T;
    return tryMigrate(env.data, env.v);
  } catch {
    return spec.initial();
  }
}

export function saveViewLayout<T>(spec: ViewLayoutSpec<T>, repoPath: string | null, data: T): void {
  if (typeof window === "undefined" || !repoPath) return;
  try {
    const env: Envelope = { v: spec.version, data };
    window.localStorage.setItem(VIEW_LAYOUT_KEY(spec.viewId, repoPath), JSON.stringify(env));
  } catch {
    /* quota / private mode — best-effort */
  }
}

/**
 * Debounced persistence for ANY value: trailing-debounced write, flushed on
 * repo-key change (under the OLD key), on unmount (a view unmounts on every
 * view switch) and on beforeunload — so the last ~250 ms of edits are never
 * lost to a pending timer. The single mechanism behind both the per-view
 * layouts and the runtime's canvas geometry.
 */
export function useDebouncedSave<T>(repoPath: string | null, value: T, write: (repoPath: string, value: T) => void, debounceMs = 250): void {
  const pending = useRef<{ key: string; value: T; timer: ReturnType<typeof setTimeout> } | null>(null);
  const writeRef = useRef(write);
  writeRef.current = write;
  const flush = useRef(() => {
    const p = pending.current;
    if (!p) return;
    clearTimeout(p.timer);
    pending.current = null;
    writeRef.current(p.key, p.value);
  });
  useEffect(() => {
    if (!repoPath) return;
    // A change of key with a write still pending → persist it under the old key first.
    if (pending.current && pending.current.key !== repoPath) flush.current();
    if (pending.current) clearTimeout(pending.current.timer);
    const timer = setTimeout(() => { pending.current = null; writeRef.current(repoPath, value); }, debounceMs);
    pending.current = { key: repoPath, value, timer };
  }, [repoPath, value, debounceMs]);
  useEffect(() => {
    const f = () => flush.current();
    window.addEventListener("beforeunload", f);
    return () => { window.removeEventListener("beforeunload", f); f(); };
  }, []);
}

/**
 * React binding: state initialised from the blob, reloaded when the repo key
 * changes, persisted through `useDebouncedSave`.
 */
export function useViewLayout<T>(spec: ViewLayoutSpec<T>, repoPath: string | null, debounceMs = 250): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [state, setState] = useState<T>(() => loadViewLayout(spec, repoPath));
  const specRef = useRef(spec);
  specRef.current = spec;
  // Repo switch → that repo's layout. Skip the first run (useState already loaded).
  const lastKey = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (lastKey.current === undefined) { lastKey.current = repoPath; return; }
    if (lastKey.current === repoPath) return;
    lastKey.current = repoPath;
    setState(loadViewLayout(specRef.current, repoPath));
  }, [repoPath]);
  const write = useCallback((key: string, v: T) => saveViewLayout(specRef.current, key, v), []);
  useDebouncedSave(repoPath, state, write, debounceMs);
  return [state, setState];
}
