/** Host toolbar visibility shared by all workspace views. */
import { useSyncExternalStore } from "react";

interface ChromeState {
  suppressed: boolean;
  /** The tool island is drawn; when it is not, Share and Settings sit in the window's corner. */
  islandShown: boolean;
}
let state: ChromeState = { suppressed: false, islandShown: true };
const listeners = new Set<() => void>();
function set(patch: Partial<ChromeState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}
function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }

export function useChromeState(): ChromeState { return useSyncExternalStore(subscribe, () => state, () => state); }
/** The live Appearance panel beside the workspace (the full page stays in Settings). */
export function openAppearanceSettings(): void {
  window.dispatchEvent(new CustomEvent("hivemind:theme-panel"));
}
/** A view (the canvas's zen mode) hides ALL host chrome while it is active;
 *  the view must call this with `false` on unmount. */
export function setChromeSuppressed(on: boolean): void { if (on !== state.suppressed) set({ suppressed: on }); }
/** Host chrome says whether its island is drawn. */
export function setIslandShown(on: boolean): void { if (on !== state.islandShown) set({ islandShown: on }); }
