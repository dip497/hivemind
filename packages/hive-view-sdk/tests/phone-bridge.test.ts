// The phone's bridge (crates/hive-phone/src/view_bridge.js), the script its app runs at the start of
// a view's page, with this SDK's own `connect`: it hands the view its port once the page has loaded,
// as the computer's windows do, and relays it to the app as JSON text both ways, through the `hive`
// the app gives the page: Android's web message listener (told through `hive.onmessage`), or iOS's
// script message handler (told through `__hive.said`).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { connect } from "../src/client.js";

const BRIDGE = readFileSync(new URL("../../../crates/hive-phone/src/view_bridge.js", import.meta.url), "utf8");

type Platform = "android" | "ios";
const HELLO = {
  type: "hello", v: 1, pluginId: "board", capabilities: [], theme: { colors: { bg: "#000000" } }, layout: null,
  viewport: { w: 390, h: 844 }, visible: true, device: { touch: true, compact: true },
};
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A view's page in the phone's web view: the window the bridge runs in, with the app's `hive` as
 *  `platform` gives it; what the page posted to the app, as the app gets it; and the app saying
 *  what the view's host said, as `platform` does. */
function page(platform: Platform, readyState: "loading" | "complete" = "loading") {
  const win = new EventTarget() as EventTarget & Record<string, unknown>;
  const posted: unknown[] = [];
  const hive: { postMessage(text: unknown): void; onmessage?: (e: { data: unknown }) => void } = { postMessage: (text) => posted.push(text) };
  if (platform === "ios") win.webkit = { messageHandlers: { hive } };
  else win.hive = hive;
  win.postMessage = (data: unknown, _origin: string, transfer: MessagePort[] = []) =>
    setTimeout(() => win.dispatchEvent(new MessageEvent("message", { data, ports: transfer })), 0);
  new Function("window", "document", BRIDGE)(win, { readyState });
  const say = (text: string) =>
    platform === "ios" ? (win.__hive as { said(text: string): void }).said(text) : hive.onmessage?.({ data: text });
  return { target: win as unknown as Window, posted, say, load: () => win.dispatchEvent(new Event("load")) };
}

/** The view connected on `p` as its host would have it: `ready` heard, `hello` said. */
async function connected(p: ReturnType<typeof page>) {
  const pending = connect({ target: p.target, timeoutMs: 2000 });
  p.load();
  for (let i = 0; i < 100 && p.posted.length === 0; i++) await tick();
  p.say(JSON.stringify(HELLO));
  return pending;
}

for (const platform of ["android", "ios"] as const) {
  describe(`on ${platform}`, () => {
    test("the view takes its port once the page has loaded; what it posts reaches the app as JSON text, and what the app says reaches it", async () => {
      const p = page(platform);
      const client = await connected(p);
      expect(p.posted.map((t) => JSON.parse(t as string))).toEqual([{ type: "ready", v: 1 }]);
      expect(typeof p.posted[0]).toBe("string");
      expect(client.hello.pluginId).toBe("board");
      expect(client.viewport).toEqual({ w: 390, h: 844 });

      client.commands.selectTile("t1");
      for (let i = 0; i < 100 && p.posted.length < 2; i++) await tick();
      expect(JSON.parse(p.posted[1] as string)).toEqual({ type: "command", name: "selectTile", args: ["t1"] });

      const tiles: number[] = [];
      client.on("structure", (m) => tiles.push(m.tiles.length));
      p.say("not JSON");
      p.say(JSON.stringify({ type: "structure", frames: [], tiles: [{ id: "t1", frameId: null, kind: "agent", name: "Priya's agent" }] }));
      for (let i = 0; i < 100 && tiles.length === 0; i++) await tick();
      expect(tiles).toEqual([1]);
    });

    test("nothing is handed the view before its page has loaded; a page loaded already is handed it at once", async () => {
      const loading = page(platform);
      let handed = false;
      loading.target.addEventListener("message", () => { handed = true; });
      for (let i = 0; i < 20; i++) await tick();
      expect(handed).toBe(false);
      loading.load();
      for (let i = 0; i < 20 && !handed; i++) await tick();
      expect(handed).toBe(true);

      const loaded = page(platform, "complete");
      const client = connect({ target: loaded.target, timeoutMs: 2000 });
      for (let i = 0; i < 100 && loaded.posted.length === 0; i++) await tick();
      loaded.say(JSON.stringify(HELLO));
      expect((await client).hello.pluginId).toBe("board");
    });
  });
}
