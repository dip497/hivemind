/**
 * `appearance.uiFont` was stored but never drawn: the app drew Geist whatever it held. Once the
 * setting is applied, the old default ("system-ui, sans-serif"), which almost every settings.json
 * holds without anyone choosing it, would turn everyone's interface into the system font. So the
 * old default becomes the font the app has always drawn. A font a person did choose is kept.
 */
import { readFile } from "node:fs/promises";
import { OLD_UI_FONT_DEFAULT, UI_FONT } from "../settings-schema.js";
import { settingsPath, updateSettings } from "../settings.js";
import type { Migration } from "./runner.js";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export const m0005: Migration = {
  id: "0005-ui-font-default",
  root: "config",
  backsUp: ["settings.json"],
  movesFilesAnOlderAppReads: false,
  async run() {
    const file = settingsPath();
    let raw: unknown;
    try { raw = JSON.parse(await readFile(file, "utf8")); } catch { return { changed: false }; }
    if (!isObj(raw) || !isObj(raw.appearance) || raw.appearance.uiFont !== OLD_UI_FONT_DEFAULT) return { changed: false };
    await updateSettings((cur) => ({ ...cur, appearance: { ...cur.appearance, uiFont: UI_FONT } }), file);
    return { changed: true };
  },
};
