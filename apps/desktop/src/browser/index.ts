/// <reference lib="dom" />
/**
 * The page a browser tab opens (browser.html): it connects to the app, gives the renderer its
 * `window.hive`, then starts the renderer, the same build an app window runs.
 */
import { connectHive } from "./hive";
import { CLOSE_UNAUTHORIZED, SOCKET_PATH, TOKEN_KEY } from "../shared/browser-socket";
import type { HiveApi } from "../shared/ipc";

const SIGN_IN_AGAIN = "Open the link the app shows in Settings → Advanced → In a browser.";

function stored(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

function say(text: string): void {
  const p = document.createElement("p");
  p.textContent = text;
  p.style.cssText = "padding:24px;font:14px system-ui,sans-serif;color:#e7e9ee";
  document.body.replaceChildren(p);
}

let started = false;
const token = stored();
if (!token) {
  say(SIGN_IN_AGAIN);
} else {
  const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${SOCKET_PATH}`;
  try {
    (window as unknown as { hive: HiveApi }).hive = await connectHive(url, token, (code) => {
      if (code === CLOSE_UNAUTHORIZED) {
        try { localStorage.removeItem(TOKEN_KEY); } catch { /* storage off */ }
        say(SIGN_IN_AGAIN);
      } else if (started) {
        // The app restarted or stopped serving: the page asks again, and signs in again if it must.
        setTimeout(() => location.reload(), 1500);
      }
    });
    started = true;
    await import("../renderer/src/main");
  } catch (e) {
    if (!started) say(`The app could not be reached: ${(e as Error).message}`);
  }
}
