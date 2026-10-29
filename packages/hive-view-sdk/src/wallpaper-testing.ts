/**
 * A host for a live wallpaper's own tests, and for `hive plugins check`: no app and no window. It
 * hands the wallpaper its port and hello, sends what the test scripts, and checks every answer as
 * the app does (`parseWallpaperMessage`, then `wallpaperRefusal`), keeping it for the test to read.
 *
 *   import { fakeWallpaperHost } from "@hivemind/view-sdk/testing";
 *
 *   const host = fakeWallpaperHost({ creatures: [{ id: "a", agent: "claude", kind: 0.2, size: 1, state: "needs-you" }] });
 *   const wp = await host.connect();            // or host.handshake(window) before the page's connectWallpaper()
 *   host.send({ type: "mode", mode: "run" });
 *   host.point(120, 80);                        // the pointer over empty canvas
 *   await host.settle();
 *   host.hovered;                               // the creature it says is there: what a click would open
 *   host.refused;                               // what the app would have refused, and why
 */
import { connectWallpaper, type WallpaperClient } from "./wallpaper-client.js";
import {
  WALLPAPER_PROTOCOL, parseWallpaperMessage, wallpaperRefusal,
  type WallpaperCreature, type WallpaperHostMessage, type WallpaperLook, type WallpaperMessage, type WallpaperMode, type WallpaperTile, type WallpaperViewport,
} from "./wallpaper.js";
import { PORT_HANDSHAKE } from "./protocol.js";

export interface FakeWallpaperOptions {
  viewport?: WallpaperViewport;
  look?: Partial<WallpaperLook>;
  mode?: WallpaperMode;
  creatures?: WallpaperCreature[];
  tiles?: WallpaperTile[];
  seeThrough?: boolean;
}

export interface FakeWallpaperHost {
  /** Everything the wallpaper sent that parsed, in order. */
  readonly received: WallpaperMessage[];
  /** What the app would have refused, and why: [] for a wallpaper that behaves. */
  readonly refused: string[];
  /** Whether it said its first frame is up. */
  readonly drawn: boolean;
  /** The creature it last said is under the pointer: what a click there opens. */
  readonly hovered: string | null;
  /** Hand the port to a page that calls `connectWallpaper()` itself. */
  handshake(target: EventTarget): void;
  /** Connect a client here, as a test of the wallpaper's own code does. */
  connect(o?: { timeoutMs?: number }): Promise<WallpaperClient>;
  /** Send a message, as the app would; `creatures` changes which ids it takes back. */
  send(m: WallpaperHostMessage): void;
  /** The pointer over empty canvas at a point, or gone from it (`over` false). */
  point(x: number, y: number, over?: boolean): void;
  /** A click on empty canvas at a point, as the app sends it: with the creature it opened, the one
   *  the wallpaper last said is under the pointer. Returns that creature, or null. */
  click(x: number, y: number): string | null;
  /** Let messages land. */
  settle(): Promise<void>;
  close(): void;
}

const LOOK: WallpaperLook = { page: "#101418", text: "#e6edf3", attention: "#e3b341", dark: true, colour: false, mono: "monospace" };

export function fakeWallpaperHost(opts: FakeWallpaperOptions = {}): FakeWallpaperHost {
  const channel = new MessageChannel();
  const port = channel.port1;
  let creatures = new Set((opts.creatures ?? []).map((c) => c.id));
  const state = { received: [] as WallpaperMessage[], refused: [] as string[], drawn: false, hovered: null as string | null };
  const post = (m: WallpaperHostMessage) => port.postMessage(m);

  port.onmessage = (e) => {
    const r = parseWallpaperMessage(e.data);
    if (!r.ok) { state.refused.push(r.reason); return; }
    const m = r.msg;
    const why = wallpaperRefusal(m, creatures);
    if (why) { state.refused.push(why); return; }
    state.received.push(m);
    switch (m.type) {
      case "ready":
        if (m.protocol > WALLPAPER_PROTOCOL) { state.refused.push(`ready: it speaks live wallpaper protocol ${m.protocol}; this host ${WALLPAPER_PROTOCOL}`); return; }
        post({
          type: "hello", protocol: WALLPAPER_PROTOCOL, viewport: opts.viewport ?? { w: 1280, h: 800, dpr: 1 }, look: { ...LOOK, ...opts.look },
          mode: opts.mode ?? "hold", creatures: opts.creatures ?? [], tiles: opts.tiles ?? [], seeThrough: opts.seeThrough ?? false,
        });
        return;
      case "drawn": state.drawn = true; return;
      case "hover": state.hovered = m.id; return;
    }
  };
  port.start();

  // From the page it is framed in, as the app's handshake is: a framed page takes it from no other.
  // Only a browser's window has one; a runtime with no Window (Bun, the CLI's draw) sends none.
  const handshake = (target: EventTarget) => {
    const parent = (target as { parent?: unknown }).parent;
    const source = typeof Window !== "undefined" && parent instanceof Window ? { source: parent } : {};
    target.dispatchEvent(new MessageEvent("message", { data: { type: PORT_HANDSHAKE }, ports: [channel.port2], ...source }));
  };

  return {
    get received() { return state.received; },
    get refused() { return state.refused; },
    get drawn() { return state.drawn; },
    get hovered() { return state.hovered; },
    handshake,
    connect: (o = {}) => {
      const target = new EventTarget();
      const client = connectWallpaper({ target: target as unknown as Window, timeoutMs: o.timeoutMs ?? 2000 });
      handshake(target);
      return client;
    },
    send: (m) => {
      if (m.type === "creatures") {
        creatures = new Set(m.creatures.map((c) => c.id));
        if (state.hovered && !creatures.has(state.hovered)) state.hovered = null;
      }
      post(m);
    },
    point: (x, y, over = true) => post({ type: "pointer", x, y, over }),
    click: (x, y) => {
      const id = state.hovered;
      post({ type: "click", x, y, id });
      return id;
    },
    settle: async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); },
    close: () => { port.onmessage = null; port.close(); },
  };
}
