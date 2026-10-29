/**
 * The page's side of a live wallpaper a package ships: its page in a sandboxed frame where the app's
 * own scenes have their canvas (an opaque origin of its own, `hm-view://<host>`, under the views'
 * policy: no network, nothing of the app's), and one port to it, the link that checks everything it
 * sends (`@hivemind/view-host/wallpaper-link`). What it is told is what the app's scenes are, in the
 * words of live wallpaper protocol 1: no tile's name, folder or output. It is shown once it has drawn
 * its first frame, so a slow one never flashes empty.
 */
import { PORT_HANDSHAKE } from "@hivemind/view-sdk/protocol";
import type { AgentState, WallpaperLook } from "@hivemind/view-sdk/wallpaper";
import { WallpaperLink } from "@hivemind/view-host/wallpaper-link";
import { PageScene, type PageLook, type SceneEvents } from "./page-scene";
import type { Box, CreatureSpec, Mood, SceneMode } from "./scene";

/** What an agent is doing, in the protocol's words. */
const STATE: Record<Mood, AgentState> = { hunt: "working", cruise: "ready", surface: "needs-you", rest: "resting" };

const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

/** A package's live wallpaper to run: its id, its name for what is said about it, and its page. */
export interface PluginWallpaper { id: string; name: string; url: string }

export class PluginEngine extends PageScene {
  private frame: HTMLIFrameElement;
  private link: WallpaperLink;
  private look: PageLook | null = null;
  private offRunaway: () => void;

  /** `look`: the colours it is told first, with everything else, once it says it is ready. */
  constructor(host: HTMLElement, wallpaper: PluginWallpaper, look: PageLook, events: SceneEvents) {
    // Everything about the frame is set before it joins the page, which is when it is created.
    const frame = document.createElement("iframe");
    // Scripts and nothing else: no same origin, no forms, no pop-ups. It draws, and is told.
    frame.setAttribute("sandbox", "allow-scripts");
    frame.referrerPolicy = "no-referrer";
    frame.tabIndex = -1;
    frame.title = wallpaper.name;
    frame.name = `hm-wallpaper:${wallpaper.id}`;
    frame.className = "hm-live-frame";
    frame.dataset.wallpaper = wallpaper.id;
    super(host, frame, events);
    this.frame = frame;
    this.look = look;
    const r = host.getBoundingClientRect();
    this.link = new WallpaperLink({
      onDrawn: () => { frame.dataset.drawn = "1"; },
      onHover: (id) => this.hover(id),
      onDisable: (reason) => events.disable?.(reason),
    }, {
      viewport: { w: Math.round(r.width), h: Math.round(r.height), dpr: Math.min(window.devicePixelRatio || 1, 2) },
      look: this.lookOf(look),
      mode: "hold", creatures: [], tiles: [], seeThrough: false,
    });
    frame.addEventListener("load", () => {
      const ch = new MessageChannel();
      this.link.attach(ch.port1);
      // The frame's origin is opaque, so the only target is "*"; nothing but the port travels with it.
      frame.contentWindow?.postMessage({ type: PORT_HANDSHAKE }, "*", [ch.port2]);
    }, { once: true });
    frame.src = window.hive.resourceUrl(wallpaper.url);
    // Main's watchdog names a frame that pegs a core by its wallpaper's id.
    this.offRunaway = window.hive.onViewRunaway((e) => {
      if (e.id === wallpaper.id) events.disable?.(`it kept ${e.cpuPct}% of a core busy`);
    });
    this.resize();
  }

  destroy() {
    this.offRunaway();
    this.link.dispose();
    super.destroy();
  }

  setLook(look: PageLook) {
    this.look = look;
    this.link.setLook(this.lookOf(look));
  }

  /** The terminals' font is the person's; a wallpaper may draw in it. */
  fontChanged() {
    if (this.look) this.link.setLook(this.lookOf(this.look));
  }

  setRoster(creatures: CreatureSpec[]) {
    this.link.setCreatures(creatures.map((c) => ({ id: c.key, agent: c.agent ?? null, kind: c.variant, size: c.size, state: STATE[c.mood] })));
  }

  setBoxes(boxes: Box[], seeThrough: boolean) {
    this.link.setTiles(boxes.map((b) => ({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, ...(b.key ? { id: b.key } : {}) })), seeThrough);
  }

  finished(key: string) {
    this.link.done(key);
  }

  protected sendMode(mode: SceneMode) {
    this.link.setMode(mode);
  }

  protected sendSize(width: number, height: number, dpr: number) {
    this.link.setViewport({ w: Math.round(width), h: Math.round(height), dpr });
  }

  protected sendPointer(x: number, y: number, active: boolean) {
    this.link.pointer(x, y, active);
  }

  protected sendClick(x: number, y: number) {
    this.link.click(x, y);
  }

  private lookOf(l: PageLook): WallpaperLook {
    return { page: hex(l.page), text: hex(l.text), attention: hex(l.attention), dark: l.dark, colour: l.colour, mono: l.mono || getComputedStyle(this.host).fontFamily };
  }
}
