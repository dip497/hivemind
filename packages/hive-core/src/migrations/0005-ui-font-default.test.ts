/**
 * 0005 on a settings.json holding the old, never-drawn interface font default: it becomes the font
 * the app draws, the rest of the file as it was, the old file kept in the backup; a font the person
 * chose is left alone; killed at 20 points and run again, it ends as a clean run does.
 */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { OLD_UI_FONT_DEFAULT, UI_FONT } from "../settings-schema.js";
import { TestRoot } from "./fixtures/runs.js";

const BEFORE = path.join(import.meta.dir, "fixtures", "ui-font", "before");
const CHOSEN = path.join(import.meta.dir, "fixtures", "ui-font", "chosen");
let t: TestRoot | undefined;
afterEach(() => t?.remove());

const endState = () => ({ settings: t!.read("settings.json"), backup: t!.backup("0005-ui-font-default") });

describe("0005: the interface font default", () => {
  test("the old default becomes the font the app draws; the rest of the look is kept", () => {
    t = new TestRoot(BEFORE);
    const applied = t.runOnce().find((a) => a.id === "0005-ui-font-default");
    expect(applied?.result).toEqual({ changed: true });
    const s = endState().settings;
    expect(s.appearance.uiFont).toBe(UI_FONT);
    expect([s.appearance.preset, s.appearance.accent, s.appearance.monoFont, s.browserCdp]).toEqual(["nord", "ice", "\"JetBrains Mono\", monospace", true]);
    // The file as 0005 found it (after the migrations before it) is in its backup.
    expect(Object.keys(endState().backup)).toEqual(["settings.json"]);
    const kept = JSON.parse(fs.readFileSync(path.join(t.root, "migrations", "backups", "0005-ui-font-default", "settings.json"), "utf8"));
    expect(kept.appearance.uiFont).toBe(OLD_UI_FONT_DEFAULT);
  });

  test("a font the person chose is left alone", () => {
    t = new TestRoot(CHOSEN);
    const applied = t.runOnce().find((a) => a.id === "0005-ui-font-default");
    expect(applied?.result).toEqual({ changed: false });
    expect(endState().settings.appearance.uiFont).toBe("\"Iosevka Aile\", sans-serif");
  });

  test("killed at 20 points and run again, it ends as a clean run does", async () => {
    t = new TestRoot(BEFORE);
    const { clean, ends, cutOff } = await t.killedAndRunAgain(() => endState().settings.appearance.uiFont);
    expect(clean).toBe(UI_FONT);
    for (const end of ends) expect(end).toBe(clean);
    expect(cutOff).toBe(20);
  }, 240_000);
});
