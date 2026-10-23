import { describe, expect, test } from "bun:test";
import { contrastRatio } from "./css-color";
import { checkTheme, themeFiles, themeFromLook, type ThemeFolderFile } from "./theme-format";
import { CLEAN_LIGHT, DEFAULT_APPEARANCE, PRESETS, SIGNAL, applyPreset } from "./settings-schema";

const FILES: ThemeFolderFile[] = [
  { path: "fonts/display.woff2", bytes: 30_000 },
  { path: "fonts/big.woff2", bytes: 500 * 1024 },
  { path: "wallpaper.webp", bytes: 200_000 },
  { path: "clip.webm", bytes: 2_000_000 },
  { path: "sounds/needs.ogg", bytes: 20_000 },
  { path: "sounds/done.mp3", bytes: 20_000 },
  { path: "notes.txt", bytes: 10 },
];

/** A dark theme with every field set. */
const FULL = {
  format: 1,
  name: "Harbour",
  mode: "dark",
  palette: { ...SIGNAL.palette, bg: "#0e1a24", bg2: "rgb(20 36 48)", fg: "oklch(0.95 0.01 230)" },
  accent: { brand: "#c08552", accent: "#d9a273", working: "#e9d8c4" },
  terminal: { ...SIGNAL.terminal, ansi: [...SIGNAL.terminal.ansi] },
  radius: 14,
  fonts: { ui: { family: "Harbour Display", files: [{ path: "fonts/display.woff2", weight: "400 700", style: "normal" }] } },
  wallpaper: { image: "wallpaper.webp", brightness: 0.8 },
  sounds: { needs: "sounds/needs.ogg", done: "sounds/done.mp3" },
};
const theme = (patch: Record<string, unknown>) => ({ ...FULL, ...patch });
const problem = (raw: unknown) => { const r = checkTheme(raw, FILES); return "problem" in r ? r.problem : null; };

describe("checkTheme", () => {
  test("a theme with every field is read as written, and names its files", () => {
    const r = checkTheme(FULL, FILES);
    expect("theme" in r && r.theme).toMatchObject({ format: 1, name: "Harbour", radius: 14, accent: FULL.accent, wallpaper: FULL.wallpaper, sounds: FULL.sounds });
    expect("theme" in r && themeFiles(r.theme).sort()).toEqual(["fonts/display.woff2", "sounds/done.mp3", "sounds/needs.ogg", "wallpaper.webp"]);
  });

  test("only name, mode, palette and accent are needed; a built-in wallpaper or a video is a wallpaper too", () => {
    const { terminal: _t, radius: _r, fonts: _f, wallpaper: _w, sounds: _s, ...least } = FULL;
    expect(problem(least)).toBeNull();
    expect(problem(theme({ wallpaper: { kind: "aurora" } }))).toBeNull();
    expect(problem(theme({ wallpaper: { video: "clip.webm" } }))).toBeNull();
    expect(problem(theme({ accent: "ember" }))).toBeNull();
  });

  test.each([
    ["no format", { format: undefined }, /needs "format": 1/],
    ["a newer format", { format: 2 }, /format 2.*update Hivemind/],
    ["a reserved part", { icons: {} }, /icons is reserved for a later theme format/],
    ["an unknown field", { colour: "#fff" }, /no field "colour"/],
    ["a name past 60", { name: "x".repeat(61) }, /name is up to 60/],
    ["a name with a control character", { name: "Harbour‮" }, /name is up to 60 characters of plain text/],
    ["another mode", { mode: "dim" }, /mode is "dark" or "light"/],
    ["a palette missing keys", { palette: { bg: "#000" } }, /palette is missing bg2/],
    ["a palette key it does not take", { palette: { ...FULL.palette, link: "#fff" } }, /palette has no key link/],
    ["a colour it cannot read", { palette: { ...FULL.palette, line: "hsl(0 0% 20%)" } }, /palette.line is not a colour/],
    ["a named colour", { palette: { ...FULL.palette, line: "gray" } }, /palette.line is not a colour/],
    ["a see-through colour", { palette: { ...FULL.palette, bg3: "#ffffff80" } }, /palette.bg3 has transparency/],
    ["a see-through oklch", { palette: { ...FULL.palette, line: "oklch(0.3 0.01 250 / 0.5)" } }, /palette.line has transparency/],
    ["an accent id it does not know", { accent: "teal" }, /accent is one of/],
    ["amber as the accent", { accent: "amber" }, /amber is the colour of an agent waiting on you/],
    ["the accent in the colour of needs you", { accent: { brand: SIGNAL.palette.warn, accent: "#d9a273" } }, /accent.brand is the colour of an agent waiting on you/],
    ["an accent too faint to see", { accent: { brand: "#16222c", accent: "#d9a273" } }, /accent.brand on bg is .*:1; .* needs at least 3:1/],
    ["a terminal without 16 colours", { terminal: { ...FULL.terminal, ansi: ["#000"] } }, /16 ANSI colours/],
    ["corners past 24", { radius: 40 }, /radius is from 0 to 24/],
    ["a font that is not woff2", { fonts: { ui: { family: "X", files: [{ path: "notes.txt" }] } } }, /is not a .woff2 font/],
    ["a font over 400 KB", { fonts: { ui: { family: "X", files: [{ path: "fonts/big.woff2" }] } } }, /is 500 KB; .* at most 400 KB/],
    ["a font family that could break out of CSS", { fonts: { ui: { family: "X'; } *{", files: [{ path: "fonts/display.woff2" }] } } }, /family is a font's name/],
    ["a font not in the folder", { fonts: { mono: { family: "X", files: [{ path: "fonts/gone.woff2" }] } } }, /there is no fonts\/gone.woff2/],
    ["a font kind it does not take", { fonts: { display: {} } }, /fonts is \{ ui\?, mono\? \}/],
    ["a file outside the folder", { wallpaper: { image: "../secret.png" } }, /not a path inside the theme's folder/],
    ["a wallpaper of the wrong type", { wallpaper: { image: "clip.webm" } }, /is not an image/],
    ["a built-in wallpaper it does not have", { wallpaper: { kind: "image" } }, /wallpaper.kind is one of/],
    ["brightness out of range", { wallpaper: { kind: "mono", brightness: 2 } }, /brightness is from 0.4 to 1.1/],
    ["a sound of the wrong type", { sounds: { error: "wallpaper.webp" } }, /is not a sound/],
    ["a moment it does not have", { sounds: { hello: "sounds/needs.ogg" } }, /no moment hello/],
  ])("refuses %s, saying why", (_what, patch, why) => {
    expect(problem(theme(patch as Record<string, unknown>))).toMatch(why);
  });
});

describe("contrast", () => {
  const pal = FULL.palette;
  test.each([
    ["fg on bg", { fg: "#3a4652" }, /fg on bg is .*:1; it needs at least 4.5:1/],
    ["fg on bg2", { bg: "#000000", bg2: "#59636e", fg: "#c8ccd0" }, /fg on bg2 is .*:1; it needs at least 4.5:1/],
    ["fg2 on bg", { fg2: "#2c3a46" }, /fg2 on bg is .*:1; it needs at least 3:1/],
  ])("a theme whose %s is too low is refused, naming the pair", (_pair, patch, why) => {
    expect(problem(theme({ palette: { ...pal, ...patch } }))).toMatch(why);
  });

  test("a pair exactly at its floor passes", () => {
    // #767676 on white is 4.54:1, the lightest grey that reads as body text on white.
    expect(contrastRatio("#767676", "#ffffff")!).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#777777", "#ffffff")!).toBeLessThan(4.5);
  });

  test("a light theme passes the same pairs, and fails them the same way", () => {
    const light = theme({ mode: "light", palette: { ...CLEAN_LIGHT.palette }, accent: "graphite", wallpaper: { kind: "none" } });
    expect(problem(light)).toBeNull();
    expect(problem({ ...light, palette: { ...CLEAN_LIGHT.palette, fg: "oklch(0.75 0.006 250)" } })).toMatch(/fg on bg is .*:1/);
  });
});

describe("themeFromLook", () => {
  test("the look in use, from any preset, is a theme the check takes", () => {
    for (const p of Object.values(PRESETS)) {
      expect(checkTheme(themeFromLook(p.label, applyPreset(DEFAULT_APPEARANCE, p), {}), [])).toHaveProperty("theme");
    }
  });

  test("a picture wallpaper and a custom accent: the file is left for the author, the colours kept", () => {
    const a = { ...DEFAULT_APPEARANCE, wallpaper: { kind: "image" as const, imageSrc: "hivemedia://media/background-1.png", brightness: 0.7 } };
    const accent = { brand: "#c08552", accent: "#d9a273" };
    const t = themeFromLook("Mine", a, { accent });
    expect(t.wallpaper).toEqual({ kind: "mono", brightness: 0.7 });
    expect(t.accent).toEqual(accent);
    expect(JSON.stringify(t)).not.toContain("hivemedia");
  });
});
