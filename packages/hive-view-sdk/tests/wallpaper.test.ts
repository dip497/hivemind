// A live wallpaper's side of protocol 2, against the fake host (the app's checks) over a real
// MessageChannel; what the app takes back from a wallpaper; its manifest; and the clock every live
// wallpaper runs on.
import { describe, expect, test } from "bun:test";
import { parseWallpaperHostMessage, parseWallpaperMessage, sceneClock, validateWallpaperManifest } from "../src/wallpaper.js";
import { fakeWallpaperHost } from "../src/testing.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a wallpaper's client", () => {
  test("holds what the app said and keeps it current, a late listener hearing the latest at once", async () => {
    const host = fakeWallpaperHost({ viewport: { w: 1000, h: 600, dpr: 2 }, mode: "still" });
    const wp = await host.connect();
    expect([wp.viewport, wp.mode, wp.look.dark]).toEqual([{ w: 1000, h: 600, dpr: 2 }, "still", true]);
    host.send({ type: "look", look: { page: "#ffffff", text: "#111111", dark: false, mono: "monospace" } });
    host.send({ type: "viewport", viewport: { w: 800, h: 500, dpr: 1 } });
    await host.settle();
    const heard: string[] = [];
    wp.on("look", (l) => heard.push(`dark ${l.dark}`));
    wp.on("viewport", (v) => heard.push(`${v.w}x${v.h}`));
    expect(heard).toEqual(["dark false", "800x500"]);
    expect(host.refused).toEqual([]);
  });

  test("hears the pointer over empty canvas and the clicks there, to play with", async () => {
    const host = fakeWallpaperHost();
    const wp = await host.connect();
    const heard: string[] = [];
    wp.on("pointer", ({ x, y, over }) => heard.push(`pointer ${x},${y}${over ? "" : " gone"}`));
    wp.on("click", ({ x, y }) => heard.push(`click ${x},${y}`));
    host.point(50, 60);
    host.click(50, 60);
    host.point(50, 60, false);
    await host.settle();
    expect(heard).toEqual(["pointer 50,60", "click 50,60", "pointer 50,60 gone"]);
    // It answers nothing: what it does with them is its own scene's.
    expect(host.received.map((m) => m.type)).toEqual(["ready"]);
  });

  test("animate shows a first frame in every mode, says drawn once, and follows the app's mode", async () => {
    const host = fakeWallpaperHost({ mode: "hold" });
    const wp = await host.connect();
    let steps = 0;
    let draws = 0;
    const stop = wp.animate({ step: () => { steps++; }, draw: () => { draws++; } });
    await host.settle();
    expect([steps, draws, host.drawn]).toEqual([0, 1, true]);
    host.send({ type: "mode", mode: "still" });
    await host.settle();
    expect([steps, draws]).toEqual([360, 2]);
    // Still: drawn again, settled, when what it shows changes.
    host.send({ type: "viewport", viewport: { w: 640, h: 480, dpr: 1 } });
    await host.settle();
    expect([steps, draws]).toEqual([720, 3]);
    host.send({ type: "mode", mode: "run" });
    await wait(400);
    expect(draws).toBeGreaterThan(3 + 5);
    stop();
    expect(host.received.filter((m) => m.type === "drawn")).toHaveLength(1);
  });
});

describe("what a wallpaper may say", () => {
  test.each([
    ["ready", { type: "ready", protocol: 2 }, true],
    ["drawn", { type: "drawn" }, true],
    // Protocol 1's: a wallpaper names no creature now.
    ["hover", { type: "hover", id: "a" }, false],
    // The app reads every message it is sent: what it does not take is refused, not carried.
    ["ready with more", { type: "ready", protocol: 2, padding: "x" }, false],
    ["drawn with more", { type: "drawn", frame: 1 }, false],
  ] as const)("%s", (_name, raw, ok) => {
    expect(parseWallpaperMessage(raw).ok).toBe(ok);
  });

  test("a type it does not know is quoted short, its controls and bidi characters escaped", () => {
    const r = parseWallpaperMessage({ type: `\u202eevil\u2028${"x".repeat(5000)}` });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason.length).toBeLessThan(80);
    expect(r.reason).toContain("\\u202eevil\\u2028");
    expect(r.reason).not.toMatch(/[\u202e\u2028]/);
  });
});

describe("what a wallpaper is told", () => {
  test.each([
    ["a colour that is not #rrggbb", { type: "look", look: { page: "red", text: "#ffffff", dark: true, mono: "monospace" } }],
    ["a look without its font", { type: "look", look: { page: "#000000", text: "#ffffff", dark: true } }],
    ["a pixel ratio of nothing", { type: "viewport", viewport: { w: 100, h: 100, dpr: 0 } }],
    ["a click with no place", { type: "click", x: 1 }],
  ])("drops %s", (_name, raw) => {
    expect(parseWallpaperHostMessage(raw).ok).toBe(false);
  });
});

describe("hivemind-wallpaper.json", () => {
  const base = { protocol: 2, name: "Bees", entry: "dist/index.html" };
  test("keeps what it may say", () => {
    const r = validateWallpaperManifest({ ...base, description: "A meadow and a hive, bees about it.", preview: "preview.webp" });
    expect(r).toEqual({ ok: true, manifest: { ...base, description: "A meadow and a hive, bees about it.", preview: "preview.webp" } });
  });
  test.each([
    ["a field it does not take", { ...base, permissions: ["workspace:spawn"] }, /no field "permissions"/],
    // Protocol 1's: a wallpaper is always in its own colours now.
    ["a Colour switch", { ...base, colour: true }, /no field "colour"/],
    ["an entry outside its folder", { ...base, entry: "../x/index.html" }, /"entry"/],
    ["an entry that is not a page or a script", { ...base, entry: "index.php" }, /"entry"/],
    ["a preview that is not a picture", { ...base, preview: "preview.svg" }, /"preview"/],
    ["no name", { protocol: 1, entry: "main.js" }, /"name"/],
  ])("refuses %s", (_name, raw, why) => {
    const r = validateWallpaperManifest(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("; ")).toMatch(why);
  });
});

describe("the clock", () => {
  test("moves the scene on 60 steps a second, draws at most 30 frames a second, and nothing while held", async () => {
    let steps = 0;
    let draws = 0;
    const clock = sceneClock({ step: () => { steps++; }, draw: () => { draws++; } });
    clock.setMode("run");
    const t0 = performance.now();
    await wait(600);
    clock.setMode("hold");
    const ran = (performance.now() - t0) / 1000;
    expect(draws).toBeLessThanOrEqual(Math.ceil(ran * 30) + 1);
    expect(draws).toBeGreaterThan(ran * 30 * 0.5);
    expect(Math.abs(steps - ran * 60)).toBeLessThan(ran * 60 * 0.35);
    const [s, d] = [steps, draws];
    await wait(200);
    expect([steps, draws]).toEqual([s, d]);
  });
});
