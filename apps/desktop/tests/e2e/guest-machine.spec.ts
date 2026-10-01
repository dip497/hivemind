// Agents on your machine in someone else's workspace (M4, design §5.4), with two app instances: a
// guest who may edit the board puts a frame of their own on their own computer (the only place
// the chooser offers them), and a shell they open in it runs there, in their folder. The host's
// board has the frame and the shell, and the host starts nothing on the guest's machine; nor does
// a shell the host puts in the guest's frame run there: on a guest's machine, only what its person
// placed runs.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hiveNetBuilt, sharedWorkspace, tiles } from "./helpers/multiplayer";

let root: string;
const apps: ElectronApplication[] = [];
test.beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-guest-machine-")); });
test.afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
});

const frames = (w: Page) => w.locator(".react-flow__node-frame").evaluateAll((ns) => ns.map((n) => n.getAttribute("data-id")!).sort());
/** What the terminal of `tile` shows in `w` (it draws on a canvas: its host element reads its screen). */
const screenOf = (w: Page, tile: string) => w.locator(`.react-flow__node-terminal[data-id="${tile}"]`).evaluate((el) => {
  const host = [el, ...el.querySelectorAll("*")].find((e) => "__hmScreen" in e) as (Element & { __hmScreen(): string }) | undefined;
  return host?.__hmScreen() ?? "";
}).catch(() => "");
const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "");
/** The tile `w` opened in `frame` by asking for a shell there. */
async function openShell(w: Page, frame: string): Promise<string> {
  const before = await tiles(w);
  await w.evaluate((id) => window.dispatchEvent(new CustomEvent("hivemind:frame-open", { detail: { frameId: id, kind: "shell" } })), frame);
  let tile = "";
  await expect.poll(async () => (tile = (await tiles(w)).find((t) => !before.includes(t) && !t!.startsWith("frame-")) ?? ""), { timeout: 20_000 }).not.toBe("");
  return tile;
}

test("a guest puts a frame of their own on their computer: a shell they open in it runs there, in their folder; the host starts nothing there, nor does a shell the host puts in it run", async () => {
  test.skip(!hiveNetBuilt(), "build hive-net first: cargo build in crates/hive-net");
  test.setTimeout(150_000);
  const { host, guest } = await sharedWorkspace(root, apps, "edit");
  const folder = path.join(root, "priya-api");
  fs.mkdirSync(folder);

  // In someone else's workspace, where a frame runs is this computer, a folder of theirs.
  const had = await frames(guest);
  await guest.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:machines", { detail: { kind: "pick", frameId: null } })));
  await guest.locator("[data-this-computer-folder]").fill(folder);
  await guest.locator("[data-this-computer-go]").click();
  let frame = "";
  await expect.poll(async () => (frame = (await frames(guest)).find((f) => !had.includes(f)) ?? ""), { timeout: 10_000 }).not.toBe("");
  await expect.poll(() => frames(host), { timeout: 15_000 }).toContain(frame);

  // A shell they open in it runs on their computer, in their folder.
  const shell = await openShell(guest, frame);
  const terminal = guest.locator(`.react-flow__node-terminal[data-id="${shell}"]`);
  await expect.poll(async () => {
    await guest.evaluate((id) => window.dispatchEvent(new CustomEvent("hivemind:focus-tile", { detail: id })), shell);
    return terminal.locator(".hm-node-selected").count();
  }, { timeout: 20_000, intervals: [500] }).toBe(1);
  await expect(terminal.locator("textarea.xterm-helper-textarea")).toBeFocused({ timeout: 10_000 });
  await expect.poll(async () => {
    if (!read(path.join(folder, "where.txt"))) await guest.keyboard.type("pwd > where.txt\n");
    return read(path.join(folder, "where.txt"));
  }, { timeout: 30_000, intervals: [1_000] }).toBe(folder);

  // Opened again (the window reloads), it starts on their computer again, as they placed it.
  await guest.reload();
  await expect.poll(() => screenOf(guest, shell), { timeout: 20_000 }).toContain(folder);
  expect(await screenOf(guest, shell)).not.toContain("someone else placed");

  // The host's board has it, and the host started nothing on the guest's machine.
  await expect.poll(() => tiles(host), { timeout: 15_000 }).toContain(shell);
  await expect.poll(() => screenOf(host, shell), { timeout: 15_000 }).toContain("someone else's machine");

  // A shell the host puts in the guest's frame reaches the guest's board, and does not run there.
  const had2 = await tiles(guest);
  const planted = await openShell(host, frame);
  await expect.poll(() => tiles(guest), { timeout: 15_000 }).toContain(planted);
  expect(had2).not.toContain(planted);
  await expect.poll(() => screenOf(guest, planted), { timeout: 15_000 }).toContain("someone else placed this tile on your computer");
});
