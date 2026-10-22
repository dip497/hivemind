import { describe, expect, test } from "bun:test";
import { cssColorToHex, cssColorToRgb } from "./css-color";
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
