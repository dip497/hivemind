// The app's window for a spec. As the app by default; with HIVE_HARNESS=browser (the harness,
// playwright.harness.config.ts), as the renderer in Chromium over the dev-bridge, which answers
// it through the workspace API (R8) from its own host for `cwd`: the same window, with no Electron
// behind it. `--user-data-dir` becomes the bridge's config directory, so a spec that relaunches on
// the same one finds what it kept.
import { _electron as electron, chromium, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
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
  if (!inBrowser()) {
    const app = await electron.launch({
      args: [path.join(APP_DIR, "out/main/index.js"), "--no-sandbox", ...(opts.args ?? [])],
      cwd: opts.cwd,
      ...(opts.env ? { env: opts.env as Record<string, string> } : {}),
    });
    const page = await app.firstWindow();
    return { page, close: () => app.close() };
  }
  const dataDir = opts.args?.find((a) => a.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
  const config = dataDir ?? (opts.env?.XDG_CONFIG_HOME || fs.mkdtempSync(path.join(os.tmpdir(), "hm-harness-")));
  const port = await freePort();
  const bridge = spawn(path.join(APP_DIR, "node_modules/.bin/tsx"), ["src/dev-bridge/server.ts", opts.cwd], {
    cwd: APP_DIR,
    env: { ...process.env, ...opts.env, XDG_CONFIG_HOME: config, HIVE_BRIDGE_PORT: String(port) } as Record<string, string>,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  bridge.stdout!.on("data", (d) => { log += d; });
  bridge.stderr!.on("data", (d) => { log += d; });
  await until(() => answers(port), 30_000, () => `the dev-bridge did not start:\n${log}`);
  const browser = await chromium.launch(process.env.HIVE_HARNESS_CHROMIUM ? { executablePath: process.env.HIVE_HARNESS_CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(`http://127.0.0.1:${port}/`);
  return {
    page,
    close: async () => {
      await browser.close();
      await stop(bridge);
    },
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function answers(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/auth-token`)).ok;
  } catch {
    return false;
  }
}

async function until(check: () => Promise<boolean>, ms: number, why: () => string): Promise<void> {
  for (const end = Date.now() + ms; !(await check()); await new Promise((r) => setTimeout(r, 200))) {
    if (Date.now() > end) throw new Error(why());
  }
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGINT");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  });
}
