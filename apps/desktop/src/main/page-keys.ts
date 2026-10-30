/**
 * Keys and text for a browser tile's page, given to that page itself. Chromium hands DevTools
 * keyboard input (`Input.insertText`, `Input.dispatchKeyEvent`) to whatever holds focus in the app
 * window, a terminal say, since a page inside it gets keys only while it holds that focus;
 * Electron's own input goes to the page whatever has focus.
 */
import type { WebContents } from "electron";

/** A key as DevTools' `Input.dispatchKeyEvent` describes it; `modifiers` is its bit set. */
export interface PageKey {
  type: string;
  key?: string;
  text?: string;
  modifiers?: number;
}

const MODIFIERS = [[1, "alt"], [2, "control"], [4, "meta"], [8, "shift"]] as const;
/** DOM key names Electron calls otherwise. */
const ELECTRON_NAMES: Record<string, string> = { ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", " ": "Space" };

/** Press, release or type `k` in `page`. A press that types sends its character too, as a DevTools
 *  key-down with text does. */
export function pressKey(page: WebContents, k: PageKey): void {
  const keyCode = ELECTRON_NAMES[k.key ?? ""] ?? (k.key || k.text || "");
  if (!keyCode) return;
  const modifiers = MODIFIERS.filter(([bit]) => ((k.modifiers ?? 0) & bit) !== 0).map(([, name]) => name);
  if (k.type === "keyUp") return page.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  if (k.type !== "char") page.sendInputEvent({ type: "keyDown", keyCode, modifiers });
  if (k.type === "char" || (k.type === "keyDown" && k.text)) page.sendInputEvent({ type: "char", keyCode: k.text || keyCode, modifiers });
}

/** Type `text` into the field that has focus in `page`. */
export function typeText(page: WebContents, text: string): Promise<void> {
  return page.insertText(text);
}

/** Do DevTools command `method` with `params` in `page` when it is keyboard input; false when it is not. */
export async function keyboardCommand(page: WebContents, method: string, params: Record<string, unknown>): Promise<boolean> {
  if (method === "Input.insertText") {
    await typeText(page, String(params.text ?? ""));
    return true;
  }
  if (method === "Input.dispatchKeyEvent") {
    pressKey(page, params as unknown as PageKey);
    return true;
  }
  return false;
}
