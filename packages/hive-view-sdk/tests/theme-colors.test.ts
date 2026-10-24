// The colours a view is told are a frozen contract: views written against them paint with
// `var(--hm-color-<id>)` and break silently when one stops coming. Adding one is fine; removing
// or renaming one is a Breaking change to the protocol (reference.md, "Frozen").
import { expect, test } from "bun:test";
import { applyThemeVars, type ViewClient } from "../src/client.js";
import { VIEW_THEME_COLORS } from "../src/protocol.js";

/** The 15, as views have been told them since protocol 1.0. The literal is the contract. */
const FROZEN = ["bg", "bg2", "bg3", "bg4", "fg", "fg2", "fg3", "line", "line2", "brand", "err", "ok", "warn", "info", "accent"];

test("every frozen colour is still one a host sends, and each reaches a view as --hm-color-<id>", () => {
  expect(FROZEN.filter((id) => !(VIEW_THEME_COLORS as readonly string[]).includes(id))).toEqual([]);
  const props = new Map<string, string>();
  const root = { style: { setProperty: (k: string, v: string) => props.set(k, v), removeProperty: () => "" }, dataset: {} } as unknown as HTMLElement;
  const colors = Object.fromEntries(VIEW_THEME_COLORS.map((id, i) => [id, `#0000${i.toString(16).padStart(2, "0")}`]));
  applyThemeVars({ hello: { theme: { colors } }, on: () => () => {} } as unknown as ViewClient, root);
  expect(FROZEN.map((id) => [id, props.get(`--hm-color-${id}`)])).toEqual(FROZEN.map((id) => [id, colors[id]]));
});
