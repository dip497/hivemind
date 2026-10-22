/**
 * What the operating system draws for the app in its look: the window's background before the
 * page paints (and in its resize gutters), and light or dark for native menus, scrollbars and
 * every page's `prefers-color-scheme`. One owner, set from the person's appearance as it changes.
 */
import { nativeTheme } from "electron";
import { cssColorToHex } from "@hivemind/core/css-color";
import type { Appearance } from "@hivemind/core/settings-schema";
import { openWindows } from "./windows.js";
import { getSettings, onSettingsChange } from "./settings-store.js";

/** The dark the app has always opened on, for a colour that cannot be read. */
const FALLBACK_BG = "#0d0e12";

export const windowBackground = (a: Appearance): string => cssColorToHex(a.palette.bg, FALLBACK_BG);

let last = "";
function apply(a: Appearance): void {
  const bg = windowBackground(a);
  const key = `${a.mode}\u0000${bg}`;
  if (key === last) return;
  last = key;
  nativeTheme.themeSource = a.mode;
  for (const w of openWindows()) if (!w.isDestroyed()) w.setBackgroundColor(bg);
}

/** Follow the appearance from now on; the background a new window should open with. */
export function followWindowLook(): void {
  apply(getSettings().appearance);
  onSettingsChange((s) => apply(s.appearance));
}

/** A new window: the colour to create it with. */
export function initialWindowBackground(): string {
  return windowBackground(getSettings().appearance);
}

