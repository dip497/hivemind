import type { ITerminalOptions } from "@xterm/xterm";
import { terminalThemeFor } from "@hivemind/core/settings-schema";
import { effectiveGlass, type ThemeState } from "./theme-store";

// Default terminal font size. Each tile remembers its OWN size (useTileFont keyed
// by tileId) — A−/A+ in the header + Ctrl/Cmd +/−/0 adjust it. Crispness is
// DPR-driven (see terminal-dpr.ts); 15 is the default for comfortable reading.
export const DEFAULT_FONT = 15;

export const termThemeFor = (t: ThemeState) => withScrollbar(terminalThemeFor(t.terminal));

/** xterm 6 colours its scrollbar from the theme, not CSS; follow the foreground. */
export function withScrollbar(theme: Record<string, string>): Record<string, string> {
  const fg = theme.foreground ?? "";
  const hex = /^#([0-9a-f]{3})$/i.test(fg) ? `#${[...fg.slice(1)].map((c) => c + c).join("")}` : fg;
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return theme;
  return {
    ...theme,
    scrollbarSliderBackground: `${hex}33`,
    scrollbarSliderHoverBackground: `${hex}59`,
    scrollbarSliderActiveBackground: `${hex}80`,
  };
}
/** The terminal background: FULLY transparent when content-glass is on, so the
 *  single tint lives on the tile ROOT (.hm-term-root, like every other tile) and
 *  the whole body — including the host's padding band — reads as one uniform tint
 *  (no "gap" frame). Else the opaque aubergine. */
// Scene views may opt out of glass; otherwise their wallpaper lives in the
// docked slot. The runtime surface policy determines the terminal background.
export const termBgFor = (t: ThemeState): string =>
  effectiveGlass(t) && t.contentGlass ? "rgba(0,0,0,0)" : t.terminal.background;

/** How a terminal draws its text, live or asleep: the same font, cells and colours, so one asleep
 *  shows its screen as it was. */
export function terminalLook(fontSize: number, t: ThemeState): ITerminalOptions {
  return {
    fontFamily: '"JetBrains Mono", monospace',
    fontSize,
    lineHeight: 1.3,
    // ONLY when Frost-tile-content is on at mount. allowTransparency disables
    // subpixel-antialiased text (text goes grayscale → softer/blurrier vs a
    // native terminal), so opaque terminals must keep it OFF to stay crisp.
    // (Toggling content-glass later needs a reload to apply to open terminals.)
    allowTransparency: t.glass && t.contentGlass,
    theme: { ...termThemeFor(t), background: termBgFor(t) },
    drawBoldTextInBrightColors: true,   // crisper bold rendering on dark bg
    minimumContrastRatio: 4.5,          // auto-adjust low-contrast cells to WCAG AA
                                        // (color only — doesn't affect sharpness)
    letterSpacing: 0,
    // Rescale glyphs that overflow their cell (powerline, wide Unicode,
    // ligature-ish forms) instead of letting them clip/smear — sharper edges.
    rescaleOverlappingGlyphs: true,
    // box-drawing / block chars drawn as crisp vectors, not font bitmaps.
    customGlyphs: true,
  };
}
