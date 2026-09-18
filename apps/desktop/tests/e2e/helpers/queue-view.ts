// The community view the view specs drive: Queue, as published (fixtures/views/queue). It docks a
// tile's live terminal when its row is clicked, which is what these specs need a plugin to do.
import { expect, type Page } from "@playwright/test";
import path from "node:path";

export const QUEUE_DIR = path.resolve(process.cwd(), "tests/e2e/fixtures/views/queue");
export const queueReady = '[data-community-view="queue"][data-community-ready="1"]';

export const queueFrame = (page: Page) => page.frameLocator('[data-community-view="queue"] iframe');

/**
 * Dock a tile through Queue: click its row, as a person would. A tile that is not an agent sits in
 * the collapsed "Other tiles" group, so that opens first. The view runs in an out-of-process frame
 * whose first clicks can land before its listeners are live; the row click is idempotent, so a
 * repeat is safe and the check is the host placing the slot.
 */
/** Open the "Other tiles" group, where tiles that are not agents are listed (collapsed by default). */
export async function expandOtherTiles(page: Page): Promise<void> {
  const other = queueFrame(page).locator('.q-group[data-group="other"]');
  if ((await other.count()) && (await other.getAttribute("data-collapsed")) !== null) {
    await other.locator("h2").click().catch(() => {});
  }
}

export async function dockViaQueue(page: Page, tileId: string): Promise<void> {
  const frame = queueFrame(page);
  const slot = page.locator(`[data-community-slot="${tileId}"]`);
  for (let attempt = 0; attempt < 5 && (await slot.count()) === 0; attempt++) {
    await expandOtherTiles(page);
    await frame.locator(`.q-row[data-id="${tileId}"]`).click({ timeout: 2_000 }).catch(() => {});
    await page.waitForTimeout(400);
  }
  await expect(page.locator(`[data-community-slot="${tileId}"] .xterm`)).toHaveCount(1, { timeout: 10_000 });
}

/** Release the docked terminal from inside the view: Escape in its list. */
export async function releaseViaQueue(page: Page): Promise<void> {
  await queueFrame(page).locator(".q-list").press("Escape");
}

/** The view's rendered-frame counter, as the host reads it for its render-on-demand check. */
export const framesDrawn = (page: Page) => page.locator("[data-community-view]").evaluate((el) =>
  (el as unknown as { __community: { stats: { framesDrawn: number } } }).__community.stats.framesDrawn);
