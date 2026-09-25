// Scale check for view protocol 1.3: N shim agents cycling working → blocked → idle, a view that
// subscribes to status, events, activity and presence, and what that costs the app.
//
//   cd apps/desktop && xvfb-run -n 91 -s "-screen 0 3400x2200x24" node scripts/view-load.mjs [out.json] [50,100]
//
// Each step measures the view subscribed to nothing but structure, then to everything while
// drawing nothing (what the protocol costs), then redrawing on every status (what a view that
// shows status adds on top: under xvfb that is software compositing in the GPU process).
import { _electron as electron } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(APP, "../..");
const CLI = path.join(ROOT, "apps/cli/src/index.ts");
const [OUT = "view-load.json", STEPS_ARG = "50,100"] = process.argv.slice(2);
const STEPS = STEPS_ARG.split(",").map(Number);
const WINDOW_MS = Number(process.env.LOAD_WINDOW_MS ?? 30_000);
const SETTLE_MS = Number(process.env.LOAD_SETTLE_MS ?? 45_000);
const VIEW_ID = "view-load";

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const XDG = tmp("hm-load-xdg-"), HOME = tmp("hm-load-home-"), WORK = tmp("hm-load-work-"), BIN = tmp("hm-load-bin-"), PKG = tmp("hm-load-view-");

fs.writeFileSync(path.join(BIN, "claude"), `#!/usr/bin/env bash
[ "$1" = "--version" ] && { echo "0.0.0 (view-load shim)"; exit 0; }
# The first prompt arrives as the last argument or is typed at the prompt, depending on the path.
line="\${!#}"
if [[ "$line" != bash* ]]; then printf '\\n❯ '; IFS= read -r line; fi
clear
exec bash -c "$line" 2>>"${BIN}/stderr.txt"
`, { mode: 0o755 });
// One agent's day, compressed: 8 s working (a moving spinner), then half the time 6 s asking
// permission, then 6 s idle. Like a real hooked agent it reports turn start and end over the
// control socket, so turns are the hook's, not a guess from the screen.
fs.writeFileSync(path.join(BIN, "cycle.sh"), `#!/usr/bin/env bash
hook() { printf '{"t":"event","topic":"%s","data":{"tileId":"%s"%s}}\\n' "$1" "$HIVEMIND_TILE" "$2" | socat - UNIX-CONNECT:"$(cat ${BIN}/hcp-sock)" >/dev/null 2>&1 & }
sleep $((RANDOM % 20))
while :; do
  hook status ',"state":"working"'
  clear; i=0; end=$((SECONDS+8))
  while [ $SECONDS -lt $end ]; do for g in ✻ ✶ ✳ ✢; do i=$((i+1)); printf '\\r%s Working on it… (%ss · esc to interrupt)  ' "$g" $((i*4/10)); sleep 0.4; done; done
  if (( RANDOM % 2 )); then
    clear
    printf '\\n Edit src/x.ts\\n\\n Do you want to make this edit to src/x.ts?\\n ❯ 1. Yes\\n   2. Yes, and don\\x27t ask again this session\\n   3. No, and tell Claude what to do differently\\n'
    sleep 6
  fi
  hook turn ''
  clear; printf '\\n❯ \\n'; sleep 6
done
`, { mode: 0o755 });

fs.writeFileSync(path.join(PKG, "hivemind-view.json"), JSON.stringify({ id: VIEW_ID, name: "Load", version: "0.1.0", entry: "main.js", protocol: 1, permissions: ["workspace:spawn"], wallpaper: false }));
fs.writeFileSync(path.join(PKG, "main.js"), `import { connect, createInvalidator } from "@hivemind/view-sdk";
const hm = await connect();
const st = { features: hm.hello.features ?? [], structure: 0, status: 0, statusWithSince: 0, inexact: 0, events: {}, activity: 0, presence: 0, custom: 0, tiles: 0 };
window.__load = st;
let tiles = [], on = false, subs = [], drawing = false;
window.__draw = (v) => { drawing = v; };
const offs = new Map();
const { invalidate } = createInvalidator(hm, () => { document.body.textContent = JSON.stringify({ tiles: st.tiles, status: st.status }); });
function sync() {
  if (!on) return;
  for (const t of tiles) if (!offs.has(t.id)) {
    const a = hm.subscribeStatus(t.id, (s, info) => { st.status++; if (info?.since) st.statusWithSince++; if (info && info.exact === false) st.inexact++; if (drawing) invalidate(); });
    const b = hm.activity(t.id, () => { st.activity++; });
    offs.set(t.id, () => { a(); b(); });
  }
  for (const [id, off] of offs) if (!tiles.some((t) => t.id === id)) { off(); offs.delete(id); }
}
hm.on("structure", (s) => { st.structure++; tiles = s.tiles; st.tiles = tiles.length; sync(); invalidate(); });
window.__sub = (v) => {
  on = v;
  if (v) {
    subs.push(hm.onEvents(["turn", "needsInput", "subagents", "tileOpened", "tileClosed"], (e) => { st.events[e.kind] = (st.events[e.kind] ?? 0) + 1; }));
    subs.push(hm.onCustom("load.*", () => { st.custom++; }));
    subs.push(hm.onPresence(() => { st.presence++; }));
    sync();
  } else {
    for (const o of subs) o();
    subs = [];
    for (const o of offs.values()) o();
    offs.clear();
  }
};
window.__spawn = (n, start, prompt) => { for (let i = 0; i < n; i++) hm.commands.spawnAgent("claude", null, { prompt, name: "a" + (start + i) }); };
window.__history = async (day) => {
  const t = performance.now();
  const d = await hm.history(day);
  return { ms: Math.round(performance.now() - t), tiles: d.tiles.length, intervals: d.tiles.reduce((a, x) => a + x.intervals.length, 0), turns: d.tiles.reduce((a, x) => a + x.turns.length, 0), gaps: d.gaps.length, presence: d.presence };
};
`);

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  !k.startsWith("CLAUDE") && !["ELECTRON_RUN_AS_NODE", "ELECTRON_RENDERER_URL", "HIVE_HCP_SOCK", "HCP_TOKEN"].includes(k)));
Object.assign(env, { XDG_CONFIG_HOME: XDG, HOME, HIVEMIND_SHELL_ENV: "0", PATH: `${BIN}:${process.env.PATH}` });
fs.writeFileSync(path.join(HOME, ".bash_profile"), 'PS1="\\W \\$ "\n');
fs.writeFileSync(path.join(HOME, ".hushlogin"), "");
// Agents are plugins: install the published claude manifest where the app looks, as the e2e suite does.
fs.cpSync(path.join(ROOT, "packages/hive-agents/tests/fixtures/published-agents/claude"), path.join(XDG, "hivemind", "agents", "claude"), { recursive: true });
const repo = path.join(WORK, "project");
fs.mkdirSync(repo);
spawnSync("git", ["init", "-q", repo]);

let hcp = {};
const cli = (...a) => spawnSync("bun", [CLI, ...a], { cwd: repo, encoding: "utf8", env: { ...env, ...hcp } });
const inst = cli("views", "install", PKG, "--json");
if (inst.status !== 0) throw new Error(`views install failed: ${inst.stdout}${inst.stderr}`);

const TCK = 100;
const cpuTicks = (pid) => { try { const f = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" "); return Number(f[11]) + Number(f[12]); } catch { return 0; } };
const rssMb = (pid) => { try { return Math.round(Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"))[1]) / 1024); } catch { return 0; } };
const ours = () => fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d)).filter((p) => { try { return fs.readFileSync(`/proc/${p}/environ`, "utf8").includes(`XDG_CONFIG_HOME=${XDG}`); } catch { return false; } });
const cmdline = (p) => { try { return fs.readFileSync(`/proc/${p}/cmdline`, "utf8").replace(/\0/g, " "); } catch { return ""; } };

const app = await electron.launch({ args: [path.join(APP, process.env.HIVEMIND_APP_OUT ?? "out", "main/index.js"), "--no-sandbox"], cwd: repo, env });
const page = await app.firstWindow();
page.on("pageerror", (e) => console.error("[renderer]", e.message));
page.on("console", (m) => { if (m.type() === "error" || /view "|refused/.test(m.text())) console.log(`[console:${m.type()}]`, m.text().slice(0, 240)); });
await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.unmaximize(); w.setContentSize(1600, 1000); });
await page.waitForSelector(".react-flow", { timeout: 60_000 });
for (let i = 0; i < 120 && !hcp.HCP_TOKEN; i++) {
  const d = fs.readdirSync(XDG).map((x) => path.join(XDG, x)).find((x) => fs.existsSync(path.join(x, "hcp.token")));
  if (d) hcp = { HIVE_HCP_SOCK: path.join(d, "hcp.sock"), HCP_TOKEN: fs.readFileSync(path.join(d, "hcp.token"), "utf8").trim() };
  else await page.waitForTimeout(250);
}
fs.writeFileSync(path.join(BIN, "hcp-sock"), hcp.HIVE_HCP_SOCK ?? "");
const wait = (ms) => page.waitForTimeout(ms);
const setView = (id) => page.evaluate((mode) => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode } })), id);
const view = () => page.frame({ name: `hm-view:${VIEW_ID}` });
let pids = null;
async function showView() {
  await setView(VIEW_ID);
  await page.waitForSelector(`[data-community-view="${VIEW_ID}"][data-community-ready="1"]`, { timeout: 30_000 });
  // Count every message the host sends the view, by type, at the host end of the port.
  await page.evaluate(() => {
    const link = document.querySelector("[data-community-view]").__community;
    const orig = link.send.bind(link);
    window.__sent = {};
    link.send = (m) => { window.__sent[m.type] = (window.__sent[m.type] ?? 0) + 1; orig(m); };
  });
  pids = await app.evaluate(({ app, BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    const frame = wc.mainFrame.framesInSubtree.find((f) => f.name.startsWith("hm-view:"));
    const gpu = app.getAppMetrics().find((m) => m.type === "GPU")?.pid ?? null;
    return { main: process.pid, renderer: wc.getOSProcessId(), view: frame?.osProcessId ?? null, gpu };
  });
}
await showView();

async function measure(label, n) {
  const all = ours();
  const daemon = all.filter((p) => /daemon/.test(cmdline(p)));
  const gpu = pids.gpu ? [String(pids.gpu)] : [];
  const groups = { main: [pids.main], renderer: [pids.renderer], view: pids.view ? [pids.view] : [], daemon, gpu };
  const agents = all.filter((p) => !Object.values(groups).flat().map(String).includes(p) && !/electron|chrome|hivemind/i.test(cmdline(p)));
  const app = all.filter((p) => !agents.includes(p));
  const before = Object.fromEntries(Object.entries({ ...groups, app }).map(([k, ps]) => [k, ps.reduce((a, p) => a + cpuTicks(p), 0)]));
  const beforeEach = Object.fromEntries(app.map((p) => [p, cpuTicks(p)]));
  const sent0 = await page.evaluate(() => ({ ...window.__sent }));
  const t0 = Date.now();
  await wait(WINDOW_MS);
  const secs = (Date.now() - t0) / 1000;
  const sent1 = await page.evaluate(() => ({ ...window.__sent }));
  const cpu = Object.fromEntries(Object.entries({ ...groups, app }).map(([k, ps]) => [k, Math.round(((ps.reduce((a, p) => a + cpuTicks(p), 0) - before[k]) / TCK / secs) * 1000) / 10]));
  const rss = Object.fromEntries(Object.entries({ ...groups, app }).map(([k, ps]) => [k, ps.reduce((a, p) => a + rssMb(p), 0)]));
  const perSec = {};
  for (const k of new Set([...Object.keys(sent0), ...Object.keys(sent1)])) { const d = (sent1[k] ?? 0) - (sent0[k] ?? 0); if (d) perSec[k] = Math.round((d / secs) * 10) / 10; }
  const total = Math.round(Object.values(perSec).reduce((a, b) => a + b, 0) * 10) / 10;
  // Whatever else carries the profile, by process type, so no CPU goes unexplained.
  const kind = (p) => { const c = cmdline(p); return /--type=([\w-]+)/.exec(c)?.[1] ?? path.basename(c.split(" ")[0] || "?"); };
  const others = {};
  for (const p of app.filter((p) => !Object.values(groups).flat().map(String).includes(p))) others[kind(p)] = (others[kind(p)] ?? 0) + cpuTicks(p) - (beforeEach[p] ?? 0);
  const otherPercent = Object.fromEntries(Object.entries(others).map(([k, t]) => [k, Math.round((t / TCK / secs) * 1000) / 10]).filter(([, v]) => v >= 0.5));
  const r = { label, agents: n, seconds: Math.round(secs), cpuPercent: { ...cpu, appOther: otherPercent }, rssMb: rss, messagesPerSecond: { total, ...perSec } };
  console.log(JSON.stringify(r));
  return r;
}

const results = [];
const status = () => JSON.parse(cli("ctl", "list", "--json").stdout || "{}");
try {
  let spawned = 0;
  for (const n of STEPS) {
    // The pty pacer queues spawns; ask for them in slices so the view's port never floods.
    while (spawned < n) {
      const k = Math.min(20, n - spawned);
      await view().evaluate(([k, s, p]) => window.__spawn(k, s, p), [k, spawned, `bash ${path.join(BIN, "cycle.sh")}`]);
      spawned += k;
      await wait(1000);
    }
    // A tile's terminal starts once some view has shown it: the canvas shows them all.
    await setView("canvas");
    for (let i = 0; i < 120; i++) {
      const tiles = (status().frames ?? []).flatMap((f) => f.tiles).concat(status().loose ?? []);
      if (tiles.length >= n && tiles.every((t) => t.status)) break;
      await wait(2000);
    }
    await showView();
    await wait(SETTLE_MS);
    const listed = status();
    const counts = {};
    for (const t of (listed.frames ?? []).flatMap((f) => f.tiles).concat(listed.loose ?? [])) counts[t.status ?? "none"] = (counts[t.status ?? "none"] ?? 0) + 1;
    console.log(`step ${n}: tiles by status`, JSON.stringify(counts));
    await view().evaluate(() => window.__sub(false));
    results.push({ ...(await measure("structure only", n)), statuses: counts });
    await view().evaluate(() => window.__sub(true));
    await wait(3000);
    results.push({ ...(await measure("all 1.3 subscriptions, view draws nothing", n)), statuses: counts });
    await view().evaluate(() => window.__draw(true));
    results.push({ ...(await measure("all 1.3 subscriptions, view redraws on every status", n)), statuses: counts });
    await view().evaluate(() => window.__draw(false));
    const emitted = cli("ctl", "view", "emit", "load.ping", `{"n":${n}}`, "--json");
    results.at(-1).emit = JSON.parse(emitted.stdout || "{}");
    await wait(500);
    const day = new Date().toLocaleDateString("en-CA");
    results.at(-1).history = await view().evaluate((d) => window.__history(d), day);
    results.at(-1).view = await view().evaluate(() => ({ ...window.__load }));
    await view().evaluate(() => window.__sub(false));
  }
} finally {
  fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), cpus: os.cpus().length, load: os.loadavg(), windowMs: WINDOW_MS, results }, null, 2));
  const pid = app.process().pid;
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, 8000))]);
  try { process.kill(pid, "SIGKILL"); } catch {}
  // Only processes carrying this run's private profile: its daemon and the agents it kept alive.
  for (const p of ours()) { try { process.kill(Number(p), "SIGKILL"); } catch {} }
  for (const d of [XDG, HOME, WORK, BIN, PKG]) fs.rmSync(d, { recursive: true, force: true });
}
