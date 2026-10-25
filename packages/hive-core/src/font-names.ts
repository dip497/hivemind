/**
 * A font, named: what the interface or the code font is, said the way a person reads it. The one
 * owner of that answer, for Settings ▸ Appearance and anything else that shows the font.
 *
 *   named   one of the faces this build names (System, Geist, JetBrains Mono)
 *   face    the face a theme brought (`appearanceExtra.fontFaces`), by its family, with the
 *           theme's name while the theme applied is the one that set it ("Nunito · Harbour")
 *   custom  any other CSS font list (typed, or `hive config set`), read as its first family
 *
 * A face counts only while the font is the very list applying the theme wrote (`faceStack`): a
 * list the person typed that happens to start with the same family is theirs, and stays Custom.
 * Browser-safe; reads settings, writes nothing.
 */
import type { AppearanceExtra } from "./appearance-extra.js";
import { GEIST_FONT, MONO_FONT, OLD_UI_FONT_DEFAULT, SYSTEM_MONO_FONT, UI_FONT } from "./settings-schema.js";

export type FontSlot = "ui" | "mono";

/** A face this build names: its id in a picker, its label, its CSS font list, and older lists
 *  that read as it (the default most settings.json files hold). */
export interface NamedFont { id: string; label: string; value: string; also?: readonly string[] }

/** The faces named per font. The system font is the interface default (DESIGN.md). */
export const NAMED_FONTS: Record<FontSlot, readonly NamedFont[]> = {
  ui: [{ id: "system", label: "System", value: UI_FONT, also: [OLD_UI_FONT_DEFAULT] }, { id: "geist", label: "Geist", value: GEIST_FONT }],
  mono: [{ id: "jetbrains", label: "JetBrains Mono", value: MONO_FONT }, { id: "system", label: "System", value: SYSTEM_MONO_FONT }],
};

/** The font list a theme's face is set as: the face first, the app's own after it while it loads
 *  or for a glyph it lacks. */
export const faceStack = (slot: FontSlot, family: string): string => `"${family}", ${slot === "ui" ? UI_FONT : MONO_FONT}`;

export type FontName =
  | { kind: "named"; id: string; label: string }
  | { kind: "face"; family: string; label: string; theme?: string }
  | { kind: "custom"; label: string };

/** The first family a CSS font list names, unquoted ("Inter" for `"Inter", sans-serif`). */
export function firstFamily(stack: string): string {
  return stack.split(",")[0]!.trim().replace(/^(["'])(.*)\1$/, "$2").trim();
}

/** What `stack`, the font in `slot`, is called, given the faces and the theme record `extra` holds. */
export function fontNameOf(slot: FontSlot, stack: string, extra: Pick<AppearanceExtra, "fontFaces" | "theme"> | null | undefined): FontName {
  const named = NAMED_FONTS[slot].find((f) => f.value === stack || f.also?.includes(stack));
  if (named) return { kind: "named", id: named.id, label: named.label };
  const face = extra?.fontFaces?.[slot];
  if (face && stack === faceStack(slot, face.family)) {
    // The theme applied set this face only if its record says it set the font; a face an earlier
    // theme left behind is named alone.
    const record = extra?.theme;
    const theme = record?.set.includes(`appearanceExtra.fontFaces.${slot}`) ? record.name : undefined;
    return { kind: "face", family: face.family, label: theme ? `${face.family} · ${theme}` : face.family, ...(theme ? { theme } : {}) };
  }
  return { kind: "custom", label: firstFamily(stack) || "Custom" };
}
