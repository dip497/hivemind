// Agent wiring on the canvas: a pipe (hive_connect) is an animated line from the agent whose
// output feeds another to that agent, and a spawn wire a dashed line from an agent to the one it
// spawned. Both reach the window from main as workspace API events (`link.pipe`, `link.spawn`),
// which is where this starts them, between two shells on a fresh repo and profile.
import { test, expect, _electron as electron } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dirs: string[] = [];
test.afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function scratch(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** The app on a fresh repo and profile, with two shells and a way to tell the window of links. */
async function twoShells() {
  const repo = scratch("hm-links-repo-");
  execSync("git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init", { cwd: repo });
  const ud = scratch("hm-links-ud-");
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(ud, "config") };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox", `--user-data-dir=${ud}`], cwd: repo, env });
  const page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 30_000 });

  // From Add: once a terminal has focus, the `1` key is the shell's.
  const terminals = page.locator(".react-flow__node-terminal");
  const newTerminal = async () => {
    await page.locator('[data-toolbar-action="board"]').click();
    await page.locator('[data-board-choice="tile:shell"]').click();
  };
  await newTerminal();
  await expect(terminals).toHaveCount(1);
  await newTerminal();
  await expect(terminals).toHaveCount(2);
  const [a, b] = await terminals.evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-id")!));
  const send = (event: string, change: object) =>
    app.evaluate(({ BrowserWindow }, [e, c]) => BrowserWindow.getAllWindows()[0]!.webContents.send("workspace:event", { event: e, params: [c] }), [event, change] as const);
  return { app, page, a, b, send };
}

test("a pipe and a spawn wire are drawn from one tile to the other, and go when they end", async () => {
  const { app, page, a, b, send } = await twoShells();
  await send("link.spawn", { parent: a, child: b, connected: true });
  await send("link.pipe", { src: a, dst: b, connected: true });

  // Each line starts on the edge of one tile and ends on the edge of the other.
  const ends = (selector: string) => page.evaluate(({ selector, a, b }) => {
    const path = document.querySelector<SVGPathElement>(`${selector} path`);
    if (!path) return null;
    const m = path.getScreenCTM()!;
    const screen = (p: DOMPoint) => ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f });
    const onBorder = (id: string, p: { x: number; y: number }) => {
      const r = document.querySelector(`.react-flow__node[data-id="${id}"]`)!.getBoundingClientRect();
      const inside = p.x >= r.left - 2 && p.x <= r.right + 2 && p.y >= r.top - 2 && p.y <= r.bottom + 2;
      const edge = Math.min(Math.abs(p.x - r.left), Math.abs(p.x - r.right), Math.abs(p.y - r.top), Math.abs(p.y - r.bottom));
      return inside && edge < 2;
    };
    const start = screen(path.getPointAtLength(0));
    const end = screen(path.getPointAtLength(path.getTotalLength()));
    return { fromA: onBorder(a, start), toB: onBorder(b, end) };
  }, { selector, a, b });
  await expect.poll(() => ends(".react-flow__edge-spawn")).toEqual({ fromA: true, toB: true });
  await expect.poll(() => ends(".react-flow__edge-dataflow")).toEqual({ fromA: true, toB: true });

  await send("link.pipe", { src: a, dst: b, connected: false });
  await expect(page.locator(".react-flow__edge-dataflow")).toHaveCount(0);
  await expect(page.locator(".react-flow__edge-spawn")).toHaveCount(1);
  await send("link.spawn", { child: b, connected: false });
  await expect(page.locator(".react-flow__edge-spawn")).toHaveCount(0);
  await app.close();
});

test("a pipe's dot travels from one tile to the other without the page painting anything", async () => {
  const { app, page, a, b, send } = await twoShells();
  await send("link.pipe", { src: a, dst: b, connected: true });
  const dot = page.locator("[data-pipe-dot]");
  await expect(dot).toHaveCount(1);

  // It moves, and stays between the two tiles.
  const at = () => dot.evaluate((d) => { const r = d.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const box = async (id: string) => (await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox())!;
  const [ra, rb] = [await box(a), await box(b)];
  const seen = [];
  for (let i = 0; i < 6; i++) { seen.push(await at()); await page.waitForTimeout(150); }
  expect(new Set(seen.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`)).size).toBeGreaterThan(3);
  const left = Math.min(ra.x, rb.x) - 2, right = Math.max(ra.x + ra.width, rb.x + rb.width) + 2;
  for (const p of seen) expect(p.x >= left && p.x <= right, JSON.stringify({ p, ra, rb })).toBe(true);

  // Over two quiet seconds no layer is painted again: the dot is the compositor's to move.
  const cdp = await page.context().newCDPSession(page);
  let layers: { paintCount?: number }[] = [];
  cdp.on("LayerTree.layerTreeDidChange", (e) => { if (e.layers) layers = e.layers; });
  await cdp.send("LayerTree.enable");
  await page.waitForTimeout(1_000);
  const paints = () => layers.reduce((n, l) => n + (l.paintCount ?? 0), 0);
  const before = paints();
  await page.waitForTimeout(2_000);
  expect(paints() - before).toBeLessThanOrEqual(4);
  await app.close();
});
