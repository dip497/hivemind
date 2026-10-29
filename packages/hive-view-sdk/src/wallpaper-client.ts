/**
 * A live wallpaper's client (`connectWallpaper`): the values the app says and their changes, its
 * answers to the pointer and to clicks from one hit test, and its clock. The protocol it speaks is
 * `./wallpaper.ts`.
 */
import { PORT_HANDSHAKE } from "./protocol.js";
import {
  SCENE_STEP, WALLPAPER_PROTOCOL, parseWallpaperHostMessage, sceneClock,
  type SceneClock, type SceneSteps, type WallpaperCreature, type WallpaperLook, type WallpaperMessage, type WallpaperMode, type WallpaperTile, type WallpaperViewport,
} from "./wallpaper.js";

// ── the client ────────────────────────────────────────────────────────────

type Events = {
  viewport: WallpaperViewport;
  look: WallpaperLook;
  mode: WallpaperMode;
  creatures: WallpaperCreature[];
  tiles: { tiles: WallpaperTile[]; seeThrough: boolean };
  /** An agent finished a turn well: its creature's id. */
  done: { id: string };
  pointer: { x: number; y: number; over: boolean };
  /** A click on empty canvas, and the creature it opened, if any (the one `hitTest` last said is
   *  under the pointer: the app went to its agent's tile). A scene usually ripples the water only
   *  when `id` is null. */
  click: { x: number; y: number; id: string | null };
};
/** Events that say how things are now: a late listener hears the latest at once. */
const STATE: ReadonlySet<keyof Events> = new Set(["viewport", "look", "mode", "creatures", "tiles"]);

export interface WallpaperClient {
  readonly viewport: WallpaperViewport;
  readonly look: WallpaperLook;
  readonly mode: WallpaperMode;
  readonly creatures: readonly WallpaperCreature[];
  readonly tiles: readonly WallpaperTile[];
  readonly seeThrough: boolean;
  /** What the app says. One that says how things are now (viewport, look, mode, creatures, tiles)
   *  calls a new listener at once with the latest. Returns the way to stop listening. */
  on<K extends keyof Events>(event: K, cb: (payload: Events[K]) => void): () => void;
  /** The creature at a point of the viewport, or null: the app shows its agent's name while the
   *  pointer is over it, and a click there goes to its agent's tile. Without one, none is. */
  hitTest(fn: (x: number, y: number) => string | null): void;
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
  creatures: WallpaperCreature[] = [];
  tiles: WallpaperTile[] = [];
  seeThrough = false;
  private listeners = new Map<keyof Events, Set<(p: unknown) => void>>();
  private hit: ((x: number, y: number) => string | null) | null = null;
  private hovered: string | null = null;
  /** Where the pointer is over empty canvas, or null: a creature may swim in under it, or away. */
  private at: { x: number; y: number } | null = null;
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

  hitTest(fn: (x: number, y: number) => string | null): void {
    this.hit = fn;
  }

  animate(scene: SceneSteps, opts: { fps?: number } = {}): () => void {
    this.clock?.stop();
    const clock = sceneClock({
      step: (dt) => scene.step(dt),
      draw: (dt) => {
        scene.draw(dt);
        this.drawn();
        if (this.at) this.hover(this.hitAt(this.at.x, this.at.y));
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
      case "creatures": return this.creatures;
      case "tiles": return { tiles: this.tiles, seeThrough: this.seeThrough };
      default: return undefined;
    }
  }

  private emit<K extends keyof Events>(event: K, payload: Events[K]) {
    for (const cb of this.listeners.get(event) ?? []) {
      try { cb(payload); } catch (e) { console.error(`[wallpaper] a "${event}" listener threw:`, e); }
    }
  }

  private hitAt(x: number, y: number): string | null {
    if (!this.hit) return null;
    let id: string | null = null;
    try { id = this.hit(x, y); } catch (e) { console.error("[wallpaper] hitTest threw:", e); }
    // Only a creature the app named: anything else would be refused.
    return id !== null && this.creatures.some((c) => c.id === id) ? id : null;
  }

  private receive(raw: unknown) {
    const r = parseWallpaperHostMessage(raw);
    if (!r.ok) { console.warn(`[wallpaper] dropped a message: ${r.reason}`); return; }
    const m = r.msg;
    switch (m.type) {
      case "hello":
        this.viewport = m.viewport; this.look = m.look; this.mode = m.mode;
        this.creatures = m.creatures; this.tiles = m.tiles; this.seeThrough = m.seeThrough;
        this.onHello(this);
        return;
      case "viewport": this.viewport = m.viewport; this.emit("viewport", m.viewport); this.clock?.changed(); return;
      case "look": this.look = m.look; this.emit("look", m.look); this.clock?.changed(); return;
      case "mode": this.mode = m.mode; this.emit("mode", m.mode); this.clock?.setMode(m.mode); return;
      case "creatures": {
        this.creatures = m.creatures;
        this.emit("creatures", m.creatures);
        if (this.hovered && !m.creatures.some((c) => c.id === this.hovered)) this.hover(null);
        this.clock?.changed();
        return;
      }
      case "tiles": this.tiles = m.tiles; this.seeThrough = m.seeThrough; this.emit("tiles", { tiles: m.tiles, seeThrough: m.seeThrough }); this.clock?.changed(); return;
      case "done": this.emit("done", { id: m.id }); return;
      case "pointer":
        this.at = m.over ? { x: m.x, y: m.y } : null;
        this.emit("pointer", { x: m.x, y: m.y, over: m.over });
        this.hover(m.over ? this.hitAt(m.x, m.y) : null);
        return;
      case "click": this.emit("click", { x: m.x, y: m.y, id: m.id }); return;
    }
  }

  private hover(id: string | null) {
    if (id === this.hovered) return;
    this.hovered = id;
    this.post({ type: "hover", id });
  }

  private post(m: WallpaperMessage) {
    this.port.postMessage(m);
  }
}
