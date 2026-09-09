/** Host toolbar visibility shared by all workspace views. */
import { useSyncExternalStore } from "react";

interface ChromeState { suppressed: boolean }
let state: ChromeState = { suppressed: false };
const listeners = new Set<() => void>();
function set(patch: Partial<ChromeState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}
function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }

export function useChromeState(): ChromeState { return useSyncExternalStore(subscribe, () => state, () => state); }
export function openAppearanceSettings(): void {
  window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "appearance" } }));
}
/** A view (the canvas's zen mode) hides ALL host chrome while it is active;
 *  the view must call this with `false` on unmount. */
export function setChromeSuppressed(on: boolean): void { if (on !== state.suppressed) set({ suppressed: on }); }
