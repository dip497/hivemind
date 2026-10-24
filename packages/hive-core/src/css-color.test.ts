import { describe, expect, test } from "bun:test";
import { cssColorToHex, cssColorToRgb, parseCssColor } from "./css-color";
import { PRESETS } from "./settings-schema";

describe("cssColorToRgb", () => {
  test("reads hex in its short and long forms, alpha ignored", () => {
    expect(cssColorToRgb("#0d0e12")).toEqual([13, 14, 18]);
    expect(cssColorToRgb("#FFF")).toEqual([255, 255, 255]);
    expect(cssColorToRgb("#1e1f29cc")).toEqual([30, 31, 41]);
  });

  test("reads rgb() with commas or spaces, and percentages", () => {
    expect(cssColorToRgb("rgb(255, 0, 128)")).toEqual([255, 0, 128]);
    expect(cssColorToRgb("rgba(10 20 30 / 0.5)")).toEqual([10, 20, 30]);
    expect(cssColorToRgb("rgb(100% 0% 50%)")).toEqual([255, 0, 128]);
  });

  test("converts oklch to sRGB: black, white, and a known mid colour", () => {
    expect(cssColorToRgb("oklch(0 0 0)")).toEqual([0, 0, 0]);
    expect(cssColorToRgb("oklch(1 0 0)")).toEqual([255, 255, 255]);
    // oklch(62.8% 0.2577 29.23) is sRGB red, #ff0000, to within a step of rounding.
    const red = cssColorToRgb("oklch(62.8% 0.2577 29.23)")!;
    expect(red[0]).toBeGreaterThanOrEqual(254);
    expect(red[1]).toBeLessThanOrEqual(2);
    expect(red[2]).toBeLessThanOrEqual(2);
  });

  test("gives null for what it cannot read", () => {
    for (const v of ["", "red", "#12", "hsl(0 0% 0%)", "oklch(a b c)", "rgb(1 2)"]) expect(cssColorToRgb(v)).toBeNull();
  });

  test("gives null for what CSS paints differently or not at all", () => {
    for (const v of [
      "rgb(1 2 3 4)", "rgb(1, 2, 3, 4, 5)", "oklch(0.5 0.1 30 40)", // a part too many
      "rgb(1 2 3) red", "oklch(0.5 0.1 30)x", "#fffz", "rgb(1 2 3 / 0.5 / 1)", // something after it
      "rgb(1, 2 3)", "rgb(10, 20%, 30)", "rgb(1px 2 3)", "oklch(0.5 0.1 30px)", "oklch(50deg 0.1 30)", // a unit it does not take
      "rgb(1 2 3 /)", "rgb(1 2 3 / x)", "oklch(0.5, 0.1, 30)", // an alpha or a separator it does not take
    ]) expect([v, cssColorToRgb(v)]).toEqual([v, null]);
  });

  test("reads a long hostile value in one pass: a theme's colour cannot stall main or the hub", () => {
    // Spaces with no closing bracket took cubic time and a run of digits that is not a number
    // quadratic: these two took 1.3 s together (5,000 spaces took 28 s); now under a millisecond.
    const hostile = ["rgb(" + " ".repeat(2000), `oklch(${"1".repeat(20_000)}x 0 0)`];
    const started = performance.now();
    for (const v of hostile) expect([v.slice(0, 12), cssColorToRgb(v)]).toEqual([v.slice(0, 12), null]);
    expect(performance.now() - started).toBeLessThan(250);
    expect(cssColorToRgb("rgb(   1 2 3   )")).toEqual([1, 2, 3]);
  });

  test("reads a hue in each unit CSS allows; a bare number is degrees", () => {
    const deg = cssColorToRgb("oklch(0.6 0.15 180)");
    for (const h of ["180deg", "3.14159265rad", "200grad", "0.5turn"]) expect(cssColorToRgb(`oklch(0.6 0.15 ${h})`)).toEqual(deg);
    expect(cssColorToRgb("oklch(0.6 0.15 3rad)")).not.toEqual(cssColorToRgb("oklch(0.6 0.15 3)"));
  });

  test("says when a colour carries an alpha, in every way CSS writes one", () => {
    for (const v of ["#fff8", "#ffffff80", "rgba(1, 2, 3, 1)", "rgb(1, 2, 3, 0.5)", "rgb(1 2 3 / 50%)", "oklch(0.5 0.1 30 / 1)"]) expect([v, parseCssColor(v)?.alpha]).toEqual([v, true]);
    for (const v of ["#fff", "rgb(1, 2, 3)", "rgba(1 2 3)", "oklch(0.5 0.1 30)"]) expect([v, parseCssColor(v)?.alpha]).toEqual([v, false]);
  });
});

describe("cssColorToHex", () => {
  test("every preset's background reads as a dark or light hex, never the fallback", () => {
    for (const p of Object.values(PRESETS)) {
      const hex = cssColorToHex(p.palette.bg, "fallback");
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
      const [r, g, b] = cssColorToRgb(hex)!;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (p.mode === "light") expect(luma).toBeGreaterThan(200);
      else expect(luma).toBeLessThan(60);
    }
  });
});
