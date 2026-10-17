// How quickly others see where you point (design §4.4): a guest moves their pointer over the
// board, and the host's window draws the guest's cursor there; over a direct link, 95 in 100 moves
// are drawn within 150 ms. Both apps share this machine's clock: the guest's move is stamped as it
// is made, the host's drawing as its cursor element changes.
import { test, expect, type ElectronApplication } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hiveNetBuilt, sharedWorkspace } from "./helpers/multiplayer";

let root: string;
const apps: ElectronApplication[] = [];
test.beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-latency-")); });
test.afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
});

test("over a direct link, a guest's pointer is drawn on the host's board within 150 ms, 95 times in 100", async () => {
  test.skip(!hiveNetBuilt(), "build hive-net first: cargo build in crates/hive-net");
  const { host, guest } = await sharedWorkspace(root, apps, "view");
  const me = await guest.evaluate(() => window.hive.identity());
  const board = (await guest.locator(".react-flow__pane").boundingBox())!;
  const at = (i: number) => ({ x: board.x + 200 + (i % 20) * 12, y: board.y + 200 + Math.floor(i / 20) * 12 });
  await guest.mouse.move(at(0).x, at(0).y);
  const cursor = `[data-presence-cursor="${me.personId}"]`;
  await expect(host.locator(cursor)).toBeVisible({ timeout: 10_000 });

  // The host notes when its drawing of the cursor changes.
  await host.evaluate((sel) => {
    const seen: number[] = [];
    (window as unknown as { seen: number[] }).seen = seen;
    const watch = () => {
      const el = document.querySelector(sel);
      if (!el) return requestAnimationFrame(watch);
      new MutationObserver(() => seen.push(Date.now())).observe(el, { attributes: true, attributeFilter: ["style"] });
    };
    watch();
  }, cursor);
  const delays: number[] = [];
  for (let i = 1; i <= 40; i++) {
    const before = (await host.evaluate(() => (window as unknown as { seen: number[] }).seen.length));
    const movedAt = Date.now();
    await guest.mouse.move(at(i).x, at(i).y);
    await expect.poll(() => host.evaluate(() => (window as unknown as { seen: number[] }).seen.length), { timeout: 5_000, intervals: [5] }).toBeGreaterThan(before);
    const drawnAt = await host.evaluate((n) => (window as unknown as { seen: number[] }).seen[n]!, before);
    delays.push(drawnAt - movedAt);
    await guest.waitForTimeout(60);
  }
  delays.sort((a, b) => a - b);
  const p95 = delays[Math.ceil(delays.length * 0.95) - 1]!;
  console.log(`[latency] cursor, direct: p50 ${delays[Math.floor(delays.length / 2)]} ms, p95 ${p95} ms`);
  expect(p95).toBeLessThan(150);
});
