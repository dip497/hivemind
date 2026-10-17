// A setting changed just before the app quits is written, and settings.json's lock is not left
// behind. The app used to exit with that write still in flight: the change was lost, and an app
// that quit between taking the lock and writing its owner into it left a lock no later writer
// could clear, so every `hive config set` after it failed.
import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("a setting changed just before quitting is written, even while another writer holds the lock", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-settings-quit-"));
  const xdg = path.join(root, "config");
  const file = path.join(xdg, "hivemind", "settings.json");
  const lock = `${file}.lock`;
  const app = await electron.launch({
    args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox", `--user-data-dir=${path.join(root, "data")}`],
    cwd: root,
    env: { ...process.env, XDG_CONFIG_HOME: xdg } as Record<string, string>,
  });
  const page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 30_000 });

  // Another writer (a `hive config set`, alive: it is this process) holds the lock, so the
  // app's write is still waiting for it when the app is told to quit.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(lock, `${process.pid}:${Date.now()}:elsewhere`);
  await page.evaluate(() => { void window.hive.settingsSet("agents.defaultAgent", "codex"); });
  const closing = app.close();
  await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(lock); // the other writer is done
  await closing;

  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) as { agents?: { defaultAgent?: string } } : {};
  expect(saved.agents?.defaultAgent).toBe("codex");
  expect(fs.existsSync(lock)).toBe(false);
  fs.rmSync(root, { recursive: true, force: true });
});
