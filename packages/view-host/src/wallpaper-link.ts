/**
 * The host end of a package's live wallpaper (live wallpaper protocol 2): one port to its sandboxed
 * frame. It sends the wallpaper what it is told (`hello` once it says `ready`, then each change, the
 * same thing never twice) and checks everything it sends back (`parseWallpaperMessage`).
 * Misbehaving (malformed messages, a flood, a protocol newer than this app's) turns it off for the
 * session; the app shows the plain background instead.
 *
 * No DOM and no Node: the window runs it, and its tests run it over a real MessageChannel.
 */
import type { PortLike } from "./link.js";
import {
  WALLPAPER_PROTOCOL, parseWallpaperMessage,
  type WallpaperHostMessage, type WallpaperLook, type WallpaperMode, type WallpaperViewport,
} from "@hivemind/view-sdk/wallpaper";

export const WALLPAPER_LIMITS = {
  /** Malformed messages before it is turned off. */
  refused: 8,
  /** It says two things, once each: far fewer than this. */
  messagesPerSecond: 120,
};

/** What a wallpaper is told. */
export interface WallpaperScene {
  viewport: WallpaperViewport;
  look: WallpaperLook;
  mode: WallpaperMode;
}

export interface WallpaperLinkDeps {
  /** Its first frame is up: show it. */
  onDrawn(): void;
  /** It misbehaved and is off for the session. */
  onDisable(reason: string): void;
}

export class WallpaperLink {
  private port: PortLike | null = null;
  private ready = false;
  private disabled: string | null = null;
  private refused = 0;
  private window = { start: 0, count: 0 };
  /** What was last sent of each part, as JSON, so the same thing is never sent twice. */
  private sent = new Map<string, string>();

  constructor(private readonly deps: WallpaperLinkDeps, private scene: WallpaperScene) {}

  /** Its frame's port: it says `ready`, and is sent everything at once. */
  attach(port: PortLike): void {
    this.port = port;
    port.onmessage = (e) => this.receive(e.data);
    port.start?.();
  }

  get off(): string | null { return this.disabled; }

  setViewport(viewport: WallpaperViewport): void { this.scene.viewport = viewport; this.send("viewport", { type: "viewport", viewport }); }
  setLook(look: WallpaperLook): void { this.scene.look = look; this.send("look", { type: "look", look }); }
  setMode(mode: WallpaperMode): void { this.scene.mode = mode; this.send("mode", { type: "mode", mode }); }

  pointer(x: number, y: number, over: boolean): void { this.post({ type: "pointer", x, y, over }); }

  /** A click on empty canvas, for the wallpaper to answer in its scene. */
  click(x: number, y: number): void { this.post({ type: "click", x, y }); }

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

  private receive(raw: unknown): void {
    if (this.disabled) return;
    const now = Date.now();
    if (now - this.window.start >= 1000) this.window = { start: now, count: 0 };
    if (++this.window.count > WALLPAPER_LIMITS.messagesPerSecond) return this.disable(`more than ${WALLPAPER_LIMITS.messagesPerSecond} messages a second`);
    const r = parseWallpaperMessage(raw);
    if (!r.ok) return this.refuse(r.reason);
    const m = r.msg;
    switch (m.type) {
      case "ready": {
        if (m.protocol > WALLPAPER_PROTOCOL) return this.disable(`it needs live wallpaper protocol ${m.protocol}; this Hivemind has ${WALLPAPER_PROTOCOL}`);
        if (this.ready) return;
        this.ready = true;
        const s = this.scene;
        this.post({ type: "hello", protocol: WALLPAPER_PROTOCOL, viewport: s.viewport, look: s.look, mode: s.mode });
        for (const [part, msg] of [["viewport", { type: "viewport", viewport: s.viewport }], ["look", { type: "look", look: s.look }], ["mode", { type: "mode", mode: s.mode }]] as const) {
          this.sent.set(part, JSON.stringify(msg));
        }
        return;
      }
      case "drawn": this.deps.onDrawn(); return;
    }
  }

  private refuse(why: string): void {
    this.refused++;
    console.warn(`[hivemind] live wallpaper refused: ${why}`);
    if (this.refused >= WALLPAPER_LIMITS.refused) this.disable(`${this.refused} malformed messages (last: ${why})`);
  }

  private disable(reason: string): void {
    if (this.disabled) return;
    this.disabled = reason;
    this.dispose();
    this.deps.onDisable(reason);
  }
}
