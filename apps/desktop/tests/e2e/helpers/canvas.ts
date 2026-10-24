// Reaching something on the canvas as a person does. The canvas's box never scrolls (styles.css
// clips `.react-flow`), so a control past its edge is brought into view by zooming out, not by
// scrolling the box the way a browser reaches an element further down a page.
import type { Locator, Page } from "@playwright/test";

/** Zoom the canvas out, a step at a time, until `el` is wholly inside the canvas's box. */
export async function reveal(w: Page, el: Locator): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const [box, canvas] = await Promise.all([el.boundingBox(), w.locator(".react-flow").first().boundingBox()]);
    if (box && canvas && box.x >= canvas.x && box.y >= canvas.y && box.x + box.width <= canvas.x + canvas.width && box.y + box.height <= canvas.y + canvas.height) return;
    await w.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:zoom", { detail: "out" })));
    await w.waitForTimeout(300);
  }
  throw new Error("still past the canvas's edge after zooming out six steps");
}
