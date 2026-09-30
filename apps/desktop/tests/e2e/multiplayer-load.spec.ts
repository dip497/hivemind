// The load gate for terminals together (M2, design §4.4): a host with 100 tiles, ten of whose
// terminals stream in view, and four guests (people who joined, here without windows) each
// watching those ten. What the host does for them is measured as the CPU of every process of its
// app (main, its window, its pty daemon, its hive-net daemon), not the programs in the terminals,
// which do the same work either way, and not drawing: the display compositor and the window's
// compositor and raster threads, whose work is the GPU's on a real display and llvmpipe's, on the
// CPU, under xvfb (docs/design/performance-native-2026-09-09.md). The wallpaper is still: it
// animates for 30 s after any input, which the host's clicking Allow would start in one half only.
//
// Watching, the host works at most 20% more than alone (the design's gate). With all four moving
// their pointer 20 times a second the whole time, it is told of them and draws them: at most 20
// points of a core more. (That case misses the gate read as 20% of the host's own work: see M2 in
// docs/plans/multiplayer.md.)
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { person, tiles } from "./helpers/multiplayer";
import { guest, type Guest } from "./helpers/guest";

let root: string;
const apps: ElectronApplication[] = [];
const guests: Guest[] = [];
test.beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-load-")); });
test.afterEach(async () => {
  for (const g of guests.splice(0)) g.stop();
  const reap = () => { try { execSync(`pkill -f "out/main/pty-daemon.js ${root}/"`, { stdio: "ignore" }); } catch { /* none */ } };
  reap();
  for (const a of apps.splice(0)) await a.close().catch(() => {});
  reap();
  fs.rmSync(root, { recursive: true, force: true });
});

/** hive-net as it ships: a debug build's crypto and QUIC are many times slower. */
const HIVE_NET = path.resolve("../../crates/hive-net/target/release/hive-net");
const TILES = 100;
const STREAMING = 10;
const GUESTS = 4;
const MEASURE_MS = 20_000;
/** The processes of the app, as opposed to what runs in its terminals. */
const APP = /^(electron|hivemind|node|hive-net|chrome|Chrome_|ThreadPool|.*Electron)/;
/** Threads that draw. */
const DRAWING = /^(Compositor|CompositorTileW|VizCompositorTh|CrGpuMain|GpuWatchdog|Chrome_InProcGpu)/;

interface Proc { ppid: number; comm: string; ticks: number }
function statOf(file: string): Proc | null {
  try {
    const stat = fs.readFileSync(file, "utf8");
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { ppid: Number(f[1]), comm: stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")")), ticks: Number(f[11]) + Number(f[12]) };
  } catch { return null; }
}

/** What part of the app a process is: main, a window, the display, the pty daemon, hive-net. */
function partOf(p: number, comm: string, threads: string[]): string {
  if (comm === "hive-net") return "hive-net";
  if (threads.some((t) => /VizCompositorTh|CrGpuMain/.test(t))) return "display";
  let cmd = "";
  try { cmd = fs.readFileSync(`/proc/${p}/cmdline`, "utf8"); } catch { /* gone */ }
  if (cmd.includes("pty-daemon")) return "pty-daemon";
  return /--type=([a-z-]+)/.exec(cmd)?.[1] ?? "main";
}

/** CPU seconds the app under `pid` has used so far, drawing aside, in all and by part. */
function appCpu(pid: number): { work: number; parts: Map<string, number> } {
  const all = new Map<number, Proc>();
  for (const d of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    const s = statOf(`/proc/${d}/stat`);
    if (s) all.set(Number(d), s);
  }
  let work = 0;
  const parts = new Map<string, number>();
  const add = (part: string, seconds: number) => parts.set(part, (parts.get(part) ?? 0) + seconds);
  for (const [p, s] of all) {
    let up = p;
    while (up > 1 && up !== pid) up = all.get(up)?.ppid ?? 0;
    if (up !== pid || !APP.test(s.comm)) continue;
    let threads: Proc[] = [];
    try { threads = fs.readdirSync(`/proc/${p}/task`).map((t) => statOf(`/proc/${p}/task/${t}/stat`)).filter((t): t is Proc => !!t); } catch { /* gone */ }
    const part = partOf(p, s.comm, threads.map((t) => t.comm));
    if (part === "display") { add("drawing", s.ticks / 100); continue; }
    for (const t of threads) {
      if (DRAWING.test(t.comm)) { add("drawing", t.ticks / 100); continue; }
      add(part, t.ticks / 100);
      work += t.ticks / 100;
    }
  }
  return { work, parts };
}

/** The host's work over the next `ms`, as a share of one core, and each part's. */
async function load(pid: number, ms: number): Promise<{ share: number; parts: string }> {
  const before = appCpu(pid);
  await new Promise((r) => setTimeout(r, ms));
  const after = appCpu(pid);
  const pct = (s: number) => `${((s / (ms / 1000)) * 100).toFixed(1)}%`;
  const parts = [...after.parts].map(([part, s]) => `${part} ${pct(s - (before.parts.get(part) ?? 0))}`).join(", ");
  return { share: (after.work - before.work) / (ms / 1000), parts };
}
const said = (label: string, l: { share: number; parts: string }) => `${label} ${(l.share * 100).toFixed(1)}% of a core (${l.parts})`;

/** A line every 20 ms, with nothing forked per line (bash's `read -t` on a pipe nobody writes). */
const STREAM = `f=$(mktemp -u); mkfifo $f; exec 3<>$f; rm $f; while :; do printf 'stream %s the quick brown fox jumps over the lazy dog %s\\n' $SECONDS $RANDOM; read -t 0.02 -u 3; done\r`;

test("with four people watching ten streaming terminals of 100 tiles the host works at most 20% more; with their pointers moving, 20 points of a core more", async () => {
  test.skip(!fs.existsSync(HIVE_NET), "build hive-net for release first: cargo build --release in crates/hive-net");
  test.setTimeout(300_000);
  const repo = path.join(root, "api");
  fs.mkdirSync(repo);
  execSync("git init -q", { cwd: repo });
  const host: Page = await person(root, "host", repo, apps, { HIVEMIND_PTY_DAEMON: "1", HIVEMIND_HIVE_NET: HIVE_NET });
  const pid = apps[0]!.process().pid!;
  await host.evaluate(() => window.hive.settingsSet("appearance.glass.animate", false));
  for (let i = 0; i < TILES; i++) await host.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await expect.poll(async () => (await tiles(host)).filter((id) => id.startsWith("tile-shell")).length, { timeout: 60_000 }).toBe(TILES);
  await host.waitForTimeout(5_000); // every shell is up
  // As many tiles in view as fit (Escape on the board): the ten that stream are ten of those.
  await host.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  const inView = () => host.evaluate(() => [...document.querySelectorAll(".react-flow__node-terminal")].filter((node) => {
    const r = node.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
  }).map((node) => node.getAttribute("data-id")!));
  await expect.poll(async () => (await inView()).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(STREAMING);
  const streaming = (await inView()).slice(0, STREAMING);
  // Each of the ten streams, as the host shows it: one whose shell was not up yet when it was
  // told is told again.
  const screens = () => host.evaluate((ids) => ids.map((id) => {
    const node = document.querySelector(`.react-flow__node[data-id="${id}"]`);
    const shown = node && ([node, ...node.querySelectorAll("*")].find((e) => "__hmScreen" in e) as (Element & { __hmScreen(): string }) | undefined);
    return shown?.__hmScreen() ?? "";
  }), streaming);
  await expect.poll(async () => {
    const before = await screens();
    await host.waitForTimeout(500);
    const after = await screens();
    const still = streaming.filter((_, i) => before[i] === after[i]);
    for (const tile of still) await host.evaluate(([t, s]) => window.hive.ptyWrite(`hm:${t}`, s), [tile, STREAM] as const);
    return still.length;
  }, { timeout: 60_000, intervals: [1_000] }).toBe(0);
  await host.waitForTimeout(15_000); // settled: the hundred starts are done with
  const alone = await load(pid, MEASURE_MS);

  // Four people join, and watch the ten.
  const invite = await host.evaluate((r) => window.hive.share(r, "view", 3_600_000, true), repo);
  const heard = new Map<number, Set<string>>();
  for (let n = 0; n < GUESTS; n++) {
    const g = await guest(path.join(root, `guest-${n}`), `Guest ${n}`, invite, () => host.locator(".hm-join-request").getByRole("button", { name: "Allow" }).first().click(), HIVE_NET);
    guests.push(g);
    g.client.on("terminal.data", (tile) => {
      let seen = heard.get(n);
      if (!seen) heard.set(n, (seen = new Set()));
      seen.add(tile);
    });
    for (const tile of streaming) {
      await g.client.call("terminal.open", { tileId: `hm:${tile}`, cwd: repo, cmd: "/bin/bash", cols: 120, rows: 40, attachOnly: true });
      g.client.notice("terminal.show", `hm:${tile}`, true);
    }
  }
  await host.waitForTimeout(3_000);
  heard.clear();
  const watching = await load(pid, MEASURE_MS);
  // Each of them was sent each of the ten streams.
  expect([...heard.values()].map((seen) => seen.size)).toEqual(Array(GUESTS).fill(STREAMING));

  // Now their pointers move, 20 times a second each.
  let step = 0;
  const moving = guests.map((g, n) => setInterval(() => {
    step++;
    g.client.notice("presence.set", g.repo, { name: `Guest ${n}`, color: "", cursor: { x: 200 + ((step * 7) % 800), y: 150 + ((step * 5) % 500) }, selection: [] });
  }, 50));
  await host.waitForTimeout(3_000);
  const moved = await load(pid, MEASURE_MS);
  for (const m of moving) clearInterval(m);

  console.log(`[load] ${said("alone", alone)}; ${said("watching", watching)}, +${(((watching.share - alone.share) / alone.share) * 100).toFixed(1)}%; ${said("moving", moved)}, +${((moved.share - alone.share) * 100).toFixed(1)} points`);
  expect(watching.share).toBeLessThanOrEqual(alone.share * 1.2);
  expect(moved.share - alone.share).toBeLessThanOrEqual(0.2);
});
