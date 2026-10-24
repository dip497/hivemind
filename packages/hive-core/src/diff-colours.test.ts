import { describe, expect, test } from "bun:test";
import { contrastRatio } from "./css-color";
import { diffColours, diffContrastProblem, diffPairs } from "./diff-colours";
import { checkTheme } from "./theme-format";
import { PRESETS, SIGNAL, type Palette } from "./settings-schema";

const low = (p: Palette, mode: "dark" | "light") => diffPairs(p, mode).filter((x) => x.ratio < x.least).map((x) => `${x.ink} on ${x.on}: ${x.ratio.toFixed(2)}:1`);
const theme = (mode: "dark" | "light", palette: Palette) => checkTheme({ format: 1, name: "T", mode, palette, accent: mode === "light" ? "graphite" : "ice" }, []);

describe("a diff's colours", () => {
  test("every word, count, line number and bar stripe a diff draws reads in every built-in preset", () => {
    for (const p of Object.values(PRESETS)) expect({ id: p.id, low: low(p.palette, p.mode) }).toEqual({ id: p.id, low: [] });
  });

  test("a theme's page moves them until they read, so a theme that reads elsewhere is not refused for its diff", () => {
    // Solarized Light: its fg2 (#586e75) reads 4.39:1 on its own bg2 and less on a changed row,
    // Monokai's red 3.9:1 on its bg3 at the lightness a preset's is held to.
    const solarizedLight: Palette = { ...SIGNAL.palette, bg: "#fdf6e3", bg2: "#eee8d5", bg3: "#e6dfc8", bg4: "#ddd6c1", fg: "#073642", fg2: "#586e75", fg3: "#657b83", ok: "#859900", warn: "#b58900", err: "#dc322f" };
    const monokai: Palette = { ...SIGNAL.palette, bg: "#1e1f1c", bg2: "#272822", bg3: "#3e3d32", fg: "#f8f8f2", fg2: "#cfcfc2", ok: "#a6e22e", err: "#f92672" };
    for (const [mode, p] of [["light", solarizedLight], ["dark", monokai]] as const) {
      expect(low(p, mode)).toEqual([]);
      expect("theme" in theme(mode, p)).toBe(true);
    }
  });

  test("the colours the app paints read where they are drawn flat: text, comments and syntax on the page, the +N/−N on it and on the Diff tile's header", () => {
    // Worked out again from the painted values, not from the pair list, so a pair the list left out
    // fails here.
    const looks: [string, "dark" | "light", Palette][] = [
      ...Object.values(PRESETS).map((p) => [p.id, p.mode, p.palette] as [string, "dark" | "light", Palette]),
      ["monokai", "dark", { ...SIGNAL.palette, bg: "#1e1f1c", bg2: "#272822", bg3: "#3e3d32", fg: "#f8f8f2", fg2: "#cfcfc2", ok: "#a6e22e", err: "#f92672" }],
    ];
    for (const [id, mode, p] of looks) {
      const c = diffColours(p, mode);
      const flat = Object.entries(c).filter(([k]) => /^--color-(syntax-|diff-(text|number)$)/.test(k)).map(([k, v]) => [k, v, "bg2"]);
      for (const k of ["--color-diff-added", "--color-diff-removed"]) flat.push([k, c[k]!, "bg2"], [k, c[k]!, "bg3"]);
      const low = flat.map(([k, v, on]) => [k, on, contrastRatio(v!, p[on as "bg2" | "bg3"])!] as const).filter(([, , r]) => r < 4.5);
      expect({ id, low }).toEqual({ id, low: [] });
    }
  });

  test("a theme whose page no diff can be read on is refused, naming what does not read", () => {
    // White text on a mid grey reads 5.7:1, but a folded run's bar is lighter still, and nothing
    // a diff writes on it reaches 4.5:1.
    const grey: Palette = { ...SIGNAL.palette, bg: "#3a3a3a", bg2: "#666666", bg3: "#666666", fg: "#ffffff", fg2: "#e6e6e6" };
    expect(diffContrastProblem(grey, "dark")).toContain("folded run's bar");
    const r = theme("dark", grey);
    expect("problem" in r && r.problem).toContain("a diff's");
  });
});
