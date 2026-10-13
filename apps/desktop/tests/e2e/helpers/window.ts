// The app's window for a spec. As the app by default; with HIVE_HARNESS=browser (the harness,
// playwright.harness.config.ts), as a browser tab on the same app: the app is launched as usual,
// serves itself to a browser (Settings → Your devices, "In a browser on this computer") and Chromium opens the link
// it shows, so the spec drives the renderer over the browser server's socket instead of IPC.
import { _electron as electron, chromium, type Page } from "@playwright/test";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export interface AppWindow {
  page: Page;
  close(): Promise<void>;
}

export interface LaunchOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  /** Arguments to the app after its entry (`--user-data-dir=…`). */
  args?: string[];
}

export const inBrowser = (): boolean => process.env.HIVE_HARNESS === "browser";

export async function launchWindow(opts: LaunchOptions): Promise<AppWindow> {
  const app = await electron.launch({
    args: [path.join(APP_DIR, "out/main/index.js"), "--no-sandbox", ...(opts.args ?? [])],
    cwd: opts.cwd,
    ...(opts.env ? { env: opts.env as Record<string, string> } : {}),
  });
  const window = await app.firstWindow();
  if (!inBrowser()) return { page: window, close: () => app.close() };
  const url = await openInABrowser(window, await freePort());
  const browser = await chromium.launch(process.env.HIVE_HARNESS_CHROMIUM ? { executablePath: process.env.HIVE_HARNESS_CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(url);
  return {
    page,
    close: async () => {
      await browser.close();
      await app.close();
    },
  };
}

/** Turns the app's browser server on at `port`, as Settings → Your devices does, and returns the link it shows. */
export async function openInABrowser(app: Page, port: number): Promise<string> {
  await app.waitForFunction(() => "hive" in window);
  await app.evaluate((p) => window.hive.settingsSet("browserApp", { enabled: true, port: p, names: [] }), port);
  const handle = await app.waitForFunction(async () => (await window.hive.browserAppStatus()).url, undefined, { timeout: 15_000, polling: 200 });
  return (await handle.jsonValue()) as string;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}
