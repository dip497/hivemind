/**
 * The host end of a package's live wallpaper (live wallpaper protocol 1): one port to its sandboxed
 * frame. It sends the wallpaper what it is told (`hello` once it says `ready`, then each change, the
 * same thing never twice) and checks everything it sends back (`parseWallpaperMessage`, then
 * `wallpaperRefusal`). Misbehaving (malformed or refused messages, a flood, a protocol newer than
 * this app's) turns it off for the session; the app shows the plain background instead.
 *
 * No DOM and no Node: the window runs it, and its tests run it over a real MessageChannel.
 */
import {
  WALLPAPER_PROTOCOL, parseWallpaperMessage, wallpaperRefusal,
  type WallpaperCreature, type WallpaperHostMessage, type WallpaperLook, type WallpaperMode, type WallpaperTile, type WallpaperViewport,
} from "@hivemind/view-sdk/wallpaper";

export const WALLPAPER_LIMITS = {
  /** Malformed or refused messages before it is turned off. */
  refused: 8,
  /** It answers the pointer, at most once a frame: far fewer than this. */
  messagesPerSecond: 120,
  /** A creature whose agent went keeps being taken back this long: an answer about it may already
   *  be on its way. */
  graceMs: 2000,
};

/** What a wallpaper is told. */
export interface WallpaperScene {
  viewport: WallpaperViewport;
  look: WallpaperLook;
  mode: WallpaperMode;
  creatures: WallpaperCreature[];
  tiles: WallpaperTile[];
  seeThrough: boolean;
}

export interface WallpaperLinkDeps {
  /** Its first frame is up: show it. */
  onDrawn(): void;
  /** The creature under the pointer, or none. */
  onHover(id: string | null): void;
  /** It misbehaved and is off for the session. */
  onDisable(reason: string): void;
}

interface MinimalPort {
  postMessage(m: unknown): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  start?(): void;
  close?(): void;
}

export class WallpaperLink {
  private port: MinimalPort | null = null;
  private ready = false;
  private disabled: string | null = null;
  private refused = 0;
  private window = { start: 0, count: 0 };
  /** What was last sent of each part, as JSON, so the same thing is never sent twice. */
  private sent = new Map<string, string>();
  /** Creatures it may name: those there now, and those gone for less than the grace, by when they went. */
  private gone = new Map<string, number>();
  private hovered: string | null = null;

  constructor(private readonly deps: WallpaperLinkDeps, private scene: WallpaperScene) {}

  /** Its frame's port: it says `ready`, and is sent everything at once. */
  attach(port: MinimalPort): void {
    this.port = port;
    port.onmessage = (e) => this.receive(e.data);
    port.start?.();
  }

  get off(): string | null { return this.disabled; }

  setViewport(viewport: WallpaperViewport): void { this.scene.viewport = viewport; this.send("viewport", { type: "viewport", viewport }); }
  setLook(look: WallpaperLook): void { this.scene.look = look; this.send("look", { type: "look", look }); }
  setMode(mode: WallpaperMode): void { this.scene.mode = mode; this.send("mode", { type: "mode", mode }); }
  setTiles(tiles: WallpaperTile[], seeThrough: boolean): void { this.scene.tiles = tiles; this.scene.seeThrough = seeThrough; this.send("tiles", { type: "tiles", tiles, seeThrough }); }

  setCreatures(creatures: WallpaperCreature[]): void {
    const now = Date.now();
    const still = new Set(creatures.map((c) => c.id));
    for (const c of this.scene.creatures) if (!still.has(c.id)) this.gone.set(c.id, now);
    for (const id of still) this.gone.delete(id);
    this.scene.creatures = creatures;
    // The agent under the pointer went: no name stays shown for it.
    if (this.hovered && !still.has(this.hovered)) this.hover(null);
    this.send("creatures", { type: "creatures", creatures });
  }

  /** An agent finished a turn well. */
  done(id: string): void { this.post({ type: "done", id }); }

  pointer(x: number, y: number, over: boolean): void { this.post({ type: "pointer", x, y, over }); }

  /** A click on empty canvas: the creature it opens, the one under the pointer, or null. The
   *  wallpaper hears it, to answer it in its scene. */
  click(x: number, y: number): string | null {
    const id = this.hovered;
    this.post({ type: "click", x, y, id });
    return id;
  }

  dispose(): void {
    const port = this.port;
    this.port = null;
    if (!port) return;
    port.onmessage = null;
    port.close?.();
  }

  private send(part: string, m: WallpaperHostMessage): void {
    const json = JSON.stringify(m);
    if (this.sent.get(part) === json) return;
    this.sent.set(part, json);
    this.post(m);
  }

  private post(m: WallpaperHostMessage): void {
    if (this.ready && this.port && !this.disabled) this.port.postMessage(m);
  }

  private known(): Set<string> {
    const now = Date.now();
    for (const [id, at] of this.gone) if (now - at > WALLPAPER_LIMITS.graceMs) this.gone.delete(id);
    return new Set([...this.scene.creatures.map((c) => c.id), ...this.gone.keys()]);
  }

  private receive(raw: unknown): void {
    if (this.disabled) return;
    const now = Date.now();
    if (now - this.window.start >= 1000) this.window = { start: now, count: 0 };
    if (++this.window.count > WALLPAPER_LIMITS.messagesPerSecond) return this.disable(`more than ${WALLPAPER_LIMITS.messagesPerSecond} messages a second`);
    const r = parseWallpaperMessage(raw);
    if (!r.ok) return this.refuse(r.reason);
    const m = r.msg;
    const why = wallpaperRefusal(m, this.known());
    if (why) return this.refuse(why);
    switch (m.type) {
      case "ready": {
        if (m.protocol > WALLPAPER_PROTOCOL) return this.disable(`it needs live wallpaper protocol ${m.protocol}; this Hivemind has ${WALLPAPER_PROTOCOL}`);
        if (this.ready) return;
        this.ready = true;
        const s = this.scene;
        this.post({ type: "hello", protocol: WALLPAPER_PROTOCOL, viewport: s.viewport, look: s.look, mode: s.mode, creatures: s.creatures, tiles: s.tiles, seeThrough: s.seeThrough });
        for (const [part, msg] of [["viewport", { type: "viewport", viewport: s.viewport }], ["look", { type: "look", look: s.look }], ["mode", { type: "mode", mode: s.mode }],
          ["creatures", { type: "creatures", creatures: s.creatures }], ["tiles", { type: "tiles", tiles: s.tiles, seeThrough: s.seeThrough }]] as const) this.sent.set(part, JSON.stringify(msg));
        return;
      }
      case "drawn": this.deps.onDrawn(); return;
      // A creature that went is still taken back for a moment, but no name is shown for it.
      case "hover": this.hover(m.id !== null && this.scene.creatures.some((c) => c.id === m.id) ? m.id : null); return;
    }
  }

  private hover(id: string | null): void {
    if (id === this.hovered) return;
    this.hovered = id;
    this.deps.onHover(id);
  }

  private refuse(why: string): void {
    this.refused++;
    console.warn(`[hivemind] live wallpaper refused: ${why}`);
    if (this.refused >= WALLPAPER_LIMITS.refused) this.disable(`${this.refused} malformed or refused messages (last: ${why})`);
  }

  private disable(reason: string): void {
    if (this.disabled) return;
    this.disabled = reason;
    this.hover(null);
    this.dispose();
    this.deps.onDisable(reason);
  }
}
