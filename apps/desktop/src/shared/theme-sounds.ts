/**
 * The applied theme's sound for a moment, read from settings.json's `appearanceExtra.theme`
 * (written when a theme is applied, docs/plans/sounds-and-themes.md T3–T4). Tolerant: anything
 * that is not a `hivemedia:` URL under a theme with a name is no sound, so a file written by
 * another build, or by hand, plays the built-in sound instead.
 */
import type { NoticeKind } from "./notification-settings.js";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** `moment`'s theme sound in the settings file `raw` (as parsed), and the theme's name. */
export function themeSoundOf(raw: unknown, moment: NoticeKind): { url: string; pack: string } | undefined {
  const theme = isObj(raw) && isObj(raw.appearanceExtra) ? raw.appearanceExtra.theme : undefined;
  if (!isObj(theme) || !isObj(theme.sounds)) return undefined;
  const url = theme.sounds[moment];
  if (typeof url !== "string" || !url.startsWith("hivemedia://") || url.length > 2048) return undefined;
  const pack = typeof theme.name === "string" && theme.name.trim() ? theme.name.trim().slice(0, 60) : "a theme";
  return { url, pack };
}
