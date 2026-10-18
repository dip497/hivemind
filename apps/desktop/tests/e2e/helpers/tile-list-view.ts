// The community view the view specs drive: fixtures/views/tile-list. It docks a tile's live
// terminal when its row is clicked, which is what these specs need a plugin to do.
import { expect, type Page } from "@playwright/test";
import path from "node:path";

export const TILE_LIST_DIR = path.resolve(process.cwd(), "tests/e2e/fixtures/views/tile-list");
export const tileListReady = '[data-community-view="tile-list"][data-community-ready="1"]';

export const tileListFrame = (page: Page) => page.frameLocator('[data-community-view="tile-list"] iframe');

/**
 * Dock a tile through the list: click its row, as a person would. The view runs in an
 * out-of-process frame whose first clicks can land before its listeners are live; the row click
 * is idempotent, so a repeat is safe and the check is the host placing the slot.
 */
export async function dockFromList(page: Page, tileId: string): Promise<void> {
  const frame = tileListFrame(page);
  const slot = page.locator(`[data-community-slot="${tileId}"]`);
  for (let attempt = 0; attempt < 5 && (await slot.count()) === 0; attempt++) {
    await frame.locator(`.row[data-id="${tileId}"]`).click({ timeout: 2_000 }).catch(() => {});
    await page.waitForTimeout(400);
  }
  await expect(page.locator(`[data-community-slot="${tileId}"] .xterm`)).toHaveCount(1, { timeout: 10_000 });
}

/** Release the docked terminal from inside the view: Escape in its list. */
export async function releaseFromList(page: Page): Promise<void> {
  await tileListFrame(page).locator(".list").press("Escape");
}

/** The view's rendered-frame counter, as the host reads it for its render-on-demand check. */
export const framesDrawn = (page: Page) => page.locator("[data-community-view]").evaluate((el) =>
  (el as unknown as { __community: { stats: { framesDrawn: number } } }).__community.stats.framesDrawn);
