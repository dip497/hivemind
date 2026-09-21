// The glass as SHIPPED. Lightning CSS (via @tailwindcss/vite) drops a standard `backdrop-filter`
// that a `-webkit-` twin follows, so the built app had no frost anywhere while `pnpm dev` did —
// dev and release looked different. This runs the built renderer: the chrome frosts, tiles are
// clear glass by design.
import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("the built app frosts the chrome and keeps tiles clear", async () => {
  test.setTimeout(60_000);
  const dir = fs.mkdtempSync("/tmp/hm-gb-");
  const config = path.join(dir, "xdg/hivemind");
  fs.mkdirSync(config, { recursive: true });
  fs.mkdirSync(path.join(dir, "home"));
  fs.writeFileSync(path.join(config, "settings.json"), JSON.stringify({
    v: 1, migrated: true, appearance: { glass: { enabled: true, contentGlass: true, blur: 21 } },
  }));
  const app = await electron.launch({
    args: [path.join(APP_DIR, "out/main/index.js"), "--no-sandbox", `--user-data-dir=${dir}/ud`],
    cwd: APP_DIR,
    env: { ...process.env, HOME: path.join(dir, "home"), XDG_CONFIG_HOME: path.join(dir, "xdg"), HIVEMIND_PTY_DAEMON: "0" },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector(".react-flow", { timeout: 15_000 });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
    await page.waitForSelector(".react-flow__node-terminal");
    await page.waitForTimeout(1500); // at rest: the motion rule drops the blur while moving
    const blur = (sel: string) => page.evaluate((s) => { const el = document.querySelector(s); return el ? getComputedStyle(el).backdropFilter : "missing"; }, sel);
    expect(await blur(".hm-island")).toContain("blur(21px)");
    expect(await blur(".react-flow__node-terminal")).toBe("none");
  } finally {
    await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
