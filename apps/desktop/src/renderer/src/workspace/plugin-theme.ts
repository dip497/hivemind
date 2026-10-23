/** The app's theme as a plugin is told it (`hello.theme`, `theme`): every token resolved to hex. */
import { STATUS_TONES, VIEW_THEME_COLORS, type ViewTheme } from "@hivemind/view-sdk/protocol";
import { ACCENTS, effectiveGlass, getTheme } from "../theme-store";
import { cssColorToHexString } from "./css-color";

export function readTheme(): ViewTheme {
  const cs = getComputedStyle(document.documentElement);
  const colors: Record<string, string> = {};
  for (const k of VIEW_THEME_COLORS) {
    const v = cs.getPropertyValue(`--color-${k}`).trim();
    if (v) colors[k] = cssColorToHexString(v);
  }
  const t = getTheme();
  return {
    colors,
    mode: t.mode,
    accent: cssColorToHexString(ACCENTS[t.accent].brand),
    radius: t.radius,
    fonts: { ui: t.uiFont, mono: t.monoFont },
    surface: cssColorToHexString(t.palette.bg2),
    terminalBackground: cssColorToHexString(t.terminal.background),
    glass: effectiveGlass(t),
    // The same status tokens every surface of the app paints with, resolved for the view.
    status: Object.fromEntries(STATUS_TONES.flatMap((tone) => {
      const v = cs.getPropertyValue(`--color-status-${tone}`).trim();
      return v ? [[tone, cssColorToHexString(v)]] : [];
    })),
  };
}
