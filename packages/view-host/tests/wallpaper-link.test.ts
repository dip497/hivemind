// The host end of a live wallpaper against the SDK's own client, over a real MessageChannel: what
// the wallpaper is told and when, what the app takes back, and when it turns a wallpaper off.
import { describe, expect, test } from "bun:test";
import { connectWallpaper, PORT_HANDSHAKE, type WallpaperHostMessage } from "@hivemind/view-sdk";
import { WALLPAPER_LIMITS, WallpaperLink, type WallpaperScene } from "../src/wallpaper-link.js";

const scene = (over: Partial<WallpaperScene> = {}): WallpaperScene => ({
  viewport: { w: 1200, h: 800, dpr: 1 }, mode: "run",
  look: { page: "#101418", text: "#e6edf3", dark: true, mono: "monospace" }, ...over,
});
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };

/** A link and the SDK's client on the two ends of one channel, and what the client heard. */
async function linked(over: Partial<WallpaperScene> = {}) {
  const events = { drawn: 0, off: null as string | null };
  const link = new WallpaperLink({ onDrawn: () => events.drawn++, onDisable: (why) => { events.off = why; } }, scene(over));
  const ch = new MessageChannel();
  const heard: WallpaperHostMessage[] = [];
  // Every message the frame's end receives, before the client reads it.
  ch.port2.addEventListener("message", (e) => heard.push(e.data as WallpaperHostMessage));
  link.attach(ch.port1);
  const target = new EventTarget();
  const client = connectWallpaper({ target: target as unknown as Window, timeoutMs: 2000 });
  target.dispatchEvent(new MessageEvent("message", { data: { type: PORT_HANDSHAKE }, ports: [ch.port2] }));
  const wp = await client;
  return { link, wp, events, heard, raw: ch.port2 };
}

describe("a live wallpaper's link", () => {
  test("tells it everything at once when it is ready, then each change once, the same thing never again", async () => {
    const { link, wp, heard } = await linked();
    expect([wp.mode, wp.viewport.w, wp.look.dark]).toEqual(["run", 1200, true]);
    link.setMode("run");
    link.setViewport({ w: 1200, h: 800, dpr: 1 });
    link.setViewport({ w: 900, h: 700, dpr: 2 });
    link.setViewport({ w: 900, h: 700, dpr: 2 });
    link.setLook({ page: "#ffffff", text: "#111111", dark: false, mono: "monospace" });
    await settle();
    expect(heard.map((m) => m.type)).toEqual(["hello", "viewport", "look"]);
    expect([wp.viewport, wp.look.dark]).toEqual([{ w: 900, h: 700, dpr: 2 }, false]);
  });

  test("passes it the pointer over empty canvas and the clicks there, to play with", async () => {
    const { link, wp } = await linked();
    const said: string[] = [];
    wp.on("pointer", ({ x, y, over }) => said.push(`pointer ${x},${y} ${over}`));
    wp.on("click", ({ x, y }) => said.push(`click ${x},${y}`));
    link.pointer(50, 10, true);
    link.click(50, 10);
    link.pointer(50, 10, false);
    await settle();
    expect(said).toEqual(["pointer 50,10 true", "click 50,10", "pointer 50,10 false"]);
  });

  test("says when its first frame is up, and takes nothing else from it", async () => {
    const { wp, events, raw } = await linked();
    wp.drawn();
    await settle();
    expect(events.drawn).toBe(1);
    // A wallpaper of its own making, not the SDK's: what protocol 1 let it say is now no message.
    raw.postMessage({ type: "hover", id: "a" });
    await settle();
    expect(events.off).toBe(null);
  });

  test.each([
    ["sends what is no message", (p: MessagePort) => { for (let i = 0; i < WALLPAPER_LIMITS.refused; i++) p.postMessage({ type: "spawn" }); }, /8 malformed messages \(last: unknown message type "spawn"\)/],
    ["says what protocol 1 let it say", (p: MessagePort) => { for (let i = 0; i < WALLPAPER_LIMITS.refused; i++) p.postMessage({ type: "hover", id: "a" }); }, /unknown message type "hover"/],
    ["floods the app", (p: MessagePort) => { for (let i = 0; i <= WALLPAPER_LIMITS.messagesPerSecond; i++) p.postMessage({ type: "drawn" }); }, /more than 120 messages a second/],
  ])("is turned off when it %s, and is sent nothing after", async (_name, misbehave, why) => {
    const { link, raw, events, heard } = await linked();
    misbehave(raw);
    await settle();
    expect(events.off).toMatch(why);
    const before = heard.length;
    link.setMode("still");
    link.click(1, 1);
    await settle();
    expect(heard.length).toBe(before);
  });

  test("a wallpaper that needs a newer protocol is turned off before it is told anything", async () => {
    const events = { off: null as string | null };
    const link = new WallpaperLink({ onDrawn: () => {}, onDisable: (why) => { events.off = why; } }, scene());
    const ch = new MessageChannel();
    const heard: unknown[] = [];
    ch.port2.onmessage = (e) => heard.push(e.data);
    link.attach(ch.port1);
    ch.port2.postMessage({ type: "ready", protocol: 3 });
    await settle();
    expect([events.off, heard]).toEqual(["it needs live wallpaper protocol 3; this Hivemind has 2", []]);
  });
});
