import { describe, expect, test } from "bun:test";
import { contrastRatio, cssColorToOklab, cssColorToRgb } from "./css-color";
import { accentMarkInk, checkTheme, statusInk, statusTextInk, themeFiles, themeFromLook, themeSwatches, type ThemeFolderFile } from "./theme-format";
import { ACCENTS, CLEAN_LIGHT, DEFAULT_APPEARANCE, PRESETS, SIGNAL, applyPreset, type AccentId } from "./settings-schema";
import type { AccentColors } from "./appearance-extra";

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
    ["an alpha as a fourth argument", { palette: { ...FULL.palette, line: "rgb(30, 40, 50, 0.2)" } }, /palette.line has transparency/],
    ["an alpha of 1", { accent: { brand: "rgb(192 133 82 / 1)", accent: "#d9a273" } }, /accent.brand has transparency/],
    ["a colour with a part too many", { palette: { ...FULL.palette, fg: "rgb(255 255 255 0)" } }, /palette.fg is not a colour/],
    ["a colour with something after it", { palette: { ...FULL.palette, bg: "#0e1a24 url(x)" } }, /palette.bg is not a colour/],
    ["a hue in a unit it does not take", { palette: { ...FULL.palette, fg: "oklch(0.95 0.01 230px)" } }, /palette.fg is not a colour/],
    ["an accent id it does not know", { accent: "teal" }, /accent is one of/],
    ["amber as the accent", { accent: "amber" }, /amber is the colour of an agent waiting on you/],
    ["the accent in the colour of needs you", { accent: { brand: SIGNAL.palette.warn, accent: "#d9a273" } }, /accent.brand is the colour of an agent waiting on you/],
    ["an accent too faint to see", { accent: { brand: "#16222c", accent: "#d9a273" } }, /accent.brand on bg2? is .*:1; .* needs at least 3:1/],
    ["a terminal without 16 colours", { terminal: { ...FULL.terminal, ansi: ["#000"] } }, /16 ANSI colours/],
    ["corners past 24", { radius: 40 }, /radius is from 0 to 24/],
    ["a font that is not woff2", { fonts: { ui: { family: "X", files: [{ path: "notes.txt" }] } } }, /is not a .woff2 font/],
    ["a font over 400 KB", { fonts: { ui: { family: "X", files: [{ path: "fonts/big.woff2" }] } } }, /is 500 KB; .* at most 400 KB/],
    ["a font family that could break out of CSS", { fonts: { ui: { family: "X'; } *{", files: [{ path: "fonts/display.woff2" }] } } }, /family is a font's name/],
    ["a font not in the folder", { fonts: { mono: { family: "X", files: [{ path: "fonts/gone.woff2" }] } } }, /there is no fonts\/gone.woff2/],
    ["a font kind it does not take", { fonts: { display: {} } }, /fonts is \{ ui\?, mono\? \}/],
    ["a file outside the folder", { wallpaper: { image: "../secret.png" } }, /not a path inside the theme's folder/],
    ["a file deeper than the app reads the folder", { wallpaper: { image: "a/b/c/d/e/still.webp" } }, /a\/b\/c\/d\/e\/still.webp is more than 4 folders deep/],
    ["a wallpaper of the wrong type", { wallpaper: { image: "clip.webm" } }, /is not an image/],
    ["a built-in wallpaper it does not have", { wallpaper: { kind: "image" } }, /wallpaper.kind is one of/],
    // A package's, which an app without the package would refuse the whole theme over.
    ["a live wallpaper", { wallpaper: { kind: "@dip497/live-scenes/shoal" } }, /wallpaper.kind is one of/],
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

  // A white page and panels, so each pair can be put a step either side of its floor.
  const white = { ...CLEAN_LIGHT.palette, bg: "#ffffff", bg2: "#ffffff", fg: "#000000", fg2: "#555555" };
  const onWhite = (palette: Record<string, string>, accent: unknown = "graphite") =>
    problem(theme({ mode: "light", palette: { ...white, ...palette }, accent, wallpaper: { kind: "none" } }));
  test.each([
    // #767676 on white is 4.54:1, the lightest grey that reads as body text; #777777 is 4.48:1
    // (said as 4.47, rounded down so a pair is never said to pass when it does not).
    ["fg on bg at 4.5:1", { fg: "#767676" }, { fg: "#777777" }, /fg on bg is 4.47:1/],
    // The page black, where both greys read: only the white panels hold them to the floor.
    ["fg on bg2 at 4.5:1", { bg: "#000000", fg2: "#949494", fg: "#767676" }, { bg: "#000000", fg2: "#949494", fg: "#777777" }, /fg on bg2 is 4.47:1/],
    // #949494 is 3.03:1, #959595 2.99:1.
    ["fg2 on bg at 3:1", { fg2: "#949494" }, { fg2: "#959595" }, /fg2 on bg is 2.99:1/],
  ])("%s: a step above the floor passes, a step below is refused", (_pair, above, below, why) => {
    expect(onWhite(above)).toBeNull();
    expect(onWhite(below)).toMatch(why);
  });

  // The accent is a mark on the page and on the panels and menus: a switch that is on, a slider's
  // thumb (ringed in bg2), the selected tile's handle. Each surface white in turn, the other black,
  // where #949494 and #959595 both read: only the white one holds the accent to 3:1.
  test.each([
    // bg3 black with bg2: a diff's +N/−N sit on both, and nothing reads on black and white at once.
    ["on the page (bg)", { bg2: "#000000", bg3: "#000000", fg: "#767676" }, /accent.brand on bg is 2.99:1/],
    ["on the panels and menus (bg2)", { bg: "#000000", fg: "#767676", fg2: "#949494" }, /accent.brand on bg2 is 2.99:1/],
  ])("an accent at 3:1 %s passes; a step below is refused, naming the surface", (_on, palette, why) => {
    expect(contrastRatio("#949494", "#ffffff")!).toBeGreaterThanOrEqual(3);
    expect(onWhite(palette, { brand: "#949494", accent: "#949494" })).toBeNull();
    expect(onWhite(palette, { brand: "#959595", accent: "#959595" })).toMatch(why);
  });

  test("a light theme passes the same pairs, and fails them the same way", () => {
    const light = theme({ mode: "light", palette: { ...CLEAN_LIGHT.palette }, accent: "graphite", wallpaper: { kind: "none" } });
    expect(problem(light)).toBeNull();
    expect(problem({ ...light, palette: { ...CLEAN_LIGHT.palette, fg: "oklch(0.75 0.006 250)" } })).toMatch(/fg on bg is .*:1/);
  });
});

describe("themeSwatches", () => {
  // Every look Settings ▸ Appearance shows a strip for: each preset, and a theme from a package.
  const looks = [...Object.values(PRESETS).map((p) => ({ name: p.id, palette: p.palette, accent: p.accent as AccentId | AccentColors })), { name: "a theme", palette: FULL.palette, accent: FULL.accent }];
  const lab = (c: string) => cssColorToOklab(c)!;

  test("a look's strip starts with its page, its text and its accent", () => {
    for (const l of looks) {
      const brand = typeof l.accent === "string" ? ACCENTS[l.accent].brand : l.accent.brand;
      expect({ look: l.name, first: themeSwatches(l).slice(0, 3) }).toEqual({ look: l.name, first: [l.palette.bg, l.palette.fg, brand] });
    }
  });

  test("no two of a strip's five colours look alike (0.05 apart in OKLab, as the app tells the accent from warn)", () => {
    for (const l of looks) {
      const s = themeSwatches(l);
      expect(s).toHaveLength(5);
      for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) {
        const [a, b] = [lab(s[i]!), lab(s[j]!)];
        expect({ look: l.name, pair: [i, j], apart: Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) >= 0.05 }).toEqual({ look: l.name, pair: [i, j], apart: true });
      }
    }
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

  test("a live wallpaper's look: the theme gets Mono in its place, and the check takes it", () => {
    const t = themeFromLook("Mine", { ...DEFAULT_APPEARANCE, wallpaper: { kind: "@acme/hive/bees", brightness: 0.85, colour: true } }, {});
    expect(t.wallpaper).toEqual({ kind: "mono", brightness: 0.85 });
    expect(checkTheme(t, [])).toHaveProperty("theme");
  });
});

describe("statusInk", () => {
  /** A package's palettes the presets do not cover: a dark one whose hover surface is pale, and a
   *  light one whose amber is drawn for white. */
  const PALETTES = {
    "pale dark": { ...PRESETS.dracula!.palette, bg2: "#363642", bg3: "#424250", bg4: "#50505e", err: "#ff2020", warn: "#ffcc00" },
    "bright light": { ...CLEAN_LIGHT.palette, bg2: "#ffffff", bg3: "#f0f0f0", bg4: "#dedede", err: "#ff6b6b", warn: "#ffd23f" },
  };
  const all = { ...PALETTES, ...Object.fromEntries(Object.entries(PRESETS).map(([id, p]) => [id, p.palette])) };
  const lch = (c: string) => { const [, a, b] = cssColorToOklab(c)!; return { h: (Math.atan2(b, a) * 180) / Math.PI, c: Math.hypot(a, b) }; };
  const chip = (c: string, under: string) => { const a = cssColorToRgb(c)!, b = cssColorToRgb(under)!; return `rgb(${a.map((x, i) => Math.round(x * 0.16 + b[i]! * 0.84)).join(" ")})`; };

  test("a chip's word reads on its own fill over the panel, and its mark on every row and header", () => {
    for (const [name, p] of Object.entries(all)) {
      for (const base of [p.err, p.warn]) {
        const ink = statusInk(base, p);
        expect({ name, base, word: contrastRatio(ink, chip(ink, p.bg2))! >= 4.5 && contrastRatio(ink, p.bg2)! >= 4.5 }).toEqual({ name, base, word: true });
        for (const row of [p.bg2, p.bg3, p.bg4]) expect({ name, base, row, mark: contrastRatio(ink, row)! >= 3 }).toEqual({ name, base, row, mark: true });
      }
    }
  });

  test("a status keeps its hue and at least half its chroma, so failed stays red in every preset", () => {
    for (const [name, { palette: p }] of Object.entries(PRESETS)) {
      for (const base of [p.err, p.warn]) {
        const before = lch(base), after = lch(statusInk(base, p));
        expect({ name, base, chroma: after.c >= before.c / 2 }).toEqual({ name, base, chroma: true });
        expect(Math.abs(((after.h - before.h + 540) % 360) - 180)).toBeLessThan(8);
      }
    }
  });

  test("a word straight on a header or a selected row reads on each", () => {
    for (const [name, p] of Object.entries(all)) {
      const ink = statusTextInk(p.err, p);
      for (const row of [p.bg2, p.bg3, p.bg4]) expect({ name, row, word: contrastRatio(ink, row)! >= 4.5 }).toEqual({ name, row, word: true });
    }
  });

  test("a colour that already reads is the palette's own", () => {
    expect(statusInk(SIGNAL.palette.warn, SIGNAL.palette)).toBe(SIGNAL.palette.warn);
  });

  test("a theme's accent may not be the needs-you colour as it is drawn, not only the palette's warn", () => {
    const p = PRESETS["solarized-dark"]!.palette;
    const drawn = statusInk(p.warn, p);
    expect(drawn).not.toBe(p.warn);
    const r = checkTheme({ ...FULL, palette: p, accent: { brand: drawn, accent: drawn } }, FILES);
    expect("problem" in r ? r.problem : "").toContain("waiting on you");
  });

  test("the accent's mark reads at 3:1 on the page, the panels and a header", () => {
    for (const [name, p] of Object.entries(all)) {
      for (const brand of ["#7c6aa8", "#3b82f6", "#9a9a9a"]) {
        const ink = accentMarkInk(brand, p);
        for (const on of [p.bg, p.bg2, p.bg3]) expect({ name, brand, on, mark: contrastRatio(ink, on)! >= 3 }).toEqual({ name, brand, on, mark: true });
      }
    }
  });
});
