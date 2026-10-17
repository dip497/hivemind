/**
 * Tiles one person pinned to their screen (docs/design/multiplayer-2026-09-28.md, R5). A pinned
 * tile floats at a place on that person's screen, so a pin is theirs: kept on this device, never in
 * the workspace document. Two windows on one workspace each pin tiles for their own screen.
 */
import type { ScreenAnchor } from "../pin-anchor";
import type { ViewLayoutSpec } from "./view-layout-store";

/** Where a pinned tile floats, and how big, in screen pixels. */
export interface Pin {
  anchor: ScreenAnchor;
  size: { w: number; h: number };
}
export type Pins = Record<string, Pin>;

export const PINS: ViewLayoutSpec<Pins> = { viewId: "pins", version: 1, initial: () => ({}), personal: true };

/** A pinned panel's size when none was measured. */
export const PIN_SIZE = { w: 380, h: 260 };

/** What a tile carried in the workspace document while a pin was the workspace's. */
export interface LegacyPin {
  pinned?: boolean;
  pinAnchor?: ScreenAnchor;
  pinSize?: { w: number; h: number };
}

/** The pins tiles carried before a pin was one person's, for a device with none of its own. */
export function pinsOfTiles(tiles: ReadonlyArray<{ id: string } & LegacyPin>): Pins {
  const pins: Pins = {};
  for (const t of tiles) if (t.pinned && t.pinAnchor) pins[t.id] = { anchor: t.pinAnchor, size: t.pinSize ?? PIN_SIZE };
  return pins;
}
