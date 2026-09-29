// Two windows on one workspace (docs/design/multiplayer-2026-09-28.md, R5): main holds each
// session once and relays it to every window that shows it, and what the control plane does
// shows in both. The agents are the stand-ins on PATH (fixtures/fake-agent.cjs), with the real
// hook injection each gets, and the PTY daemon is on: only a host that keeps each session's
// screen can show it to a window that opens late. Its own app, so its spawns count against a
// rate limit of their own.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, "../..");
const CLI = path.resolve(APP_DIR, "../cli/src/index.ts");
const FIXTURE = path.join(__dirname, "fixtures", "fake-agent.cjs");
const XDG = process.env.XDG_CONFIG_HOME!;

let app: ElectronApplication;
let page: Page;
let repo: string;
let fakeBin: string;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "hm-windows-home-"));
let hcp: Record<string, string> = {};

function onPath(bin: string): string {
  for (const d of (process.env.PATH ?? "").split(":")) {
    const p = path.join(d, bin);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  throw new Error(`${bin} not on PATH`);
}

/** Run `hive …` as an agent would: a subprocess with the control plane's socket and token. */
function hive(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(onPath("bun"), [CLI, ...args], { encoding: "utf8", timeout: 120_000, env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, ...hcp, ...env } });
  let json: any;
  try { json = JSON.parse(r.stdout.trim().split("\n").pop() || ""); } catch { /* not json */ }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

/** What `w`'s terminal for `tile` shows. */
const screenOf = (w: Page, tile: string) => w.evaluate((id) =>
  (document.querySelector(`.react-flow__node[data-id="${id}"] .xterm`)?.parentElement as (HTMLElement & { __hmScreen?: () => string }) | null)?.__hmScreen?.() ?? "", tile);

test.beforeAll(async () => {
  test.setTimeout(180_000);
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "hm-windows-"));
  execSync("git init -q", { cwd: repo });
  fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "hm-windows-bin-"));
  for (const name of ["claude", "droid"]) {
    const shim = path.join(fakeBin, name);
    fs.writeFileSync(shim, `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)} ${name} "$@"\n`);
    fs.chmodSync(shim, 0o755);
  }
  app = await electron.launch({
    args: [path.join(APP_DIR, "out/main/index.js"), "--no-sandbox"],
    cwd: repo,
    // HIVEMIND_SHELL_ENV=0 keeps this PATH (the stand-ins first), not the login shell's.
    env: { ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH}`, HIVEMIND_PTY_DAEMON: "1", HIVEMIND_SHELL_ENV: "0" } as Record<string, string>,
  });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  const userData = path.join(XDG, "hivemind-dev");
  await expect.poll(() => fs.existsSync(path.join(userData, "hcp.token")), { timeout: 20_000 }).toBe(true);
  hcp = { HIVE_HCP_SOCK: path.join(userData, "hcp.sock"), HCP_TOKEN: fs.readFileSync(path.join(userData, "hcp.token"), "utf8").trim() };
});

test.afterAll(async () => {
  // Reap this spec's daemon before closing the app (close() waits on child processes), and again
  // after: the closing app starts another to let go of its tiles.
  try { execSync(`pkill -f "out/main/pty-daemon.js ${XDG}/"`, { stdio: "ignore" }); } catch { /* none */ }
  const closed = await Promise.race([app?.close().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 10_000))]);
  if (!closed) { try { app?.process().kill("SIGKILL"); } catch { /* gone */ } }
  try { execSync(`pkill -f "out/main/pty-daemon.js ${XDG}/"`, { stdio: "ignore" }); } catch { /* none */ }
  try { execSync(`pkill -f "fixtures/fake-agent\\.cjs (claude|droid) "`, { stdio: "ignore" }); } catch { /* none */ }
  for (const d of [repo, fakeBin, home]) fs.rmSync(d, { recursive: true, force: true });
});

test("a second window on the workspace shows its terminals live and the wires drawn, and what the control plane spawns, names and closes", async () => {
  // Quotes split each marker in what is typed, so only the output carries it whole.
  const parent: string = hive(["ctl", "spawn", "--agent", "claude", "--name", "twin-parent", "--prompt", 'echo early""-words', "--json"]).json.tileId;
  expect(hive(["ctl", "read", parent, "--timeout", "40000", "--json"]).json).toMatchObject({ text: "early-words" });
  const child: string = hive(["ctl", "spawn", "--agent", "claude", "--name", "twin-child", "--prompt", "echo child", "--no-report", "--json"], { HIVEMIND_TILE: `hm:${parent}` }).json.tileId;
  const wire = `[data-testid="rf__edge-spawn-${parent}-${child}"]`;
  await expect(page.locator(wire)).toHaveCount(1);

  // Another project was opened last: the new window opens on the one this window shows anyway.
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "hm-xprov-else-"));
  execSync("git init -q", { cwd: elsewhere });
  await page.evaluate((p) => localStorage.setItem("hivemind:last-project", p), elsewhere);
  const [second] = await Promise.all([app.waitForEvent("window"), page.evaluate(() => window.hive.newWindow())]);
  await second.waitForSelector(".react-flow", { timeout: 15_000 });
  const windows = [page, second];
  // It opens on the terminal as it is, and on the wire drawn before it opened.
  await expect.poll(() => screenOf(second, parent), { timeout: 15_000 }).toContain("early-words");
  await expect(second.locator(wire)).toHaveCount(1);
  expect(hive(["ctl", "send", parent, 'echo live""-in-both']).code).toBe(0);
  for (const w of windows) await expect.poll(() => screenOf(w, parent), { timeout: 15_000 }).toContain("live-in-both");

  // Both windows are told of a spawn, mount it and draw its wire; its typed first task is typed once.
  const typed: string = hive(["ctl", "spawn", "--agent", "droid", "--name", "twin-typed", "--prompt", 'echo once""-only', "--no-report", "--json"], { HIVEMIND_TILE: `hm:${parent}` }).json.tileId;
  for (const w of windows) await expect(w.locator(`.react-flow__node[data-id="${typed}"]`)).toHaveCount(1);
  for (const w of windows) await expect(w.locator(`[data-testid="rf__edge-spawn-${parent}-${typed}"]`)).toHaveCount(1);
  expect(hive(["ctl", "read", typed, "--timeout", "40000", "--json"]).json).toMatchObject({ text: "once-only" });
  await page.waitForTimeout(4_000); // a second copy would be typed as the agent settles again
  const output = hive(["ctl", "stream", typed, "--lines", "200", "--snapshot"]).stdout;
  expect(output.match(/once-only/g)?.length, output).toBe(1);
  expect(hive(["ctl", "rename", typed, "twin-renamed", "--json"]).json).toEqual({ ok: true, name: "twin-renamed" });
  for (const w of windows) await expect(w.locator(".hm-layers").getByText("twin-renamed", { exact: true })).toBeVisible();
  expect(hive(["ctl", "close", typed, "--json"]).code).toBe(0);
  for (const w of windows) await expect(w.locator(`.react-flow__node[data-id="${typed}"]`)).toHaveCount(0);

  // A view installed from the CLI shows up in every window, and goes from every window.
  const views = (w: Page) => w.evaluate(() => (window as unknown as { __hivemindViews?: { registered: string[] } }).__hivemindViews?.registered ?? []);
  expect(hive(["views", "install", path.join(__dirname, "fixtures", "views", "tiled"), "--json"]).code).toBe(0);
  for (const w of windows) await expect.poll(() => views(w)).toContain("tiled");
  expect(hive(["views", "remove", "tiled", "--json"]).code).toBe(0);
  for (const w of windows) await expect.poll(() => views(w)).not.toContain("tiled");

  // Closing a window lets go of nothing another still shows.
  await second.close();
  expect(hive(["ctl", "send", parent, 'echo after""-close']).code).toBe(0);
  await expect.poll(() => screenOf(page, parent), { timeout: 15_000 }).toContain("after-close");
  for (const tile of [child, parent]) hive(["ctl", "close", tile]);
  fs.rmSync(elsewhere, { recursive: true, force: true });
});

/** Where `w` shows `tile` on the canvas (world coordinates, whatever that window's camera). */
const placeIn = (w: Page, tile: string) => w.evaluate((id) => {
  const m = /translate\(([-\d.]+)px, ?([-\d.]+)px\)/.exec((document.querySelector(`.react-flow__node[data-id="${id}"]`) as HTMLElement | null)?.style.transform ?? "");
  return m ? { x: Math.round(Number(m[1])), y: Math.round(Number(m[2])) } : null;
}, tile);
const cameraOf = (w: Page) => w.evaluate(() => (document.querySelector(".react-flow__viewport") as HTMLElement | null)?.style.transform ?? "");
const notes = (w: Page) => w.locator(".react-flow__node-note [data-board-text]").allTextContents();
/** A point on `w`'s canvas with nothing on it, away from its chrome. */
const emptySpot = (w: Page) => w.evaluate(() => {
  const pane = document.querySelector(".react-flow__pane")!.getBoundingClientRect();
  for (let y = pane.bottom - 140; y > pane.top + 100; y -= 30) {
    for (let x = pane.left + 320; x < pane.right - 100; x += 30) {
      if (document.elementFromPoint(x, y)?.classList.contains("react-flow__pane")) return { x, y };
    }
  }
  return null;
});

/** Drag a tile by its header, with small steps: xyflow samples the pointer once a frame. Once the
 *  camera is still: a new tile is flown to, and a press on a moving tile does not drag it. */
async function dragTile(w: Page, tile: string, by: { x: number; y: number }): Promise<void> {
  let last = "";
  await expect.poll(async () => { const now = await cameraOf(w); const still = now === last; last = now; return still; }, { intervals: [250] }).toBe(true);
  const node = w.locator(`.react-flow__node[data-id="${tile}"]`);
  const hb = (await node.locator(".tile-drag-handle").first().boundingBox())!;
  const from = { x: hb.x + Math.min(40, hb.width - 10), y: hb.y + hb.height / 2 };
  await w.mouse.move(from.x, from.y);
  await w.mouse.down();
  for (let i = 1; i <= 30; i++) {
    await w.mouse.move(from.x + (by.x * i) / 30, from.y + (by.y * i) / 30);
    await w.waitForTimeout(20);
    // xyflow marks the node while it drags: a swallowed press fails here, not as a 0 px move.
    if (i === 4) await expect(node, "the drag never engaged").toHaveClass(/dragging/, { timeout: 2_000 });
  }
  await w.mouse.up();
}

test("two windows share where tiles and notes are, and each keeps its own camera, pins and undo", async () => {
  const [second] = await Promise.all([app.waitForEvent("window"), page.evaluate(() => window.hive.newWindow())]);
  await second.waitForSelector(".react-flow", { timeout: 15_000 });
  const windows = [page, second];
  const terminals = () => page.locator(".react-flow__node-terminal").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-id")!));
  const had = await terminals();
  await page.locator('[data-toolbar-action="terminal"]').click();
  await expect.poll(async () => (await terminals()).length).toBe(had.length + 1);
  const shell = (await terminals()).find((id) => !had.includes(id))!;
  for (const w of windows) await expect(w.locator(`.react-flow__node[data-id="${shell}"]`)).toHaveCount(1);

  // Moved in one window, it moves in the other.
  const was = await placeIn(second, shell);
  const olderPlaces = await second.evaluate((r) => window.hive.workspaceViewSync(r, "canvas"), repo);
  await dragTile(page, shell, { x: 160, y: 100 });
  await expect.poll(() => placeIn(page, shell)).not.toEqual(was);
  await expect.poll(() => placeIn(second, shell)).not.toEqual(was);
  const moved = await placeIn(page, shell);
  expect(await placeIn(second, shell)).toEqual(moved);
  // A save from before the move (a window saving what it read then) keeps the move: main writes
  // only what changed from that reading.
  await second.evaluate(([r, v]) => window.hive.workspaceSetViewSync(r, "canvas", v as never, v as never), [repo, olderPlaces] as const);
  await page.waitForTimeout(300);
  for (const w of windows) expect(await placeIn(w, shell)).toEqual(moved);

  // A camera is the window's: one panned leaves the other where it was, and stays out of the workspace.
  const theirs = await cameraOf(second);
  const mine = await cameraOf(page);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:zoom", { detail: "in" })));
  await expect.poll(() => cameraOf(page)).not.toBe(mine);
  await page.waitForTimeout(800); // its save has landed
  expect(await cameraOf(second)).toBe(theirs);
  expect(await page.evaluate((r) => (window.hive.workspaceViewSync(r, "canvas") as { data?: { viewport?: unknown } } | null)?.data?.viewport, repo)).toBeUndefined();

  // So is a pin: the tile floats on the screen of the window that pinned it.
  await page.locator(`.react-flow__node[data-id="${shell}"]`).getByRole("button", { name: "Pin tile" }).click();
  await expect(page.getByRole("button", { name: "Unpin tile" })).toHaveCount(1);
  await page.waitForTimeout(500); // its save has landed
  await expect(second.getByRole("button", { name: "Unpin tile" })).toHaveCount(0);
  expect(await page.evaluate((r) => window.hive.workspaceViewSync(r, "pins"), repo)).toBeNull();
  expect(await page.evaluate(([r, id]) => (window.hive.workspaceCoreSync(r) as { tiles: Array<{ id: string; pinned?: boolean }> }).tiles.find((t) => t.id === id)?.pinned, [repo, shell] as const)).toBeUndefined();
  await page.getByRole("button", { name: "Unpin tile" }).click();

  // A note written in either window shows in both; ⌘Z takes back the window's own, not the other's.
  const zoomOut = (w: Page) => w.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:zoom", { detail: "out" })));
  const note = async (w: Page, text: string) => {
    for (let i = 0; i < 3; i++) await zoomOut(w);
    await w.waitForTimeout(400);
    const at = (await emptySpot(w))!;
    await w.mouse.click(at.x, at.y); // the canvas has the keys, not the shell
    await w.keyboard.press("8");
    await w.keyboard.type(text);
    await w.keyboard.press("Escape");
    return at;
  };
  const olderBoard = await second.evaluate((r) => window.hive.workspaceObjectsSync(r), repo);
  await note(page, "from the first");
  for (const w of windows) await expect.poll(() => notes(w)).toEqual(["from the first"]);
  // So does a save of the board from before the note.
  await second.evaluate(([r, b]) => window.hive.workspaceSetObjectsSync(r, b as never, b as never), [repo, olderBoard] as const);
  await page.waitForTimeout(300);
  for (const w of windows) expect(await notes(w)).toEqual(["from the first"]);
  await note(second, "from the second");
  for (const w of windows) await expect.poll(async () => (await notes(w)).sort()).toEqual(["from the first", "from the second"]);
  const off = (await emptySpot(page))!;
  await page.mouse.click(off.x, off.y); // the canvas, off the note
  await page.keyboard.press("Control+z");
  for (const w of windows) await expect.poll(() => notes(w)).toEqual(["from the second"]);

  await second.close();
  hive(["ctl", "close", shell]);
});
