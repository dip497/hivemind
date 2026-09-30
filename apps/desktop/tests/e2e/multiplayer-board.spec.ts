// The workspace over the network (M1, design §4.2 C and G): a guest who joined opens the host's
// workspace and sees its tiles; a note either writes reaches the other; a guest who may only view
// sees the host's changes and writes nothing to the host.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hiveNetBuilt, join, person, share } from "./helpers/multiplayer";

let root: string;
const apps: ElectronApplication[] = [];
test.beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-board-")); });
test.afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
});

const tiles = (w: Page) => w.locator(".react-flow__node").evaluateAll((ns) => ns.map((n) => n.getAttribute("data-id")).filter((id) => id && !id.startsWith("note")).sort());
const notes = (w: Page) => w.locator(".react-flow__node-note [data-board-text]").allTextContents();
const emptySpot = (w: Page) => w.evaluate(() => {
  const pane = document.querySelector(".react-flow__pane")!.getBoundingClientRect();
  for (let y = pane.bottom - 140; y > pane.top + 100; y -= 30) {
    for (let x = pane.left + 320; x < pane.right - 100; x += 30) {
      if (document.elementFromPoint(x, y)?.classList.contains("react-flow__pane")) return { x, y };
    }
  }
  return null;
});
async function note(w: Page, text: string): Promise<void> {
  // Room on the canvas first: a workspace's frame can fill the view.
  for (let i = 0; i < 3; i++) await w.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:zoom", { detail: "out" })));
  await w.waitForTimeout(400);
  const at = (await emptySpot(w))!;
  await w.mouse.click(at.x, at.y);
  await w.keyboard.press("8");
  await w.keyboard.type(text);
  await w.keyboard.press("Escape");
}

async function sharedWorkspace(role: "view" | "edit") {
  const repo = path.join(root, "api");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const host = await person(root, "host", repo, apps);
  await host.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await expect.poll(async () => (await tiles(host)).length).toBeGreaterThan(0);
  const guestDir = path.join(root, "elsewhere");
  fs.mkdirSync(guestDir);
  const guest = await person(root, "guest", guestDir, apps);
  const link = await share(host, role);
  await join(guest, host, link);
  await guest.locator("[data-join-open]").click();
  await expect.poll(() => tiles(guest), { timeout: 15_000 }).toEqual(await tiles(host));
  return { host, guest };
}

test("a guest who joined opens the host's workspace and sees its tiles; a note either writes reaches the other", async () => {
  test.skip(!hiveNetBuilt(), "build hive-net first: cargo build in crates/hive-net");
  const { host, guest } = await sharedWorkspace("edit");
  await note(guest, "from the guest");
  await expect.poll(() => notes(host), { timeout: 10_000 }).toEqual(["from the guest"]);
  await note(host, "from the host");
  await expect.poll(async () => (await notes(guest)).sort(), { timeout: 10_000 }).toEqual(["from the guest", "from the host"]);
});

test("a guest who may only view sees the host's changes and writes nothing to the host", async () => {
  test.skip(!hiveNetBuilt(), "build hive-net first: cargo build in crates/hive-net");
  const { host, guest } = await sharedWorkspace("view");
  await note(host, "from the host");
  await expect.poll(() => notes(guest), { timeout: 10_000 }).toEqual(["from the host"]);
  await note(guest, "not mine to write");
  await host.waitForTimeout(1500);
  expect(await notes(host)).toEqual(["from the host"]);
});
