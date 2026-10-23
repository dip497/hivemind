// The last line in a guest's window (docs/design/last-line-2026-10-23.md §5): a guest who may only
// view the host's workspace sees, under the host's shell's name in their Layers panel, what that
// shell last printed, as the host's own row does, from the host's TileLines over the guest's
// window's own stream; printed again, the guest's row follows it.
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
