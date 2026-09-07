/**
 * chrome-store — small external store for the host chrome the runtime draws
 * over EVERY view (workspace/host-chrome.tsx): whether the appearance drawer
 * is open (the island's Theme button opens it from any view) and whether a
 * view asked for the chrome to be suppressed for the moment (the canvas's zen
 * mode). Same pattern as view-mode-store.
 */
import { useSyncExternalStore } from "react";

interface ChromeState { customizerOpen: boolean; suppressed: boolean }
let state: ChromeState = { customizerOpen: false, suppressed: false };
const listeners = new Set<() => void>();
function set(patch: Partial<ChromeState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}
function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }

export function useChromeState(): ChromeState { return useSyncExternalStore(subscribe, () => state, () => state); }
export function setCustomizerOpen(open: boolean): void { set({ customizerOpen: open }); }
export function toggleCustomizer(): void { set({ customizerOpen: !state.customizerOpen }); }
/** A view (the canvas's zen mode) hides ALL host chrome while it is active;
 *  the view must call this with `false` on unmount. */
export function setChromeSuppressed(on: boolean): void { if (on !== state.suppressed) set({ suppressed: on }); }
