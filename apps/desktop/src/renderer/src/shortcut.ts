import { keysLabel, labelsOf, type Action, type KeyOS } from "../../shared/keymap";

/** Runs one of the keymap's actions (shared/keymap.ts): its owner hears `hivemind:shortcut` and
 *  calls `preventDefault()` when it acted. False: nobody had anything to do, so the key goes on. */
export function runShortcut(action: string): boolean {
  const e = new CustomEvent("hivemind:shortcut", { detail: action, cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
}

/** Calls `run` for one action, and marks the key taken when it returns true or nothing. */
export function onShortcut(action: string, run: () => boolean | void): () => void {
  const listener = (e: Event) => {
    if ((e as CustomEvent<string>).detail !== action) return;
    if (run() !== false) e.preventDefault();
  };
  window.addEventListener("hivemind:shortcut", listener);
  return () => window.removeEventListener("hivemind:shortcut", listener);
}

export const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

/** Whose key names this computer uses, from the platform keys are matched on (`IS_MAC`'s). */
export function keyOS(): KeyOS {
  const p = typeof navigator !== "undefined" ? navigator.platform : "";
  return /Mac/i.test(p) ? "mac" : /Win/i.test(p) ? "windows" : "linux";
}

/** A key for a hint, as this computer writes it: `mod+s` is ⌘S on a Mac, Ctrl+S elsewhere. For a
 *  key the keymap has, name its action instead (`actionKey`), so the hint follows the keymap. */
export const keyLabel = (keys: string): string => keysLabel(keys, keyOS());

/** The key that runs one of the keymap's actions here, for a hint or a tooltip. */
export const actionKey = (action: Action): string => labelsOf(action, keyOS())[0] ?? "";
