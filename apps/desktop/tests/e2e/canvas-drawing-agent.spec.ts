// An agent drawing as itself: `hive ctl` from its own tile's environment, so with its token, in a
// real app. Its drawing lands beside it in its frame and says so; it moves as one; and a note the
// person pins on it reaches that agent, whose answer shows on the pin.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { person } from "./helpers/multiplayer";
import { chooserAgent } from "./helpers/chooser";
import { stopDaemons } from "./helpers/daemons";

const cli = path.resolve("../cli/src/index.ts");
const SHOTS = process.env.DRAW_SHOTS;

let root: string;
const apps: ElectronApplication[] = [];
test.beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync("/tmp/hm-draw-agent-")); });
test.afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  stopDaemons(root);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** The environment of the process running in `tile`: what its agent runs `hive ctl` with. */
function environOf(tile: string): Record<string, string> {
  for (const pid of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    let raw: string;
    try { raw = fs.readFileSync(`/proc/${pid}/environ`, "latin1"); } catch { continue; }
    if (!raw.includes(`HIVEMIND_TILE=hm:${tile}\0`)) continue;
    return Object.fromEntries(raw.split("\0").filter(Boolean).map((kv) => { const at = kv.indexOf("="); return [kv.slice(0, at), kv.slice(at + 1)]; }));
  }
  throw new Error(`no process runs in ${tile}`);
}

async function agentInFrame(): Promise<{ page: Page; repo: string; tile: string; as: (args: string[], input?: string) => { code: number | null; json: Record<string, any>; err: string }; heard: () => string }> {
  const repo = path.join(root, "api");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const trace = path.join(root, "trace");
  const page = await person(root, "desktop", repo, apps, { ...chooserAgent(root), CHOOSER_TRACE: trace, HIVEMIND_SHELL_ENV: "0", HOME: home });
  await page.evaluate(() => window.hive.settingsSet("agents.defaultAgent", "chooser"));
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:shortcut", { detail: "agent" })));
  const terminal = page.locator(".react-flow__node-terminal");
  await expect(terminal).toHaveCount(1, { timeout: 20_000 });
  const tile = (await terminal.getAttribute("data-id"))!;
  await expect.poll(async () => (await page.evaluate((r) => window.hive.agentList(r), repo)).agents.find((a) => a.tile === tile)?.state, { timeout: 30_000 }).toBe("idle");
  const env = environOf(tile);
  const as = (args: string[], input?: string) => {
    const r = spawnSync("bun", [cli, ...args, "--json"], { env, encoding: "utf8", cwd: repo, input });
    let json: Record<string, any> = {};
    try { json = JSON.parse(r.stdout.trim() || r.stderr.trim()) as Record<string, any>; } catch { /* said in err */ }
    return { code: r.status, json, err: r.stderr };
  };
  return { page, repo, tile, as, heard: () => (fs.existsSync(trace) ? fs.readFileSync(trace, "utf8") : "") };
}

const FLOW = { title: "How it fits", boxes: [{ id: "web", text: "Web app" }, { id: "api", text: "API", color: "blue" }, { id: "db", text: "Database", form: "ellipse", color: "green" }], links: [["web", "api", "calls"], ["api", "db"], ["api", "me", "I work here"]] };

test("an agent draws as itself: beside its tile, in its frame, said to the person, and it moves and goes as one", async () => {
  test.setTimeout(180_000);
  const { page, repo, tile, as } = await agentInFrame();
  const frame = (await page.evaluate((r) => window.hive.workspaceCoreSync(r), repo) as { frameOf?: Record<string, string> } | null)?.frameOf?.[tile];
  const drawn = as(["ctl", "draw"], JSON.stringify(FLOW));
  expect(drawn.err).toBe("");
  expect(drawn.code).toBe(0);
  expect(drawn.json.overlaps).toEqual([]);
  expect(drawn.json.frame).toBe(frame);

  const stored = () => page.evaluate((r) => window.hive.workspaceObjectsSync(r), repo) as Promise<Array<{ id: string; kind: string; by?: string; x?: number; y?: number; frame?: string; drawing?: string }>>;
  const shapes = async () => (await stored()).filter((o) => o.kind === "shape");
  await expect(page.locator(".react-flow__node-shape")).toHaveCount(4, { timeout: 10_000 });
  await expect(page.locator("[data-board-arrow]")).toHaveCount(3);
  expect((await shapes()).every((s) => s.by === tile && s.frame === frame)).toBe(true);

  // Said once, with a way to it.
  await expect(page.getByText(/drew "How it fits"/)).toBeVisible();
  await page.getByRole("button", { name: "Show", exact: true }).dispatchEvent("click");
  const api = page.locator(`.react-flow__node-shape[data-id="${drawn.json.boxes.api}"]`);
  await expect(api).toBeInViewport({ timeout: 5000 });
  await page.waitForTimeout(600);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "agent-in-frame.png") });

  // The frame grew round it: nothing of it sticks out.
  if (frame) {
    const [f, d] = [(await page.locator(`.react-flow__node-frame[data-id="${frame}"]`).boundingBox())!, (await api.boundingBox())!];
    expect(d.x + d.width).toBeLessThanOrEqual(f.x + f.width);
    expect(d.y + d.height).toBeLessThanOrEqual(f.y + f.height);
  }

  // A click on one selects all of it, and a drag moves all of it the same.
  const box = (await api.boundingBox())!;
  const start = await shapes();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator(".react-flow__node-shape .hm-board-selected")).toHaveCount(4);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 15; i++) { await page.mouse.move(box.x + box.width / 2 + i * 4, box.y + box.height / 2 + i * 6); await page.waitForTimeout(12); }
  await page.mouse.up();
  await expect.poll(async () => { const now = await shapes(); return now.every((s) => s.x !== start.find((o) => o.id === s.id)!.x); }, { timeout: 5000 }).toBe(true);
  const after = await shapes();
  const moved = after.map((s) => { const was = start.find((o) => o.id === s.id)!; return [Math.round(s.x! - was.x!), Math.round(s.y! - was.y!)]; });
  expect(new Set(moved.map((m) => m.join())).size).toBe(1);
  expect(moved[0]![0]).toBeGreaterThan(0);

  // Reading what it drew, and looking at it, as the agent does.
  const png = path.join(root, "drawn.png");
  expect(as(["ctl", "board", "--drawing", drawn.json.drawing, "--png", png]).code).toBe(0);
  expect(fs.statSync(png).size).toBeGreaterThan(500);
  if (SHOTS) fs.copyFileSync(png, path.join(SHOTS, "agent-in-frame-picture.png"));
  expect(as(["ctl", "board", "--show", drawn.json.drawing]).code).toBe(0);

  // Selected, Delete takes all of it, the arrow to the agent's tile with it; undo brings it back.
  await page.keyboard.press("Delete");
  await expect(page.locator(".react-flow__node-shape")).toHaveCount(0);
  await expect(page.locator("[data-board-arrow]")).toHaveCount(0);
  await page.keyboard.press("Control+z");
  await expect(page.locator(".react-flow__node-shape")).toHaveCount(4, { timeout: 5000 });

  // Copied whole, it is a drawing of its own, and this window's own copy is not announced.
  const toasts = await page.getByText(/ drew /).count();
  await api.click({ position: { x: 10, y: 20 } });
  await expect(page.locator(".react-flow__node-shape .hm-board-selected")).toHaveCount(4);
  await page.keyboard.press("Control+d");
  await expect(page.locator(".react-flow__node-shape")).toHaveCount(8, { timeout: 5000 });
  await expect(page.locator("[data-board-arrow]")).toHaveCount(5);
  await page.waitForTimeout(500);
  expect(await page.getByText(/ drew /).count()).toBeLessThanOrEqual(toasts);

  // It erases its own.
  expect(as(["ctl", "erase", "--mine"]).code).toBe(0);
  await expect(page.locator(".react-flow__node-shape")).toHaveCount(0);
});

test("the person pins a note on an agent's drawing and sends it there; the agent answers on the pin, and points back", async () => {
  test.setTimeout(180_000);
  const { page, as, heard } = await agentInFrame();
  const drawn = as(["ctl", "draw"], JSON.stringify(FLOW));
  await page.getByRole("button", { name: "Show", exact: true }).dispatchEvent("click");
  const api = page.locator(`.react-flow__node-shape[data-id="${drawn.json.boxes.api}"]`);
  await expect(api).toBeInViewport({ timeout: 5000 });
  await page.waitForTimeout(600);

  await page.locator("[data-host-island] [data-draw-toggle]").click();
  await page.locator('[data-draw-tool="note"]').click();
  const box = (await api.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.getByLabel("note", { exact: true }).fill("Add rate limits here");
  await page.locator("[data-note-save]").click();

  await expect.poll(heard, { timeout: 20_000 }).toContain("Add rate limits here");
  expect(heard()).toContain("1 note on the board to address");
  const listed = as(["ctl", "notes", "list"]);
  const id = listed.json.comments[0].id as string;
  expect(listed.json.comments[0].board).toMatchObject({ on: drawn.json.boxes.api, what: "API" });

  expect(as(["ctl", "notes", "reply", id, "Added them"]).code).toBe(0);
  const pinned = as(["ctl", "pin", "Is this the right place?", "--on", drawn.json.boxes.db]);
  expect(pinned.json.author).not.toBe("you");
  await expect(page.locator("[data-note-pin]")).toHaveCount(2, { timeout: 10_000 });
  await page.locator(`[data-board-note="${id}"] [data-note-pin]`).click();
  await expect(page.locator("[data-note-reply]")).toContainText("Added them", { timeout: 10_000 });
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "agent-note.png") });

  // A pin follows what it is on.
  const placed = page.locator(`[data-board-note="${id}"]`);
  const yOf = () => placed.evaluate((el: HTMLElement) => Number(/translate\([^,]+,\s*([-\d.]+)px/.exec(el.style.transform)?.[1]));
  const before = await yOf();
  await page.locator('[aria-label="close note"]').click();
  const now = (await api.boundingBox())!;
  const grab = { x: now.x + 10, y: now.y + now.height / 2 };
  await page.mouse.click(grab.x, grab.y);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  for (let i = 1; i <= 15; i++) { await page.mouse.move(grab.x, grab.y + i * 8); await page.waitForTimeout(12); }
  await page.mouse.up();
  await expect.poll(async () => (await yOf()) - before, { timeout: 5000 }).toBeGreaterThan(60);
});
