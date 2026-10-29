/**
 * A live wallpaper's client (`connectWallpaper`): the values the app says and their changes, the
 * pointer and clicks over empty canvas, and its clock. The protocol it speaks is `./wallpaper.ts`.
 */
import { PORT_HANDSHAKE } from "./protocol.js";
import {
  SCENE_STEP, WALLPAPER_PROTOCOL, parseWallpaperHostMessage, sceneClock,
  type SceneClock, type SceneSteps, type WallpaperLook, type WallpaperMessage, type WallpaperMode, type WallpaperViewport,
} from "./wallpaper.js";

// ── the client ────────────────────────────────────────────────────────────

type Events = {
  viewport: WallpaperViewport;
  look: WallpaperLook;
  mode: WallpaperMode;
  /** The pointer over empty canvas (`over`), or gone from it. */
  pointer: { x: number; y: number; over: boolean };
  /** A click on empty canvas. */
  click: { x: number; y: number };
};
/** Events that say how things are now: a late listener hears the latest at once. */
const STATE: ReadonlySet<keyof Events> = new Set(["viewport", "look", "mode"]);

export interface WallpaperClient {
  readonly viewport: WallpaperViewport;
  readonly look: WallpaperLook;
  readonly mode: WallpaperMode;
  /** What the app says. One that says how things are now (viewport, look, mode) calls a new
   *  listener at once with the latest. Returns the way to stop listening. */
  on<K extends keyof Events>(event: K, cb: (payload: Events[K]) => void): () => void;
  /** Run `scene` on the app's clock: at most `fps` (30) frames a second while the mode is `run`,
   *  nothing while `hold`, one settled frame while `still` and again when anything it shows changes.
   *  Says `drawn` after the first frame. Returns the way to stop. */
  animate(scene: SceneSteps, opts?: { fps?: number }): () => void;
  /** Say the first frame is up, for a wallpaper that draws without `animate`. */
  drawn(): void;
}

export interface ConnectWallpaperOptions {
  /** Where to listen for the handshake (default `window`). */
  target?: Window;
  /** Give up after this long without a hello (default 10 s). */
  timeoutMs?: number;
}

/** Wait for the app's port and its hello; resolves with the wallpaper's client. */
export function connectWallpaper(opts: ConnectWallpaperOptions = {}): Promise<WallpaperClient> {
  const target = opts.target ?? window;
  // Framed, as it always is in the app, the app is the page it is framed in: a frame of its own
  // is not it. (Unframed, it is a test's window, handed the port by a fake app.)
  const from = opts.target || window.parent === window ? null : window.parent;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { target.removeEventListener("message", onWindow); reject(new Error("hivemind: no wallpaper handshake")); }, opts.timeoutMs ?? 10_000);
    const onWindow = (e: MessageEvent) => {
      const port = e.ports?.[0];
      if (!port || (e.data as { type?: unknown } | null)?.type !== PORT_HANDSHAKE || (from && e.source !== from)) return;
      target.removeEventListener("message", onWindow);
      new Wallpaper(port, (c) => { clearTimeout(timer); resolve(c); });
    };
    target.addEventListener("message", onWindow);
  });
}

class Wallpaper implements WallpaperClient {
  viewport: WallpaperViewport = { w: 0, h: 0, dpr: 1 };
  look!: WallpaperLook;
  mode: WallpaperMode = "hold";
  private listeners = new Map<keyof Events, Set<(p: unknown) => void>>();
  private saidDrawn = false;
  private clock: SceneClock | null = null;

  constructor(private port: MessagePort, private onHello: (c: WallpaperClient) => void) {
    port.onmessage = (e) => this.receive(e.data);
    port.start();
    this.post({ type: "ready", protocol: WALLPAPER_PROTOCOL });
  }

  on<K extends keyof Events>(event: K, cb: (payload: Events[K]) => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    this.listeners.set(event, set);
    set.add(cb as (p: unknown) => void);
    if (STATE.has(event) && this.look) cb(this.now(event) as Events[K]);
    return () => { set.delete(cb as (p: unknown) => void); };
  }

  animate(scene: SceneSteps, opts: { fps?: number } = {}): () => void {
    this.clock?.stop();
    const clock = sceneClock({
      step: (dt) => scene.step(dt),
      draw: (dt) => {
        scene.draw(dt);
        this.drawn();
      },
      ...(scene.settle ? { settle: () => scene.settle!() } : {}),
    }, opts);
    this.clock = clock;
    // The first frame now, whatever the mode: a held wallpaper still shows something.
    if (this.mode === "run") clock.setMode("run");
    else if (this.mode === "still") clock.setMode("still");
    else { scene.draw(SCENE_STEP); this.drawn(); }
    return () => { clock.stop(); if (this.clock === clock) this.clock = null; };
  }

  drawn(): void {
    if (this.saidDrawn) return;
    this.saidDrawn = true;
    this.post({ type: "drawn" });
  }

  private now(event: keyof Events): unknown {
    switch (event) {
      case "viewport": return this.viewport;
      case "look": return this.look;
      case "mode": return this.mode;
      default: return undefined;
    }
  }

  private emit<K extends keyof Events>(event: K, payload: Events[K]) {
    for (const cb of this.listeners.get(event) ?? []) {
      try { cb(payload); } catch (e) { console.error(`[wallpaper] a "${event}" listener threw:`, e); }
    }
  }

  private receive(raw: unknown) {
    const r = parseWallpaperHostMessage(raw);
    if (!r.ok) { console.warn(`[wallpaper] dropped a message: ${r.reason}`); return; }
    const m = r.msg;
    switch (m.type) {
      case "hello":
        this.viewport = m.viewport; this.look = m.look; this.mode = m.mode;
        this.onHello(this);
        return;
      case "viewport": this.viewport = m.viewport; this.emit("viewport", m.viewport); this.clock?.changed(); return;
      case "look": this.look = m.look; this.emit("look", m.look); this.clock?.changed(); return;
      case "mode": this.mode = m.mode; this.emit("mode", m.mode); this.clock?.setMode(m.mode); return;
      case "pointer": this.emit("pointer", { x: m.x, y: m.y, over: m.over }); return;
      case "click": this.emit("click", { x: m.x, y: m.y }); return;
    }
  }

  private post(m: WallpaperMessage) {
    this.port.postMessage(m);
  }
}
