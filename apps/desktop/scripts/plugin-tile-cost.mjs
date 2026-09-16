// Measure what one sandboxed hm-view iframe costs: process count + RSS before
// and after switching the canvas to a bundled example view.
import { _electron as electron } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const appDir = process.argv[2];
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-cost-"));
const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, "config"), HIVEMIND_PTY_DAEMON: "0" };

const tree = (pid) => {
  const out = execFileSync("ps", ["-eo", "pid,ppid,rss,args"], { encoding: "utf8" }).split("\n").slice(1);
  const rows = out.map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean);
  const kids = new Map();
  for (const r of rows) kids.set(r[1], r);
  const want = new Set([String(pid)]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) if (want.has(r[2]) && !want.has(r[1])) { want.add(r[1]); grew = true; }
  }
  const mine = rows.filter((r) => want.has(r[1]));
  return { procs: mine.length, rssMB: Math.round(mine.reduce((a, r) => a + Number(r[3]), 0) / 1024) };
};

// Install the bundled example view into this run's config dir first.
const viewsDir = path.join(root, "config", "hivemind", "views", "orbit");
fs.mkdirSync(viewsDir, { recursive: true });
for (const f of fs.readdirSync(process.argv[3])) fs.copyFileSync(path.join(process.argv[3], f), path.join(viewsDir, f));

const app = await electron.launch({ args: [path.join(appDir, "out/main/index.js"), "--no-sandbox"], cwd: root, env });
const page = await app.firstWindow();
await page.waitForSelector(".react-flow");
await page.waitForTimeout(2500);
const pid = (await app.evaluate(() => process.pid));
const before = tree(pid);

await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "orbit" } })));
await page.waitForTimeout(5000);
const views = await page.evaluate(() => document.querySelectorAll("iframe").length);
const after = tree(pid);
console.log(JSON.stringify({ views, before, after, deltaProcs: after.procs - before.procs, deltaRssMB: after.rssMB - before.rssMB }, null, 2));
await app.close();
fs.rmSync(root, { recursive: true, force: true });
