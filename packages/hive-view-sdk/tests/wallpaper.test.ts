// A live wallpaper's side of protocol 1, against the fake host (the app's checks) over a real
// MessageChannel; the rules the app holds a wallpaper's answers to; its manifest; and the clock
// every live wallpaper runs on.
import { describe, expect, test } from "bun:test";
import {
  parseWallpaperHostMessage, sceneClock, validateWallpaperManifest, wallpaperRefusal,
  type WallpaperCreature,
} from "../src/wallpaper.js";
import { fakeWallpaperHost } from "../src/testing.js";

const creature = (id: string, state: WallpaperCreature["state"] = "working"): WallpaperCreature => ({ id, agent: "claude", kind: 0.3, size: 0.9, state });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a wallpaper's client", () => {
  test("holds what the app said and keeps it current, a late listener hearing the latest at once", async () => {
    const host = fakeWallpaperHost({ creatures: [creature("a")], tiles: [{ x0: 10, y0: 10, x1: 200, y1: 120, id: "a" }], mode: "still" });
    const wp = await host.connect();
    expect([wp.creatures.map((c) => c.id), wp.tiles.length, wp.mode]).toEqual([["a"], 1, "still"]);
    host.send({ type: "creatures", creatures: [creature("a", "needs-you"), creature("b")] });
    host.send({ type: "tiles", tiles: [], seeThrough: true });
    await host.settle();
    const heard: string[] = [];
    wp.on("creatures", (cs) => heard.push(cs.map((c) => `${c.id}:${c.state}`).join(",")));
    expect(heard).toEqual(["a:needs-you,b:working"]);
    expect([wp.tiles.length, wp.seeThrough]).toEqual([0, true]);
    expect(host.refused).toEqual([]);
  });

  test("says from its hit test which creature is under the pointer, once on each change and none off the water, and hears what a click opened", async () => {
    const host = fakeWallpaperHost({ creatures: [creature("a"), creature("b")] });
    const wp = await host.connect();
    wp.hitTest((x) => (x < 100 ? "a" : x < 200 ? "b" : null));
    const clicks: Array<string | null> = [];
    wp.on("click", ({ id }) => clicks.push(id));
    for (const [x, over] of [[50, true], [60, true], [150, true]] as const) host.point(x, 0, over);
    await host.settle();
    host.click(150, 0);
    host.point(300, 0);
    await host.settle();
    host.click(300, 0);
    host.point(300, 0, false);
    await host.settle();
    expect(host.received.filter((m) => m.type === "hover")).toEqual([{ type: "hover", id: "a" }, { type: "hover", id: "b" }, { type: "hover", id: null }]);
    expect(clicks).toEqual(["b", null]);
    expect(host.refused).toEqual([]);
  });

  test("names only a creature the app sent, and lets go of one that has gone", async () => {
    const host = fakeWallpaperHost({ creatures: [creature("a")] });
    const wp = await host.connect();
    let at = "a";
    wp.hitTest(() => at);
    host.point(1, 1);
    await host.settle();
    expect(host.hovered).toBe("a");
    // Its agent's tile closed: the app no longer knows it, and it says the pointer is over nothing.
    host.send({ type: "creatures", creatures: [] });
    await host.settle();
    expect(host.received.at(-1)).toEqual({ type: "hover", id: null });
    // A hit test that names something the app never sent says none, not a refusal.
    host.send({ type: "creatures", creatures: [creature("a")] });
    at = "made-up";
    host.point(2, 2);
    await host.settle();
    expect([host.hovered, host.refused]).toEqual([null, []]);
  });

  test("animate shows a first frame in every mode, says drawn once, and follows the app's mode", async () => {
    const host = fakeWallpaperHost({ creatures: [creature("a")], mode: "hold" });
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
    host.send({ type: "creatures", creatures: [creature("a", "resting")] });
    await host.settle();
    expect([steps, draws]).toEqual([720, 3]);
    host.send({ type: "mode", mode: "run" });
    await wait(400);
    expect(draws).toBeGreaterThan(3 + 5);
    stop();
    expect(host.received.filter((m) => m.type === "drawn")).toHaveLength(1);
  });
});

describe("what the app takes back from a wallpaper", () => {
  test.each([
    ["the pointer over a creature it was sent", { type: "hover", id: "a" }, null],
    ["the pointer over nothing", { type: "hover", id: null }, null],
    ["a creature it was never sent", { type: "hover", id: "b" }, /not a creature the app sent/],
  ] as const)("%s", (_name, m, expected) => {
    const why = wallpaperRefusal(m, new Set(["a"]));
    if (expected === null) expect(why).toBe(null);
    else expect(why).toMatch(expected);
  });
});

describe("what a wallpaper is told", () => {
  test.each([
    ["more creatures than the water holds", { type: "creatures", creatures: Array.from({ length: 9 }, (_, i) => creature(`c${i}`)) }],
    ["one creature twice", { type: "creatures", creatures: [creature("a"), creature("a")] }],
    ["a state that is not one", { type: "creatures", creatures: [{ ...creature("a"), state: "asleep" }] }],
    ["a colour that is not #rrggbb", { type: "look", look: { page: "red", text: "#ffffff", attention: "#ffaa00", dark: true, colour: false, mono: "monospace" } }],
  ])("drops %s", (_name, raw) => {
    expect(parseWallpaperHostMessage(raw).ok).toBe(false);
  });
});

describe("hivemind-wallpaper.json", () => {
  const base = { protocol: 1, name: "Bees", entry: "dist/index.html" };
  test("keeps what it may say", () => {
    const r = validateWallpaperManifest({ ...base, description: "A hive, one bee per agent.", colour: true, preview: "preview.webp" });
    expect(r).toEqual({ ok: true, manifest: { ...base, description: "A hive, one bee per agent.", colour: true, preview: "preview.webp" } });
  });
  test.each([
    ["a field it does not take", { ...base, permissions: ["workspace:spawn"] }, /no field "permissions"/],
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
