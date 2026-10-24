// The last line in a guest's window (docs/design/last-line-2026-10-23.md §5): a guest who may only
// view the host's workspace sees, under the host's shell's name in their Layers panel, what that
// shell last printed, as the host's own row does, from the host's TileLines over the guest's
// window's own stream; printed again, the guest's row follows it. And how busy that shell's output
// is (`terminal.watchActivity`): a guest's window that watches it is told its level by the host, and
// once it watches nothing the host is told so (`[]`) and tells it nothing more.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hiveNetBuilt, sharedWorkspace } from "./helpers/multiplayer";
import { stopDaemons } from "./helpers/daemons";

let root: string;
const apps: ElectronApplication[] = [];
test.beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-lines-")); });
test.afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  stopDaemons(root);
  fs.rmSync(root, { recursive: true, force: true });
});

const line = (w: Page) => w.locator('aside[aria-label="Layers"] [data-layer-tile] [data-layer-line]').first();

test("a guest's Layers row says what the host's shell last printed, and follows it", async () => {
  test.skip(!hiveNetBuilt(), "build hive-net first: cargo build in crates/hive-net");
  const { host, guest } = await sharedWorkspace(root, apps, "view");
  const terminal = host.locator(".react-flow__node-terminal").first();
  await terminal.click();
  await terminal.locator(".xterm-screen").click();
  // Typed until the shell is up to run it: running it twice changes nothing.
  await expect.poll(async () => {
    await host.keyboard.type("echo $((200+14)) tests passed\n");
    return (await line(host).count()) ? line(host).textContent() : null;
  }, { timeout: 30_000, intervals: [2_500] }).toBe("214 tests passed");
  await expect(line(guest)).toHaveText("214 tests passed", { timeout: 15_000 });

  await host.keyboard.type("echo $((6*7)) files changed\n");
  await expect(line(guest)).toHaveText("42 files changed", { timeout: 15_000 });
});

test("a guest's window that watches the host's shell is told how busy it is, and once it watches nothing, nothing more", async () => {
  test.skip(!hiveNetBuilt(), "build hive-net first: cargo build in crates/hive-net");
  const { host, guest } = await sharedWorkspace(root, apps, "view");
  const tile = (await guest.locator(".react-flow__node-terminal").first().getAttribute("data-id"))!;
  await guest.evaluate((t) => {
    const w = window as unknown as { levels: number[] };
    w.levels = [];
    window.hive.onPtyActivity((l) => { if (t in l) w.levels.push(l[t]!); });
    window.hive.ptyActivityWatch([t]);
  }, tile);
  const levels = () => guest.evaluate(() => (window as unknown as { levels: number[] }).levels.slice());
  const terminal = host.locator(".react-flow__node-terminal").first();
  await terminal.click();
  await terminal.locator(".xterm-screen").click();
  // Typed until the shell is up to run it: a few seconds of output, then quiet.
  await expect.poll(async () => {
    await host.keyboard.type("for i in $(seq 1 200); do echo compiling module $i of 200; sleep 0.01; done\n");
    return (await levels()).some((l) => l > 0);
  }, { timeout: 30_000, intervals: [3_000] }).toBe(true);
  await expect.poll(async () => (await levels()).at(-1), { timeout: 30_000 }).toBe(0);

  await guest.evaluate(() => { (window as unknown as { levels: number[] }).levels.length = 0; window.hive.ptyActivityWatch([]); });
  await host.keyboard.type("seq 1 300000\n");
  // Busy, then quiet again: a watch the host still held would tell each change.
  await host.waitForTimeout(6_000);
  expect(await levels()).toEqual([]);
});
