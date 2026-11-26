/** Host toolbar visibility shared by all workspace views. */
import { useSyncExternalStore } from "react";

interface ChromeState {
  suppressed: boolean;
  /** The tool island is drawn. Settings is on it, and on the Layers rail; with neither drawn, it
   *  sits in the window's corner. */
  islandShown: boolean;
  /** The Layers panel is drawn, in any view. */
  layersShown: boolean;
  /** How far up from the window's bottom the island covers (px), 0 when it is not drawn there. A
   *  view that docks tiles keeps them above it, or the island hides their last lines. */
  bottomInset: number;
  /** How far down from the window's top the island covers (px), 0 when it is not drawn there. */
  topInset: number;
  /** Where the canvas puts its drawing tools in the island: the Draw button, the row of tools,
   *  and the chosen tool's options beside it. Null while the island is not drawn. */
  drawButton: HTMLElement | null;
  drawRow: HTMLElement | null;
  drawOptions: HTMLElement | null;
  /** The island is at the window's bottom: what opens from it opens upward. */
  drawOpensUp: boolean;
}
let state: ChromeState = {
  suppressed: false, islandShown: true, layersShown: false, bottomInset: 0, topInset: 0,
  drawButton: null, drawRow: null, drawOptions: null, drawOpensUp: false,
};
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
/** Host chrome says how much of the window's bottom its island covers. */
export function setBottomInset(px: number): void { if (px !== state.bottomInset) set({ bottomInset: px }); }
/** Host chrome says how much of the window's top its island covers. */
export function setTopInset(px: number): void { if (px !== state.topInset) set({ topInset: px }); }
/** Host chrome says whether its island is drawn. */
export function setIslandShown(on: boolean): void { if (on !== state.islandShown) set({ islandShown: on }); }
let layers = 0;
/** The Layers panel says it is drawn, until the function it gets back is called. */
export function layersDrawn(): () => void {
  layers++;
  set({ layersShown: true });
  return () => { layers--; if (layers === 0) set({ layersShown: false }); };
}
/** The island's places for the drawing tools, as stable refs: React calls each on mount and unmount only. */
export const drawButtonSlot = (el: HTMLElement | null): void => { if (el !== state.drawButton) set({ drawButton: el }); };
export const drawRowSlot = (el: HTMLElement | null): void => { if (el !== state.drawRow) set({ drawRow: el }); };
export const drawOptionsSlot = (el: HTMLElement | null): void => { if (el !== state.drawOptions) set({ drawOptions: el }); };
export function setDrawOpensUp(up: boolean): void { if (up !== state.drawOpensUp) set({ drawOpensUp: up }); }
