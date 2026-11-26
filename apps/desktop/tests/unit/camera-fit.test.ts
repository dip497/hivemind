import { test } from "node:test";
import assert from "node:assert/strict";
import { cameraFor, focusZoom, roomLeftOfCards } from "../../src/renderer/src/camera-fit";

test("a frame that fits is shown at 100%, never enlarged past it", () => {
  assert.equal(focusZoom(840, 580, 1600, 1000), 1);
  assert.equal(focusZoom(100, 100, 1600, 1000), 1);
});

test("a rect too big for the pane is fitted, padding included, on its tighter axis", () => {
  // Usable pane is pane / 1.18; 2000 wide → (1600 / 1.18) / 2000.
  assert.ok(Math.abs(focusZoom(2000, 400, 1600, 1000) - 1600 / 1.18 / 2000) < 1e-9);
  assert.ok(Math.abs(focusZoom(400, 2000, 1600, 1000) - 1000 / 1.18 / 2000) < 1e-9);
});

// The regression: the target must be a function of the rect and the pane only, so
// the same request lands at the same zoom whatever the camera was doing before.
test("the answer does not depend on where the camera is", () => {
  const once = focusZoom(1256, 884, 1600, 1000);
  for (let i = 0; i < 5; i++) assert.equal(focusZoom(1256, 884, 1600, 1000), once);
});

test("an unmeasured pane or an unknown size falls back to 100%, not to zero", () => {
  assert.equal(focusZoom(840, 580, 0, 0), 1);
  assert.equal(focusZoom(0, 0, 1600, 1000), 1);
});

test("a tile is framed in the room a column of widget cards along the right edge leaves, unless they would leave a sliver", () => {
  // A 1120px pane reaching the window's edge, under one column (16 + 240 + 12): 852 left of it.
  assert.equal(roomLeftOfCards(1120, 268, 0), 852);
  // The pane stops 100px short of the edge: the cards cover only what reaches past that.
  assert.equal(roomLeftOfCards(1120, 268, 100), 952);
  assert.equal(roomLeftOfCards(1120, 80, 100), 1120);
  // No cards, or two columns over a narrow pane: the whole pane.
  assert.equal(roomLeftOfCards(1120, 0, 0), 1120);
  assert.equal(roomLeftOfCards(640, 520, 0), 640);
});

// Where a box lands on screen once the camera is at `cam`.
const onScreen = (box: { x: number; y: number; w: number; h: number }, cam: { x: number; y: number; zoom: number }, paneW: number, paneH: number) => ({
  left: (box.x - cam.x) * cam.zoom + paneW / 2, top: (box.y - cam.y) * cam.zoom + paneH / 2,
  right: (box.x + box.w - cam.x) * cam.zoom + paneW / 2, bottom: (box.y + box.h - cam.y) * cam.zoom + paneH / 2,
});

test("a box gone to is whole and in the middle of the room the island and the cards leave, wherever it is and wherever the island is", () => {
  for (const island of [{ top: 80, bottom: 0 }, { top: 0, bottom: 90 }]) {
    const room = { paneW: 1600, paneH: 1000, roomW: 1300, ...island };
    for (const box of [{ x: 5000, y: -3000, w: 2400, h: 1800 }, { x: -40, y: 20, w: 300, h: 200 }]) {
      const s = onScreen(box, cameraFor(box, room, false), room.paneW, room.paneH);
      const at = `island ${JSON.stringify(island)}: ${JSON.stringify(s)}`;
      assert.ok(s.left >= 0 && s.right <= room.roomW && s.top >= room.top && s.bottom <= room.paneH - room.bottom, `whole, ${at}`);
      assert.ok(Math.abs((s.left + s.right) / 2 - room.roomW / 2) <= 1, `centred across, ${at}`);
      assert.ok(Math.abs((s.top + s.bottom) / 2 - (room.top + (room.paneH - room.top - room.bottom) / 2)) <= 1, `centred down, ${at}`);
    }
  }
});

test("at 100% a tile too big for the room shows from its top-left corner, below the bar", () => {
  const room = { paneW: 1600, paneH: 1000, roomW: 1600, top: 80, bottom: 0 };
  const box = { x: 300, y: 400, w: 2000, h: 1400 };
  const cam = cameraFor(box, room, true);
  assert.equal(cam.zoom, 1);
  const s = onScreen(box, cam, room.paneW, room.paneH);
  assert.equal(s.left, 24);
  assert.equal(s.top, room.top + 24);
});
