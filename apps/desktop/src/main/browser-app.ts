/**
 * Settings → Advanced → In a browser (docs/design/browser-app-2026-10-13.md): the browser
 * server runs while the setting is on, with a token minted once per launch, and each signed-in
 * tab is a client of the app as a window is.
 */
import type { BrowserAppSettings, Settings } from "@hivemind/core/settings-schema";
import type { BrowserAppStatus } from "../shared/ipc.js";
import { mintToken } from "./browser-gate.js";
import { serveBrowser, type BrowserServer } from "./browser-server.js";
import { handle, tabChannels } from "./app-ipc.js";
import { broadcast, registerTab } from "./windows.js";
import { schemeHandler } from "./schemes.js";

const token = mintToken();
let server: BrowserServer | null = null;
let serving: BrowserAppSettings | null = null;
let status: BrowserAppStatus = { on: false, url: null, others: [], error: null };
let settled: Promise<void> = Promise.resolve();

const same = (a: BrowserAppSettings, b: BrowserAppSettings): boolean =>
  a.enabled === b.enabled && a.port === b.port && a.names.join(" ") === b.names.join(" ");

function tell(next: BrowserAppStatus): void {
  status = next;
  broadcast("browserApp:changed", status);
}

async function follow(root: string, want: BrowserAppSettings): Promise<void> {
  if (serving && same(serving, want)) return;
  if (!want.enabled && !server && !status.error) return;
  if (server) {
    await server.close();
    server = null;
    serving = null;
  }
  if (!want.enabled) return tell({ on: false, url: null, others: [], error: null });
  try {
    server = await serveBrowser({
      port: want.port,
      names: want.names,
      token,
      root,
      page: "browser.html",
      platform: process.platform,
      channels: tabChannels,
      schemes: schemeHandler,
      onTab: registerTab,
      onError: (m) => console.warn(`[browser-app] ${m}`),
    });
    serving = want;
    // Another name is reached through something serving HTTPS in front of the app (tailscale serve).
    const others = want.names.map((n) => `https://${n}/#token=${token}`);
    tell({ on: true, url: `http://127.0.0.1:${server.port}/#token=${token}`, others, error: null });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    tell({ on: false, url: null, others: [], error: err.code === "EADDRINUSE" ? `Port ${want.port} is in use by another program` : err.message });
  }
}

/** Serve `root` (the built renderer) while the setting says so. */
export function installBrowserApp(root: string, settings: () => Settings, onChange: (listener: (s: Settings) => void) => unknown): void {
  handle("browserApp:status", () => status);
  const apply = (want: BrowserAppSettings): void => {
    settled = settled.then(() => follow(root, want));
  };
  apply(settings().browserApp);
  onChange((s) => apply(s.browserApp));
}
