// The board on the canvas (docs/design/multiplayer-2026-09-28.md, R15): sticky notes, checklists,
// text and arrows, each launch on a fresh repo and profile. What the store holds is read through
// the same bridge the window saves by, and what the canvas shows through its nodes.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Stored = Array<{ id: string; kind: string; text?: string; label?: string; color?: string; frame?: string; x?: number; y?: number; w?: number; h?: number;
  items?: Array<{ text: string; done: boolean }>; from?: { id: string }; to?: { id: string } }>;

const dirs: string[] = [];
test.afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function scratch(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

async function launch(repo: string, ud: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env = { ...process.env, HIVEMIND_PTY_DAEMON: "0", XDG_CONFIG_HOME: path.join(ud, "config") };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox", `--user-data-dir=${ud}`], cwd: repo, env });
  const page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
  await page.waitForTimeout(400);
  return { app, page };
}

async function open() {
  const repo = scratch("hm-board-repo-");
  execSync("git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init", { cwd: repo });
  const ud = scratch("hm-board-ud-");
  const { app, page } = await launch(repo, ud);
  const stored = () => page.evaluate((r) => window.hive.workspaceObjectsSync(r), repo) as Promise<Stored>;
  return { app, page, repo, ud, stored };
}

/** Add a box with its key, the pointer at (x, y) on the canvas, and write `text` in it. */
async function addBox(page: Page, key: "8" | "9", x: number, y: number, text: string): Promise<void> {
  await page.mouse.move(x, y);
  await page.keyboard.press(key);
  await page.keyboard.type(text);
  await page.keyboard.press("Escape"); // done writing; still selected
}

/** Drag with small steps: xyflow samples the pointer once a frame. */
async function drag(page: Page, from: { x: number; y: number }, by: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 30; i++) {
    await page.mouse.move(from.x + (by.x * i) / 30, from.y + (by.y * i) / 30);
    await page.waitForTimeout(15);
  }
  await page.mouse.up();
}

/** A new frame is flown to (400ms): wait until it sits in the middle of the canvas. */
async function frameInView(page: Page) {
  const at = () => page.evaluate(() => {
    const pane = document.querySelector(".react-flow")!.getBoundingClientRect();
    const r = document.querySelector(".react-flow__node-frame")!.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height,
      off: Math.hypot(r.x + r.width / 2 - (pane.x + pane.width / 2), r.y + r.height / 2 - (pane.y + pane.height / 2)) };
  });
  await expect.poll(async () => (await at()).off < 2).toBe(true);
  return at();
}

/** What the store holds once the window has nothing left to save: the same on two reads a save apart. */
async function settled(stored: () => Promise<Stored>): Promise<Stored> {
  let last = JSON.stringify(await stored());
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const now = JSON.stringify(await stored());
    if (now === last) break;
    last = now;
  }
  return JSON.parse(last) as Stored;
}

test("typing in a new note or checklist types into it: no tool, frame or view key fires", async () => {
  const { app, page, stored } = await open();
  await addBox(page, "8", 400, 300, "1 2 3 4 5 6 7 8 9 . e");
  await addBox(page, "9", 900, 300, "Plan 16");
  // The checklist was left while its title was written: write in it again, and add items.
  await page.locator(".react-flow__node-checklist [data-board-text]").dblclick();
  await page.keyboard.press("Enter");
  await page.keyboard.type("ship 7");
  await page.keyboard.press("Escape");

  await expect.poll(async () => (await stored()).map((o) => [o.kind, o.text, o.items?.map((i) => i.text)]).sort())
    .toEqual([["checklist", "Plan 16", ["ship 7"]], ["note", "1 2 3 4 5 6 7 8 9 . e", undefined]]);
  expect(await page.locator(".react-flow__node").count()).toBe(2);
  await expect(page.locator("[data-active-view]")).toHaveAttribute("data-active-view", "canvas");
  await app.close();
});

test("a note is written, resized, recoloured, duplicated and deleted; a checklist's items are ticked and reordered", async () => {
  const { app, page, stored } = await open();
  await addBox(page, "8", 400, 300, "resize me");
  const note = page.locator(".react-flow__node-note");
  await expect.poll(async () => (await stored()).map((o) => o.text)).toEqual(["resize me"]);
  const before = (await stored())[0]!;

  const corner = await note.locator(".react-flow__resize-control.handle.bottom.right").boundingBox();
  await drag(page, { x: corner!.x + corner!.width / 2, y: corner!.y + corner!.height / 2 }, { x: 120, y: 80 });
  await expect.poll(async () => { const n = (await stored())[0]!; return [n.w! - before.w!, n.h! - before.h!]; }).toEqual([120, 80]);

  await page.locator('[data-note-color="blue"]').click();
  await expect.poll(async () => (await stored())[0]!.color).toBe("blue");

  await page.keyboard.press("Control+d");
  await expect.poll(async () => (await stored()).map((o) => o.text)).toEqual(["resize me", "resize me"]);
  await page.keyboard.press("Backspace"); // the copy, which the duplicate selected
  await expect.poll(async () => (await stored()).map((o) => o.id)).toEqual([before.id]);

  await addBox(page, "9", 1000, 500, "Today");
  const list = page.locator(".react-flow__node-checklist");
  await list.locator("[data-board-text]").dblclick();
  for (const item of ["first", "second", "third"]) { await page.keyboard.press("Enter"); await page.keyboard.type(item); }
  await page.keyboard.press("Escape");
  await list.getByRole("checkbox", { name: "second" }).click();
  const grip = async (text: string) => (await list.locator(`[data-checklist-item]:has-text("${text}") span[aria-hidden]`).first().boundingBox())!;
  const third = await grip("third");
  const first = await grip("first");
  await drag(page, { x: third.x + third.width / 2, y: third.y + third.height / 2 }, { x: 0, y: first.y - third.y - 4 });
  await expect.poll(async () => (await stored()).find((o) => o.kind === "checklist")?.items)
    .toEqual([{ id: expect.any(String), text: "third", done: false }, { id: expect.any(String), text: "first", done: false }, { id: expect.any(String), text: "second", done: true }]);
  await app.close();
});

test("a note added in a frame, or dropped in one, moves with it; an arrow joins two notes, is labelled, and goes with its end", async () => {
  const { app, page, stored } = await open();
  await page.mouse.move(300, 300);
  await page.keyboard.press("6");
  const frame = await frameInView(page);
  await addBox(page, "8", frame.x + frame.width / 2, frame.y + frame.height / 2, "inside");
  await page.keyboard.press("Escape"); // deselect
  const frameId = await page.locator(".react-flow__node-frame").getAttribute("data-id");
  await addBox(page, "8", 350, 320, "outside");
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await stored()).map((o) => [o.text, o.frame])).toEqual([["inside", frameId], ["outside", undefined]]);

  // Dropped with its middle in the frame, the second note joins it.
  const outside = page.locator('.react-flow__node-note:has-text("outside")');
  const ob = (await outside.boundingBox())!;
  const fb = (await page.locator(".react-flow__node-frame").boundingBox())!;
  await drag(page, { x: ob.x + 20, y: ob.y + 20 },
    { x: fb.x + fb.width - 10 - (ob.x + ob.width / 2), y: fb.y + fb.height / 2 - (ob.y + ob.height / 2) });
  await expect.poll(async () => (await stored()).find((o) => o.text === "outside")?.frame).toBe(frameId);

  // The frame dragged by its header carries both notes; what is stored for them does not change.
  const kept = await settled(stored);
  const inside = page.locator('.react-flow__node-note:has-text("inside")');
  const frameNode = page.locator(".react-flow__node-frame");
  const [ib, fb0] = [(await inside.boundingBox())!, (await frameNode.boundingBox())!];
  const header = (await frameNode.locator(".tile-drag-handle").first().boundingBox())!;
  await drag(page, { x: header.x + 30, y: header.y + header.height / 2 }, { x: 160, y: 120 });
  expect(await settled(stored)).toEqual(kept);
  // The frame lands on the grid, at whatever zoom the canvas is: the note moves just as far.
  const [moved, fb1] = [(await inside.boundingBox())!, (await frameNode.boundingBox())!];
  expect([fb1.x - fb0.x, fb1.y - fb0.y].every((d) => d > 80)).toBe(true);
  expect([Math.abs(moved.x - ib.x - (fb1.x - fb0.x)), Math.abs(moved.y - ib.y - (fb1.y - fb0.y))].every((d) => d < 1)).toBe(true);

  // An arrow from one note to the other, drawn from the Board menu.
  await page.locator('[data-toolbar-action="board"]').click();
  await page.locator('[data-board-choice="arrow"]').click();
  await inside.click({ force: true });
  await outside.click({ force: true });
  await expect.poll(async () => (await stored()).filter((o) => o.kind === "arrow").map((a) => [a.from?.id, a.to?.id]))
    .toEqual([[kept.find((o) => o.text === "inside")!.id, kept.find((o) => o.text === "outside")!.id]]);
  await expect(page.locator("[data-board-arrow]")).toHaveCount(1);

  // Double-click the arrow to label it.
  const mid = await page.locator("[data-board-arrow] path").first().evaluate((p: SVGPathElement) => {
    const { x, y } = p.getPointAtLength(p.getTotalLength() / 2);
    const m = p.getScreenCTM()!;
    return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
  });
  await page.mouse.dblclick(mid.x, mid.y);
  await page.keyboard.type("about");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await stored()).find((o) => o.kind === "arrow")?.label).toBe("about");

  // Deleting an end takes the arrow with it.
  await outside.click();
  await page.keyboard.press("Backspace");
  await expect.poll(async () => (await stored()).map((o) => o.text ?? o.kind)).toEqual(["inside"]);
  await expect(page.locator("[data-board-arrow]")).toHaveCount(0);
  await app.close();
});

test("undo and redo take back board edits one at a time, never the tiles; the board is there after a restart", async () => {
  const { app, page, repo, ud, stored } = await open();
  // The store gives the board back in id order; what matters is what is on it.
  const board = async () => (await stored()).map((o) => `${o.kind} ${o.text}`).sort();
  // Each edit is saved before the next is made, so each is a step of its own.
  await page.mouse.move(400, 300);
  await page.keyboard.press("8");
  await expect.poll(board).toEqual(["note "]);
  await page.keyboard.type("first");
  await page.keyboard.press("Escape");
  await expect.poll(board).toEqual(["note first"]);
  await page.keyboard.press("Escape");
  await page.mouse.move(900, 300);
  await page.keyboard.press("9");
  await expect.poll(board).toEqual(["checklist ", "note first"]);
  await page.keyboard.type("second");
  await page.keyboard.press("Escape");
  await expect.poll(board).toEqual(["checklist second", "note first"]);
  await page.keyboard.press("Escape");
  await page.mouse.move(900, 800);
  await page.keyboard.press("1");
  await expect(page.locator(".react-flow__node-terminal")).toHaveCount(1);
  await page.locator(".react-flow__pane").click({ position: { x: 20, y: 500 } });

  for (const want of [["checklist ", "note first"], ["note first"], ["note "], []]) {
    await page.keyboard.press("Control+z");
    await expect.poll(board).toEqual(want);
    await expect(page.locator("[data-board-object]")).toHaveCount(want.length);
  }
  await expect(page.locator(".react-flow__node-terminal")).toHaveCount(1);
  for (const want of [["note "], ["note first"], ["checklist ", "note first"], ["checklist second", "note first"]]) {
    await page.keyboard.press("Control+Shift+z");
    await expect.poll(board).toEqual(want);
  }

  // Inside a note, the same keys take back what was just typed there.
  await page.locator(".react-flow__node-note [data-board-text]").dblclick();
  await page.keyboard.press("End");
  await page.keyboard.type(" and more");
  await page.keyboard.press("Control+z");
  await expect(page.locator(".react-flow__node-note textarea")).toHaveValue("first");
  await expect.poll(board).toEqual(["checklist second", "note first"]);
  await page.keyboard.press("Escape");

  await app.close();
  const again = await launch(repo, ud);
  await expect(again.page.locator(".react-flow__node-note [data-board-text]")).toHaveText("first");
  await expect(again.page.locator(".react-flow__node-checklist [data-board-text]")).toHaveText("second");
  await again.app.close();
});
