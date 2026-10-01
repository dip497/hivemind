// The workspace over the network (M1, design §4.2 C and G): a guest who joined opens the host's
// workspace and sees its tiles; a note either writes reaches the other; a guest who may only view
// sees the host's changes and writes nothing, to the host or to their own copy; a guest who may
// edit the board starts nothing on the host; and each sees where the other is.
import { test, expect, type ElectronApplication } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hiveNetBuilt, note, notes, share, sharedWorkspace as shared, tiles } from "./helpers/multiplayer";
import { guest as windowless } from "./helpers/guest";

let root: string;
const apps: ElectronApplication[] = [];
test.beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-board-")); });
test.afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
});
const sharedWorkspace = (role: "view" | "edit") => shared(root, apps, role);

test("a guest who joined opens the host's workspace and sees its tiles; a note either writes reaches the other", async () => {
  test.skip(!hiveNetBuilt(), "build hive-net first: cargo build in crates/hive-net");
  const { host, guest } = await sharedWorkspace("edit");
  await note(guest, "from the guest");
  await expect.poll(() => notes(host), { timeout: 10_000 }).toEqual(["from the guest"]);
  await note(host, "from the host");
  await expect.poll(async () => (await notes(guest)).sort(), { timeout: 10_000 }).toEqual(["from the guest", "from the host"]);
});

test("a guest who may only view sees the host's changes and writes nothing, not even to their own copy", async () => {
  test.skip(!hiveNetBuilt(), "build hive-net first: cargo build in crates/hive-net");
  const { host, guest } = await sharedWorkspace("view");
  await note(host, "from the host");
  await expect.poll(() => notes(guest), { timeout: 10_000 }).toEqual(["from the host"]);
  await note(guest, "not mine to write");
  // Taken back on the guest's own board too: a viewer's copy is only read.
  await expect.poll(() => notes(guest), { timeout: 10_000 }).toEqual(["from the host"]);
  await host.waitForTimeout(1000);
  expect(await notes(host)).toEqual(["from the host"]);
});

test("a guest who may edit the board starts nothing on the host: a shell they add is put back on their own board, and one a device of theirs writes into the document itself is refused, and never runs there", async () => {
  test.skip(!hiveNetBuilt(), "build hive-net first: cargo build in crates/hive-net");
  const { host, guest } = await sharedWorkspace("edit");
  const hostLog: string[] = [];
  apps[0]!.process().stderr?.on("data", (d: Buffer) => hostLog.push(d.toString()));
  const before = await tiles(host);

  // From their window: put back at once, and the host never has it.
  await guest.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await expect.poll(() => tiles(guest), { timeout: 10_000 }).toEqual(before);
  expect(await tiles(host)).toEqual(before);

  // From a device of theirs that writes its copy of the document itself: the host says it does not
  // take it, and its window, which starts a tile it has within moments, runs nothing.
  const ran = path.join(root, "ran-on-the-host");
  const link = await share(host, "edit");
  const device = await windowless(path.join(root, "device"), "Sam", link, async () => {
    await host.locator(".hm-join-request").getByRole("button", { name: "Allow" }).click();
  });
  const core = device.store.getCore(device.repo)!;
  const shell = { id: "tile-shell-sam", kind: "shell", label: "sh", cmd: "/bin/sh", args: ["-c", `touch ${ran}`] };
  device.store.setCore(device.repo, { ...core, tiles: [...core.tiles, shell] }, { writer: "device", base: core });
  await expect.poll(() => hostLog.join(""), { timeout: 10_000 }).toMatch(/a change its role does not allow: adding tile tile-shell-sam/);
  await host.waitForTimeout(3_000);
  expect(fs.existsSync(ran)).toBe(false);
  expect(await tiles(host)).toEqual(before);
  device.stop();
});

test("each sees where the other is: the guest's pointer, named, and the tile they selected on the host's board; the host's face on the guest's", async () => {
  test.skip(!hiveNetBuilt(), "build hive-net first: cargo build in crates/hive-net");
  const { host, guest } = await sharedWorkspace("view");
  await guest.evaluate(() => window.hive.settingsSet("profile.name", "Priya Raman"));
  const [me, them] = [await guest.evaluate(() => window.hive.identity()), await host.evaluate(() => window.hive.identity())];

  const board = (await guest.locator(".react-flow__pane").boundingBox())!;
  await guest.mouse.move(board.x + board.width / 2, board.y + board.height / 2);
  await guest.mouse.move(board.x + board.width / 2 + 30, board.y + board.height / 2 + 20, { steps: 3 });
  const cursor = host.locator(`[data-presence-cursor="${me.personId}"]`);
  await expect(cursor).toContainText("Priya Raman", { timeout: 10_000 });
  await expect(guest.locator(`[data-people-here] [data-person="${them.personId}"]`)).toBeVisible();
  // Nobody is shown to themselves.
  await expect(guest.locator("[data-presence-cursor]")).toHaveCount(0);
  await expect(host.locator(`[data-people-here] [data-person="${them.personId}"]`)).toHaveCount(0);

  const tile = (await tiles(guest)).find((id) => !id!.startsWith("frame-"))!;
  await guest.locator(`.react-flow__node[data-id="${tile}"]`).click({ position: { x: 60, y: 14 } });
  await expect(host.locator(`[data-presence-selection="${tile}"]`)).toBeVisible({ timeout: 10_000 });

  // Off the board, the pointer goes; the person stays until they leave.
  const faces = (await guest.locator("[data-people-here]").boundingBox())!;
  await guest.mouse.move(faces.x + faces.width / 2, faces.y + faces.height / 2, { steps: 3 });
  await expect(cursor).toHaveCount(0, { timeout: 10_000 });
  await expect(host.locator(`[data-people-here] [data-person="${me.personId}"]`)).toBeVisible();
});

test("two people typing in one note at once both keep what they typed, and end with the same text", async () => {
  test.skip(!hiveNetBuilt(), "build hive-net first: cargo build in crates/hive-net");
  const { host, guest } = await sharedWorkspace("edit");
  await note(host, "shared");
  await expect.poll(() => notes(guest), { timeout: 10_000 }).toEqual(["shared"]);
  const open = async (w: typeof host) => {
    await w.locator(".react-flow__node-note [data-board-text]").dblclick();
    await w.keyboard.press("End");
  };
  await open(host);
  await open(guest);
  // The guest is still typing (nothing saved yet) when the host's words arrive.
  const guestTyping = guest.keyboard.type(" guestword", { delay: 250 });
  await host.keyboard.type(" hostword", { delay: 20 });
  await host.keyboard.press("Escape");
  await guestTyping;
  await guest.keyboard.press("Escape");
  const both = (texts: string[]) => texts.length === 1 && texts[0]!.includes("hostword") && texts[0]!.includes("guestword") && texts[0]!.startsWith("shared");
  await expect.poll(async () => both(await notes(host)), { timeout: 10_000 }).toBe(true);
  await expect.poll(async () => both(await notes(guest)), { timeout: 10_000 }).toBe(true);
  expect(await notes(guest)).toEqual(await notes(host));
});
