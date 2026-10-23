import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { patchSettingsFile } from "./settings";
import { accentOf, appearanceExtraOf } from "./appearance-extra";
import { DEFAULT_APPEARANCE, DEFAULT_SETTINGS, lookForGuests, mergeSettings, setPath, settingPathProblem, sharedAppearance } from "./settings-schema";

const BRAND = { brand: "#b5713f", accent: "oklch(0.78 0.09 60)", working: "rgb(240 230 220)" };
const face = (url: string, family = "Harbour Display") => ({ ui: { family, files: [{ url, weight: "400" }] } });

describe("appearanceExtra in settings.json", () => {
  test("a write to appearance keeps it, and a built-in accent id stays for an older build", () => {
    const file = mergeSettings({ appearance: { accent: "ember" }, appearanceExtra: { accent: BRAND } });
    const after = mergeSettings(setPath(file, "appearance.radius", 4), file);
    expect(after.appearanceExtra.accent).toEqual(BRAND);
    expect(after.appearance.accent).toBe("ember");
  });

  test("a part that fails its check is dropped", () => {
    const x = appearanceExtraOf({
      accent: { brand: "red", accent: "#fff" },
      fontFaces: { ui: { family: "x\"; } body { color: red", files: [{ url: "hivemedia://media/a.woff2" }] }, mono: face("https://evil.example/a.woff2").ui },
    });
    expect(x).toEqual({});
  });

  test("on disk, a write here keeps a newer build's key inside it, and the custom accent", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hm-extra-"));
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, JSON.stringify({ v: 1, appearanceExtra: { accent: BRAND, spinner: { speed: 3 } } }));
    await patchSettingsFile([{ path: "appearance.radius", value: 4 }], file);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).appearanceExtra).toEqual({ accent: BRAND, spinner: { speed: 3 } });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a font file is a copied woff2 in the media folder, nothing else", () => {
    expect(appearanceExtraOf({ fontFaces: face("hivemedia://media/theme-ab12cd34-display.woff2") }).fontFaces?.ui?.files).toHaveLength(1);
    for (const url of ["hivemedia://media/../settings.json", "hivemedia://media/x.ttf", "file:///x.woff2"]) {
      expect(appearanceExtraOf({ fontFaces: face(url) }).fontFaces).toBeUndefined();
    }
  });

  test("a theme's `before` never holds a theme of its own", () => {
    const inner = { id: "@a/p/old", name: "Old", version: "1.0.0", appliedAt: 1, before: { appearance: DEFAULT_APPEARANCE, extra: {} } };
    const x = appearanceExtraOf({ theme: { id: "@a/p/new", name: "New", version: "1.1.0", appliedAt: 2, before: { appearance: DEFAULT_APPEARANCE, extra: { accent: BRAND, theme: inner } } } });
    expect(x.theme?.before.extra).toEqual({ accent: BRAND });
  });

  test("a theme record without a look to go back to is dropped", () => {
    expect(appearanceExtraOf({ theme: { id: "@a/p/t", name: "T", version: "1.0.0" } }).theme).toBeUndefined();
  });

  test("`hive config set` takes appearanceExtra.accent whole, not a key below it", () => {
    expect(settingPathProblem("appearanceExtra.accent")).toBeNull();
    expect(settingPathProblem("appearanceExtra.accent.brand")).toMatch(/set whole/);
    expect(settingPathProblem("appearanceExtra.bogus")).toMatch(/no setting/);
  });
});

describe("accentOf", () => {
  test("the custom accent wins over the built-in id while it is set", () => {
    expect(accentOf({ accent: "ember" }, { accent: BRAND })).toEqual({ ...BRAND, custom: true });
    expect(accentOf({ accent: "ember" }, {})).toMatchObject({ brand: "#ff7849", custom: false });
  });
});

describe("a guest's view of a custom accent", () => {
  test("its colours reach guests; its font files do not", () => {
    const s = { ...DEFAULT_SETTINGS, appearanceExtra: { accent: BRAND, fontFaces: face("hivemedia://media/a.woff2") } };
    const shared = sharedAppearance(lookForGuests(s));
    expect(shared.accentCustom).toEqual(BRAND);
    expect(JSON.stringify(shared)).not.toContain("hivemedia");
    // What a guest checks again, from a peer: a bad colour is not passed on.
    expect(sharedAppearance({ ...DEFAULT_APPEARANCE, accentCustom: { brand: "url(x)", accent: "#fff" } }).accentCustom).toBeUndefined();
  });
});
