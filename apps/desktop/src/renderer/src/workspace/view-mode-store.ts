/**
 * view-mode-store — the active view plugin id as ONE external store (same
 * pattern as theme-store.ts): `useViewMode()` subscribes synchronously via
 * useSyncExternalStore, so Workspace and Settings ▸ View always render the same
 * id in the same tick — no CustomEvent round trips, no "re-read after a
 * timeout" (the stale Settings card after ⌘E).
 *
 * Persisted raw under `hivemind:view-mode` (windows-view-state.ts); consumers
 * map it through `resolveViewId` so an id whose plugin is gone falls back.
 * `hivemind:toggle-view-mode` (⌘E, menu, tests) still works — handled here.
 */
import { useSyncExternalStore } from "react";
import { loadViewMode, saveViewMode } from "../windows-view-state";
import { nextViewId, resolveViewId } from "./workspace-view";

let current: string | null = loadViewMode();
const listeners = new Set<() => void>();

export function getViewMode(): string | null {
  return current;
}

export function setViewMode(id: string | null): void {
  if (id === current) return;
  current = id;
  if (id) saveViewMode(id);
  for (const l of listeners) l();
}

/** ⌘E: the next registered view after the current (resolved) one. */
export function cycleViewMode(): void {
  setViewMode(nextViewId(resolveViewId(current)));
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** The stored view id (unresolved). Pair with `resolveViewId`. */
export function useViewMode(): string | null {
  return useSyncExternalStore(subscribe, getViewMode, getViewMode);
}

if (typeof window !== "undefined") {
  window.addEventListener("hivemind:toggle-view-mode", cycleViewMode);
  window.addEventListener("hivemind:set-view-mode", (e) => {
    const m = (e as CustomEvent<{ mode?: string }>).detail?.mode;
    if (m) setViewMode(m);
  });
}
