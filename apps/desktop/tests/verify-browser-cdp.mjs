// Standalone verifier: launches the built Electron app with a FIXED remote-
// debugging port (Playwright's electron.launch injects port=0, which this
// sandbox's Electron rejects), connects over CDP, spawns a Browser tile, and
// drives it through the real browserCdp bridge — proving navigate + DOM-read.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pw from "/home/dipendra-sharma/projects/hivemind/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core/index.js";
const { chromium } = pw;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, "..");
const PORT = 9333;
const electronBin = path.resolve(APP_DIR, "../../node_modules/.pnpm/electron@33.4.11/node_modules/electron/dist/electron");

const proc = spawn(
  electronBin,
  [
    path.join(APP_DIR, "out/main/index.js"),
    "--no-sandbox",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=/tmp/hivemind-verify-${Date.now()}`,
  ],
  { cwd: APP_DIR, env: { ...process.env, DISPLAY: process.env.DISPLAY || ":1", HIVEMIND_PTY_DAEMON: "0" }, stdio: ["ignore", "pipe", "pipe"] },
);
proc.stdout.on("data", (d) => process.stdout.write(`[main] ${d}`));
proc.stderr.on("data", (d) => process.stderr.write(`[main.err] ${d}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let exitCode = 1;

async function findAppPage(browser) {
  for (let i = 0; i < 40; i++) {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        try {
          if (await p.evaluate(() => !!document.querySelector(".react-flow") && !!window.hive)) return p;
        } catch { /* page not ready / devtools target */ }
      }
    }
    await sleep(500);
  }
  throw new Error("app window with .react-flow + window.hive not found");
}

try {
  // Wait for the CDP endpoint, then connect.
  let browser;
  for (let i = 0; i < 40; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); break; } catch { await sleep(500); }
  }
  if (!browser) throw new Error("could not connect over CDP — app never opened debug port");
  console.log("• connected over CDP");

  const page = await findAppPage(browser);
  console.log("• found app window");

  // Spawn a frame, then a Browser tile inside it.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:add-frame")));
  await page.waitForSelector(".react-flow__node-frame", { timeout: 5000 });
  const frameId = await page.locator(".react-flow__node-frame").first().getAttribute("data-id");
  console.log("• frame:", frameId);

  await page.evaluate((fid) => window.dispatchEvent(new CustomEvent("hivemind:frame-open", { detail: { frameId: fid, kind: "browser" } })), frameId);
  await page.waitForSelector(".react-flow__node-browser", { timeout: 5000 });
  const tileId = await page.locator(".react-flow__node-browser").first().getAttribute("data-id");
  console.log("• browser tile:", tileId);

  const webviews = await page.locator("webview").count();
  if (webviews < 1) throw new Error("no <webview> guest mounted");
  console.log("• <webview> guest mounted:", webviews);

  // Wait for the guest dom-ready to register with the CDP bridge.
  let ready = "";
  for (let i = 0; i < 50; i++) {
    ready = await page.evaluate(async (id) => {
      try { await window.hive.browserCdp(id, "Runtime.evaluate", { expression: "1+1", returnByValue: true }); return "ready"; }
      catch (e) { return String(e.message ?? e); }
    }, tileId);
    if (ready === "ready") break;
    await sleep(400);
  }
  if (ready !== "ready") throw new Error("CDP bridge never became ready: " + ready);
  console.log("• CDP bridge attached to the visible tab");

  // Drive the visible tab: navigate via CDP, then read its DOM back.
  await page.evaluate((id) => window.hive.browserCdp(id, "Page.navigate", {
    url: "data:text/html,<title>HiveCDP</title><h1 id=h>cdp-drove-this</h1>",
  }), tileId);

  let got = "";
  for (let i = 0; i < 30; i++) {
    got = await page.evaluate(async (id) => {
      const r = await window.hive.browserCdp(id, "Runtime.evaluate", {
        expression: "document.title + '|' + (document.getElementById('h')?.textContent ?? '')",
        returnByValue: true,
      });
      return r?.result?.value ?? "";
    }, tileId);
    if (got === "HiveCDP|cdp-drove-this") break;
    await sleep(300);
  }

  if (got !== "HiveCDP|cdp-drove-this") throw new Error("CDP read mismatch, got: " + JSON.stringify(got));
  console.log("• CDP navigated the tab and read its DOM back:", got);

  // Bonus: screenshot via CDP (what a vision agent sees).
  const shot = await page.evaluate(async (id) => {
    const r = await window.hive.browserCdp(id, "Page.captureScreenshot", {});
    return (r?.data ?? "").length;
  }, tileId);
  console.log("• CDP screenshot bytes (base64 len):", shot);

  console.log("\n✅ PASS — Browser tile spawns a real <webview> and is fully drivable over CDP");
  exitCode = 0;
} catch (e) {
  console.error("\n❌ FAIL —", e.message);
} finally {
  try { proc.kill("SIGKILL"); } catch { /* */ }
  await sleep(300);
  process.exit(exitCode);
}
