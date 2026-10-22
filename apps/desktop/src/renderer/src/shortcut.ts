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
