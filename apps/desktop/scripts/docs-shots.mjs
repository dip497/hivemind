// Screenshots of the real app for the guide, one per entry in guide/docs-shots.json. Each entry
// sets the app up with real commands and events, then crops to the part the page talks about.
//
//   cd apps/desktop && xvfb-run -a -s "-screen 0 1700x1100x24" \
//     node scripts/docs-shots.mjs <out-dir> [--mode dark|light] [--only name,name]
//
// The run gets its own settings profile and HOME, as site-shots.mjs does, so it cannot touch a
// live session. An entry marked "todo" is listed for a person to capture and is skipped here.
import { _electron as electron } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(APP, "../..");
const CLI = path.join(ROOT, "apps/cli/src/index.ts");
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const OUT = path.resolve(args[0] && !args[0].startsWith("--") ? args[0] : "docs-shots");
const MODE = opt("mode", "dark");
const ONLY = opt("only", null)?.split(",");
const SIZE = { width: 1600, height: 1000 };

const list = JSON.parse(fs.readFileSync(path.join(ROOT, "guide/docs-shots.json"), "utf8"));
const shots = list.shots.filter((s) => s.status !== "todo" && (!ONLY || ONLY.includes(s.name)));

fs.mkdirSync(OUT, { recursive: true });
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const XDG = tmp("hm-docs-xdg-"), HOME = tmp("hm-docs-home-"), WORK = tmp("hm-docs-work-");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  !k.startsWith("CLAUDE") && !k.startsWith("HIVE") && !["ELECTRON_RUN_AS_NODE", "ELECTRON_RENDERER_URL", "HCP_TOKEN"].includes(k)));
Object.assign(env, { XDG_CONFIG_HOME: XDG, HOME, HIVEMIND_SHELL_ENV: "0" });
const profile = 'PS1="\\[\\e[38;5;244m\\]\\W\\[\\e[0m\\] \\$ "\nexport GIT_PAGER=cat PAGER=cat LESS=FRX\n';
fs.writeFileSync(path.join(HOME, ".bash_profile"), profile);
fs.writeFileSync(path.join(HOME, ".bashrc"), profile);
for (const quiet of [".hushlogin", ".sudo_as_admin_successful"]) fs.writeFileSync(path.join(HOME, quiet), "");

const repo = path.join(WORK, "my-project");
execFileSync("git", ["clone", "-q", "--depth", "20", `file://${ROOT}`, repo]);
execFileSync("git", ["-C", repo, "config", "user.email", "docs@hivemind.dev"]);
execFileSync("git", ["-C", repo, "config", "user.name", "hivemind"]);

let hcp = {};
const cli = (a) => {
  const r = spawnSync("bun", [CLI, ...a], { cwd: repo, encoding: "utf8", env: { ...env, ...hcp } });
  if (r.status !== 0) console.error(`hive ${a.join(" ")}: ${(r.stderr || r.stdout).trim().split("\n").pop()}`);
  return r;
};
cli(["config", "set", "appearance.mode", JSON.stringify(MODE)]);
for (const s of list.before ?? []) cli(s);

const app = await electron.launch({ args: [path.join(APP, "out/main/index.js"), "--no-sandbox", "--force-device-scale-factor=2"], cwd: repo, env });
const page = await app.firstWindow();
await app.evaluate(({ app: a, ipcMain }) => {
  ipcMain.removeHandler("checkForUpdate");
  ipcMain.handle("checkForUpdate", () => ({ current: a.getVersion(), latest: a.getVersion(), updateAvailable: false, ok: true }));
});
await app.evaluate(({ BrowserWindow }, s) => {
  const w = BrowserWindow.getAllWindows()[0];
  w.unmaximize();
  w.setBounds({ x: 0, y: 0, width: s.width, height: s.height });
}, SIZE);
await page.reload();
await page.waitForSelector(".react-flow", { timeout: 30_000 });
for (let i = 0; i < 80 && !hcp.HCP_TOKEN; i++) {
  const d = fs.readdirSync(XDG).map((x) => path.join(XDG, x)).find((x) => fs.existsSync(path.join(x, "hcp.token")));
  if (d) hcp = { HIVE_HCP_SOCK: path.join(d, "hcp.sock"), HCP_TOKEN: fs.readFileSync(path.join(d, "hcp.token"), "utf8").trim(), HIVEMIND_APP_DATA: d };
  else await page.waitForTimeout(250);
}
if (!hcp.HCP_TOKEN) throw new Error("the app never opened its control socket");

const emit = (name, detail) => page.evaluate(([n, d]) => window.dispatchEvent(new CustomEvent(n, { detail: d })), [name, detail]);
const closeAll = async () => { for (let i = 0; i < 3; i++) { await page.keyboard.press("Escape"); await page.waitForTimeout(150); } };

/** One step of an entry's setup. The step kinds are the whole vocabulary of docs-shots.json. */
async function step(s) {
  if (s.cli) return void cli(s.cli);
  if (s.ctl) return void cli(["ctl", ...s.ctl]);
  if (s.settings) return emit("hivemind:open-settings", { page: s.settings });
  if (s.event) return emit(s.event, s.detail);
  if (s.click) return page.getByText(s.click, { exact: true }).first().click({ timeout: 5000 });
  if (s.button) return page.locator(`button[title^="${s.button}"]`).first().click({ timeout: 5000, force: true });
  if (s.press) return page.keyboard.press(s.press);
  if (s.wait) return page.waitForTimeout(s.wait);
  throw new Error(`unknown step ${JSON.stringify(s)}`);
}

let failed = 0;
try {
  for (const s of shots) {
    try {
      await closeAll();
      for (const st of s.setup ?? []) { await step(st); await page.waitForTimeout(400); }
      await page.waitForTimeout(1200);
      const file = path.join(OUT, `${s.name}.${MODE}.png`);
      const target = s.crop ? page.locator(s.crop).first() : null;
      if (target) await target.screenshot({ path: file, timeout: 10_000 });
      else await page.screenshot({ path: file });
      console.log(`shot ${s.name} → ${path.basename(file)}`);
    } catch (e) {
      failed++;
      console.error(`FAILED ${s.name}: ${e.message.split("\n")[0]}`);
    }
  }
} finally {
  const pid = app.process().pid;
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, 8000))]);
  try { process.kill(pid, "SIGKILL"); } catch {}
  for (const d of [XDG, HOME, WORK]) fs.rmSync(d, { recursive: true, force: true });
}
// A shot the list asks for and the app can no longer show means the guide is out of date.
if (failed) { console.error(`${failed} shot(s) could not be made`); process.exit(1); }
