// Drawing on the canvas: an agent draws through `hive ctl`, a person with the tools in the tool
// island's second row, each landing on one board, which the store holds and a picture shows. Each test
// launches on a fresh repo and profile, and what it asserts is read from the canvas and the store.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cli = path.resolve("../cli/src/index.ts");
const SHOTS = process.env.DRAW_SHOTS;

let root: string;
let app: ElectronApplication | undefined;
let page: Page;
let repo: string;
let env: Record<string, string>;

type Stored = Array<{ id: string; kind: string; form?: string; text?: string; x?: number; y?: number; w?: number; h?: number; drawing?: string; color?: string; from?: { id: string }; to?: { id: string }; points?: number[][]; label?: string; frame?: string }>;

const stored = () => page.evaluate((r) => window.hive.workspaceObjectsSync(r), repo) as Promise<Stored>;
const shapes = async () => (await stored()).filter((o) => o.kind === "shape");
const shot = async (name: string) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };

test.beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-draw-"));
  repo = path.join(root, "api");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  const config = path.join(root, "config");
  env = {
    ...process.env, XDG_CONFIG_HOME: config, HIVE_SETTINGS: path.join(config, "settings.json"), HIVEMIND_APP_DATA: path.join(config, "hivemind-dev"),
    HIVEMIND_SHELL_ENV: "0", HIVEMIND_HIVE_NET: path.join(root, "none"), HCP_TOKEN: "", HIVEMIND_TILE: "", HIVE_DRIVE_SOCK: "", HIVE_HCP_SOCK: "",
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.resolve("out/main/index.js"), "--no-sandbox"], cwd: repo, env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
  await page.waitForTimeout(500);
});

test.afterEach(async () => {
  await app?.close();
  app = undefined;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function hive(args: string[], input?: string): { code: number | null; json: Record<string, any> } {
  const r = spawnSync("bun", [cli, ...args, "--json"], { env, encoding: "utf8", cwd: repo, input });
  const out = r.stdout.trim() || r.stderr.trim();
  let json: Record<string, any> = {};
  try { json = JSON.parse(out) as Record<string, any>; } catch { json = { raw: out }; }
  return { code: r.status, json };
}

const LOGIN = { title: "Login flow", boxes: [{ id: "web", text: "Web app" }, { id: "api", text: "API", color: "blue" }, { id: "db", text: "Database", form: "ellipse" }], links: [["web", "api", "login"], ["api", "db"]] };

test("hive ctl draw puts boxes and links on the canvas, placed for the caller, and board, erase and replace act on them", async () => {
  test.setTimeout(120_000);
  const drawn = hive(["ctl", "draw"], JSON.stringify(LOGIN));
  expect(drawn.code).toBe(0);
  expect(Object.keys(drawn.json.boxes)).toEqual(["web", "api", "db"]);
  expect(drawn.json.overlaps).toEqual([]);

  // Each box a node on the canvas with its words, and the links arrows that end on them.
  const node = (id: string) => page.locator(`.react-flow__node-shape[data-id="${id}"]`);
  await expect(node(drawn.json.boxes.api)).toContainText("API", { timeout: 10_000 });
  await expect(page.locator("[data-board-arrow]")).toHaveCount(2);
  const onBoard = await shapes();
  expect(onBoard.map((s) => s.text).sort()).toEqual(["API", "Database", "Login flow", "Web app"]);
  const [web, api] = [onBoard.find((s) => s.text === "Web app")!, onBoard.find((s) => s.text === "API")!];
  expect(api.x!).toBeGreaterThan(web.x! + web.w!);
  // Written by a program, not this window: said, with a way to it.
  await expect(page.getByText(/A program drew "Login flow"/)).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:shortcut", { detail: "fit-all" })));
  await page.waitForTimeout(700);
  await shot("agent-drawing");

  // Read back: an overview, one drawing in full, and pictures to look at.
  const read = hive(["ctl", "board"]);
  expect(read.json.drawings).toEqual([expect.objectContaining({ id: drawn.json.drawing, title: "Login flow", objects: 6 })]);
  expect(read.json.objects.find((o: { text?: string }) => o.text === "API")).toMatchObject({ kind: "shape", form: "rect" });
  expect(hive(["ctl", "board", "--drawing", drawn.json.drawing]).json.full).toHaveLength(6);
  const svg = path.join(root, "board.svg");
  expect(hive(["ctl", "board", "--svg", svg]).code).toBe(0);
  expect(fs.readFileSync(svg, "utf8")).toContain("Database");
  const png = path.join(root, "board.png");
  const pictured = hive(["ctl", "board", "--png", png]);
  expect(pictured.code).toBe(0);
  expect(fs.readFileSync(png).subarray(1, 4).toString()).toBe("PNG");
  if (SHOTS) fs.copyFileSync(png, path.join(SHOTS, "agent-drawing-picture.png"));

  // Updated with only new boxes: the same drawing, drawn where it is now.
  const was = hive(["ctl", "board", "--drawing", drawn.json.drawing]).json.full.filter((o: { kind: string }) => o.kind === "shape");
  const corner = { x: Math.min(...was.map((o: { x: number }) => o.x)), y: Math.min(...was.map((o: { y: number }) => o.y)) };
  const again = hive(["ctl", "draw", "--update", drawn.json.drawing], JSON.stringify({ boxes: [{ id: "only", text: "Only this" }] }));
  expect(again.code).toBe(0);
  expect(again.json.drawing).toBe(drawn.json.drawing);
  expect({ x: again.json.box.x, y: again.json.box.y }).toEqual(corner);
  await expect(node(again.json.boxes.only)).toContainText("Only this", { timeout: 10_000 });
  expect((await shapes()).map((s) => s.text)).toEqual(["Only this"]);
  await expect(page.locator("[data-board-arrow]")).toHaveCount(0);

  // What may not be drawn says why, and exits as a usage error.
  const bad = hive(["ctl", "draw"], JSON.stringify({ boxes: [{ id: "a", text: "A" }], links: [["a", "nowhere"]] }));
  expect(bad.code).not.toBe(0);
  expect(JSON.stringify(bad.json)).toContain("nowhere");

  const erased = hive(["ctl", "erase", "--drawing", again.json.drawing]);
  expect(erased.json.erased).toHaveLength(1);
  await expect(page.locator(".react-flow__node-shape")).toHaveCount(0);
});

async function dragOn(from: { x: number; y: number }, to: { x: number; y: number }, steps = 12): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    await page.waitForTimeout(12);
  }
  await page.mouse.up();
}

const tool = (name: string) => page.locator(`[data-draw-tool="${name}"]`);
/** The tools are a second row of the tool island, out while Draw is pressed; a fresh profile starts with it off. */
async function drawOn() {
  const draw = page.locator("[data-host-island] [data-draw-toggle]");
  if ((await draw.getAttribute("aria-pressed")) !== "true") await draw.click();
  await expect(page.locator('[data-host-island] [data-draw-tools]')).toBeVisible();
}

test("the tools draw shapes a person can select, move, resize, write in, erase and undo", async () => {
  test.setTimeout(120_000);
  const pane = (await page.locator(".react-flow").boundingBox())!;
  const at = (x: number, y: number) => ({ x: pane.x + x, y: pane.y + y });

  // Draw off: no row, and Select; on: the row under the island's first.
  const draw = page.locator("[data-draw-toggle]");
  await expect(draw).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("[data-draw-tools]")).toBeHidden();
  await drawOn();
  await tool("pen").click();
  await draw.click();
  await expect(draw).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("[data-draw-tools]")).toBeHidden();
  await page.keyboard.press("x");
  await expect(draw).toHaveAttribute("aria-pressed", "true");
  await expect(tool("select")).toHaveAttribute("aria-pressed", "true");

  // A rectangle, dragged out; back to Select with it selected. Its options sit just below the island.
  await tool("rect").click();
  const island = (await page.locator("[data-tool-island]").boundingBox())!;
  const options = (await page.locator("[data-draw-options]").boundingBox())!;
  expect(options.y).toBeGreaterThan(island.y + island.height);
  await page.locator('[data-draw-ink="blue"]').click();
  await dragOn(at(120, 140), at(320, 260));
  await expect.poll(async () => (await shapes()).length, { timeout: 5000 }).toBe(1);
  await expect(tool("select")).toHaveAttribute("aria-pressed", "true");
  const [rect] = await shapes();
  expect(rect).toMatchObject({ form: "rect", color: "blue" });
  expect(rect!.w).toBeGreaterThan(150);

  // Written in by a double-click on its edge.
  await page.mouse.dblclick(at(120, 200).x, at(120, 200).y);
  await page.keyboard.type("Login");
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await shapes())[0]?.text, { timeout: 5000 }).toBe("Login");
  await page.mouse.click(at(600, 500).x, at(600, 500).y);

  // The pen, chosen by its key: a stroke is one shape, its points kept and thinned.
  await page.keyboard.press("p");
  await expect(tool("pen")).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(at(400, 140).x, at(400, 140).y);
  await page.mouse.down();
  for (let i = 0; i <= 60; i++) { await page.mouse.move(at(400 + i * 3, 140 + Math.sin(i / 5) * 40).x, at(400 + i * 3, 140 + Math.sin(i / 5) * 40).y); await page.waitForTimeout(4); }
  await page.mouse.up();
  await expect.poll(async () => (await shapes()).length, { timeout: 5000 }).toBe(2);
  const pen = (await shapes()).find((s) => s.form === "pen")!;
  expect(pen.points!.length).toBeGreaterThan(5);
  expect(pen.points!.length).toBeLessThan(60);

  // An arrow from one shape to another ends on them both, and follows them.
  await page.keyboard.press("o");
  await dragOn(at(120, 360), at(300, 460));
  await expect.poll(async () => (await shapes()).length, { timeout: 5000 }).toBe(3);
  await page.mouse.click(at(650, 500).x, at(650, 500).y);
  await page.keyboard.press("a");
  await dragOn(at(120, 200), at(210, 361));
  await expect.poll(async () => (await stored()).filter((o) => o.kind === "arrow").length, { timeout: 5000 }).toBe(1);
  await expect(page.locator("[data-board-arrow]")).toHaveCount(1);
  await shot("hand-drawn");

  // Undo takes back what was drawn; redo brings it again.
  await page.mouse.click(at(650, 500).x, at(650, 500).y);
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await stored()).filter((o) => o.kind === "arrow").length, { timeout: 5000 }).toBe(0);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(async () => (await stored()).filter((o) => o.kind === "arrow").length, { timeout: 5000 }).toBe(1);

  // Moved: selected by its edge and dragged, it lands where it was let go.
  const before = (await shapes()).find((s) => s.form === "rect")!;
  await page.mouse.click(at(120, 200).x, at(120, 200).y);
  await dragOn(at(120, 200), at(150, 230));
  await expect.poll(async () => (await shapes()).find((s) => s.form === "rect")!.x, { timeout: 5000 }).toBeCloseTo(before.x! + 30, -1);

  // One not selected moves with the press that picks it.
  const oval = (await shapes()).find((s) => s.form === "ellipse")!;
  await page.mouse.click(at(650, 500).x, at(650, 500).y);
  await dragOn(at(120, 410), at(140, 440));
  await expect.poll(async () => (await shapes()).find((s) => s.form === "ellipse")!.x, { timeout: 5000 }).toBeCloseTo(oval.x! + 20, -1);

  // A drag across the empty canvas takes in several, and they move together.
  const [a, b] = [(await shapes()).find((s) => s.form === "rect")!, (await shapes()).find((s) => s.form === "ellipse")!];
  await page.mouse.click(at(700, 560).x, at(700, 560).y);
  await dragOn(at(60, 90), at(360, 500));
  await expect(page.locator(".react-flow__node-shape .hm-board-selected")).toHaveCount(2);
  await page.keyboard.press("Delete");
  await expect.poll(async () => (await shapes()).length, { timeout: 5000 }).toBe(1);
  expect((await shapes()).some((s) => s.id === a.id || s.id === b.id)).toBe(false);
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await shapes()).length, { timeout: 5000 }).toBe(3);

  // The eraser takes what it passes over, an arrow among them, and leaves the rest.
  await tool("eraser").click();
  const arrowAt = await page.locator("[data-board-arrow] [data-arrow-hit]").evaluate((p: SVGPathElement) => {
    const mid = p.getPointAtLength(p.getTotalLength() / 2);
    const m = p.getScreenCTM()!;
    return { x: m.a * mid.x + m.e, y: m.d * mid.y + m.f };
  });
  await page.mouse.click(arrowAt.x, arrowAt.y);
  await expect.poll(async () => (await stored()).filter((o) => o.kind === "arrow").length, { timeout: 5000 }).toBe(0);
  await page.mouse.move(at(400, 100).x, at(400, 100).y);
  await page.mouse.down();
  for (let i = 0; i <= 20; i++) { await page.mouse.move(at(440, 100 + i * 5).x, at(440, 100 + i * 5).y); await page.waitForTimeout(10); }
  await page.mouse.up();
  await expect.poll(async () => (await shapes()).some((s) => s.form === "pen"), { timeout: 5000 }).toBe(false);
  await page.keyboard.press("Escape");
  await expect(tool("select")).toHaveAttribute("aria-pressed", "true");
  expect((await shapes()).length).toBe(2);

  // A quick swipe takes the thin lines it crosses between two moves of the pointer, and one undo
  // brings back all it took.
  for (const y of [300, 340]) {
    await page.keyboard.press("l");
    await dragOn(at(500, y), at(700, y));
  }
  await expect.poll(async () => (await shapes()).length, { timeout: 5000 }).toBe(4);
  await tool("eraser").click();
  await page.mouse.move(at(600, 270).x, at(600, 270).y);
  await page.mouse.down();
  await page.mouse.move(at(600, 370).x, at(600, 370).y, { steps: 1 });
  await page.mouse.up();
  await expect.poll(async () => (await shapes()).length, { timeout: 5000 }).toBe(2);
  await page.keyboard.press("Escape");
  await page.mouse.click(at(650, 500).x, at(650, 500).y);
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await shapes()).length, { timeout: 5000 }).toBe(4);
});

test("a stroke can start over a terminal and leaves the terminal working, and text with nothing written is not kept", async () => {
  test.setTimeout(120_000);
  await page.keyboard.press("1");
  const term = page.locator(".react-flow__node-terminal").first();
  await expect(term).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(800);
  const box = (await term.boundingBox())!;
  await drawOn();
  await tool("pen").click();
  // While a tool is on, the pointer is the tool's: a wheel here moves the canvas, not the terminal.
  expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x!, y!)?.closest(".react-flow__node"), [box.x + 100, box.y + 120])).toBe(false);
  await dragOn({ x: box.x + 100, y: box.y + 120 }, { x: box.x + 300, y: box.y + 220 });
  await expect.poll(async () => (await shapes()).length, { timeout: 5000 }).toBe(1);
  await tool("select").click();
  // Inside the stroke's box but off its line, a click is still the terminal's.
  const under = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest(".react-flow__node")?.getAttribute("class"), [box.x + 280, box.y + 135]);
  expect(under).toContain("react-flow__node-terminal");
  await page.mouse.click(box.x + 280, box.y + 135);
  await expect(term.locator(".tile-locked")).toHaveCount(0);
  // On its line, the click is the stroke's: painted until then, it is shown with its handles.
  await expect(page.locator(".react-flow__node-shape")).toHaveCount(0);
  await page.mouse.click(box.x + 200, box.y + 170);
  await expect(page.locator(".react-flow__node-shape .hm-board-selected")).toHaveCount(1);
  await shot("over-terminal");

  await tool("text").click();
  const pane = (await page.locator(".react-flow").boundingBox())!;
  await page.mouse.click(pane.x + 40, pane.y + pane.height - 120);
  await expect(page.getByLabel("shape text")).toBeFocused({ timeout: 5000 });
  const texts = page.locator('.react-flow__node-shape:has([data-shape="text"])');
  await expect(texts).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(texts).toHaveCount(0);
  await page.waitForTimeout(800);
  expect((await shapes()).map((s) => s.form)).toEqual(["pen"]);
});

test("a note pinned on a shape is listed for agents, follows the shape, and shows their reply", async () => {
  test.setTimeout(120_000);
  const drawn = hive(["ctl", "draw"], JSON.stringify({ boxes: [{ id: "api", text: "API" }] }));
  const id = drawn.json.boxes.api as string;
  const node = page.locator(`.react-flow__node-shape[data-id="${id}"]`);
  await expect(node).toContainText("API", { timeout: 10_000 });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:shortcut", { detail: "fit-all" })));
  await page.waitForTimeout(700);

  await drawOn();
  await tool("note").click();
  const box = (await node.boundingBox())!;
  await page.mouse.click(box.x + box.width - 6, box.y + 6);
  await page.getByLabel("note", { exact: true }).fill("Add rate limits here");
  await page.locator("[data-note-save]").click();
  await expect(page.locator("[data-note-pin]")).toHaveCount(1, { timeout: 5000 });

  const listed = hive(["ctl", "notes", "list"]);
  expect(listed.json.comments).toEqual([expect.objectContaining({ body: "Add rate limits here", board: expect.objectContaining({ on: id, what: "API" }) })]);
  const noteId = listed.json.comments[0].id as string;

  // An agent can point too, and answer.
  const pinned = hive(["ctl", "pin", "Done here?", "--on", id, "--at", "0,0"]);
  expect(pinned.code).toBe(0);
  await expect(page.locator("[data-note-pin]")).toHaveCount(2, { timeout: 5000 });
  expect(spawnSync("bun", [cli, "review", "reply", noteId, "Added them"], { env, encoding: "utf8", cwd: repo }).status).toBe(0);
  await page.locator(`[data-board-note="${noteId}"] [data-note-pin]`).click();
  await expect(page.locator("[data-note-reply]")).toContainText("Added them", { timeout: 10_000 });
  await shot("note-open");

  // Marked done from the card, it leaves the board and stays in the list.
  await page.locator("[data-note-card]").getByRole("button", { name: "Done" }).click();
  await page.locator(`[data-board-note="${noteId}"] [aria-label="close note"]`).click();
  await expect(page.locator(`[data-board-note="${noteId}"]`)).toHaveCount(0, { timeout: 5000 });
  expect(hive(["ctl", "notes", "list", "--status", "all"]).json.comments).toHaveLength(2);
});
