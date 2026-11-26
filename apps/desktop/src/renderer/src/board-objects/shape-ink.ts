/**
 * How each shape colour is drawn on this theme: one table (workspace-doc's, which a picture of the
 * board reads too), as CSS variables, so a theme change needs no shape redrawn.
 */
import { SHAPE_INK } from "@hivemind/workspace-doc/drawing";
import { SHAPE_COLORS, type ShapeColor } from "@hivemind/workspace-doc/shapes";

export const inkVar = (color: string | undefined): string =>
  `var(--hm-ink-${(SHAPE_COLORS as readonly string[]).includes(color ?? "") ? color : "ink"})`;

if (typeof document !== "undefined" && typeof CSSStyleSheet === "function") {
  const rule = (mode: "dark" | "light", root: string): string =>
    `${root} { ${SHAPE_COLORS.map((c: ShapeColor) => `--hm-ink-${c}: ${SHAPE_INK[mode][c]};`).join(" ")} }`;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`${rule("dark", ":root")}\n${rule("light", ':root[data-theme-mode="light"]')}`);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}
