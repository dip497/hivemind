// The host end of a live wallpaper against the SDK's own client, over a real MessageChannel: what
// the wallpaper is told and when, what the app takes back, and when it turns a wallpaper off.
import { describe, expect, test } from "bun:test";
import { connectWallpaper, PORT_HANDSHAKE, type WallpaperCreature, type WallpaperHostMessage } from "@hivemind/view-sdk";
import { WALLPAPER_LIMITS, WallpaperLink, type WallpaperScene } from "../src/wallpaper-link.js";

const creature = (id: string, state: WallpaperCreature["state"] = "working"): WallpaperCreature => ({ id, agent: "claude", kind: 0.5, size: 1, state });
const scene = (over: Partial<WallpaperScene> = {}): WallpaperScene => ({
  viewport: { w: 1200, h: 800, dpr: 1 }, mode: "run", creatures: [creature("a")], tiles: [], seeThrough: false,
  look: { page: "#101418", text: "#e6edf3", attention: "#e3b341", dark: true, colour: false, mono: "monospace" }, ...over,
});
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };

/** A link and the SDK's client on the two ends of one channel, and what the client heard. */
async function linked(over: Partial<WallpaperScene> = {}) {
  const events = { drawn: 0, hovers: [] as Array<string | null>, off: null as string | null };
  const link = new WallpaperLink({ onDrawn: () => events.drawn++, onHover: (id) => events.hovers.push(id), onDisable: (why) => { events.off = why; } }, scene(over));
  const ch = new MessageChannel();
  const heard: WallpaperHostMessage[] = [];
  // Every message the frame's end receives, before the client reads it.
  ch.port2.addEventListener("message", (e) => heard.push(e.data as WallpaperHostMessage));
  link.attach(ch.port1 as unknown as Parameters<WallpaperLink["attach"]>[0]);
  const target = new EventTarget();
  const client = connectWallpaper({ target: target as unknown as Window, timeoutMs: 2000 });
  target.dispatchEvent(new MessageEvent("message", { data: { type: PORT_HANDSHAKE }, ports: [ch.port2] }));
  const wp = await client;
  return { link, wp, events, heard, raw: ch.port2 };
}

describe("a live wallpaper's link", () => {
  test("tells it everything at once when it is ready, then each change once, the same thing never again", async () => {
    const { link, wp, heard } = await linked();
    expect([wp.creatures.map((c) => c.id), wp.mode, wp.viewport.w]).toEqual([["a"], "run", 1200]);
    link.setCreatures([creature("a")]);
    link.setMode("run");
    link.setTiles([{ x0: 0, y0: 0, x1: 100, y1: 80, id: "a" }], true);
    link.setTiles([{ x0: 0, y0: 0, x1: 100, y1: 80, id: "a" }], true);
    link.setCreatures([creature("a", "needs-you")]);
    link.done("a");
    await settle();
    expect(heard.map((m) => m.type)).toEqual(["hello", "tiles", "creatures", "done"]);
    expect([wp.tiles.length, wp.seeThrough, wp.creatures[0]?.state]).toEqual([1, true, "needs-you"]);
  });

  test("shows the creature under the pointer, opens it on a click, and lets go of it when its agent goes", async () => {
    const { link, wp, events } = await linked({ creatures: [creature("a"), creature("b")] });
    wp.hitTest((x) => (x < 100 ? "a" : null));
    const clicks: Array<string | null> = [];
    wp.on("click", ({ id }) => clicks.push(id));
    link.pointer(50, 10, true);
    await settle();
    expect(link.click(50, 10)).toBe("a");
    link.pointer(500, 10, true);
    await settle();
    expect(link.click(500, 10)).toBe(null);
    link.pointer(50, 10, true);
    await settle();
    link.setCreatures([creature("b")]);
    await settle();
    expect(events.hovers).toEqual(["a", null, "a", null]);
    expect(clicks).toEqual(["a", null]);
    expect(events.off).toBe(null);
  });

  test("when an agent goes, its name stops showing whatever the wallpaper says, and an answer about it already on its way is not held against it", async () => {
    const { link, raw, events } = await linked({ creatures: [creature("a")] });
    // A wallpaper of its own making, not the SDK's: it never says the creature went.
    raw.onmessage = null;
    raw.postMessage({ type: "hover", id: "a" });
    await settle();
    link.setCreatures([]);
    expect(events.hovers).toEqual(["a", null]);
    // Sent before the wallpaper heard that "a" went.
    for (let i = 0; i < WALLPAPER_LIMITS.refused; i++) raw.postMessage({ type: "hover", id: "a" });
    await settle();
    expect([events.off, events.hovers]).toEqual([null, ["a", null]]);
  });

  test.each([
    ["names a creature it was never sent, again and again", (p: MessagePort) => { for (let i = 0; i < WALLPAPER_LIMITS.refused; i++) p.postMessage({ type: "hover", id: "zz" }); }, /malformed or refused messages \(last: hover: "zz" is not a creature/],
    ["sends what is no message", (p: MessagePort) => { for (let i = 0; i < WALLPAPER_LIMITS.refused; i++) p.postMessage({ type: "spawn" }); }, /unknown message type "spawn"/],
    ["floods the app", (p: MessagePort) => { for (let i = 0; i <= WALLPAPER_LIMITS.messagesPerSecond; i++) p.postMessage({ type: "hover", id: null }); }, /more than 120 messages a second/],
  ])("is turned off when it %s, and is sent nothing after", async (_name, misbehave, why) => {
    const { link, raw, events, heard } = await linked();
    misbehave(raw);
    await settle();
    expect(events.off).toMatch(why);
    const before = heard.length;
    link.setMode("still");
    link.done("a");
    await settle();
    expect(heard.length).toBe(before);
  });

  test("a wallpaper that needs a newer protocol is turned off before it is told anything", async () => {
    const events = { off: null as string | null };
    const link = new WallpaperLink({ onDrawn: () => {}, onHover: () => {}, onDisable: (why) => { events.off = why; } }, scene());
    const ch = new MessageChannel();
    const heard: unknown[] = [];
    ch.port2.onmessage = (e) => heard.push(e.data);
    link.attach(ch.port1 as unknown as Parameters<WallpaperLink["attach"]>[0]);
    ch.port2.postMessage({ type: "ready", protocol: 2 });
    await settle();
    expect([events.off, heard]).toEqual(["it needs live wallpaper protocol 2; this Hivemind has 1", []]);
  });
});
