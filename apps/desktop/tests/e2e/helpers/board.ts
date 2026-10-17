// Adding to a person's board, as they do: the toolbar's Add menu puts a widget (a sticky note, a
// checklist, text) in the middle of the view, written in at once; dragging it takes it elsewhere.
import type { Page } from "@playwright/test";

/** Add the widget `widget` from the Add menu and write `text` in it (none: write nothing). It stays
 *  selected. */
export async function addFromMenu(w: Page, widget: string, text?: string): Promise<void> {
  await w.locator('[data-toolbar-action="board"]').first().click();
  await w.locator(`[data-board-choice="widget:${widget}"]`).click();
  if (text !== undefined) await w.keyboard.type(text);
  await w.keyboard.press("Escape"); // done writing; still selected
}

/** Drag the selected board widget so its middle is at `to`, in small steps (xyflow samples the
 *  pointer once a frame). */
export async function moveSelectedTo(w: Page, to: { x: number; y: number }): Promise<void> {
  const box = (await w.locator(".react-flow__node.selected").first().boundingBox())!;
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await w.mouse.move(from.x, from.y);
  await w.mouse.down();
  for (let i = 1; i <= 30; i++) {
    await w.mouse.move(from.x + ((to.x - from.x) * i) / 30, from.y + ((to.y - from.y) * i) / 30);
    await w.waitForTimeout(15);
  }
  await w.mouse.up();
}
