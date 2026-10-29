/**
 * The page's side of a live wallpaper a package ships: its page in a sandboxed frame where the app's
 * own scenes have their canvas (an opaque origin of its own, `hm-view://<host>`, under the views'
 * policy: no fetch or loading from anywhere else, nothing of the app's), and one port to it, the link
 * that checks everything it sends (`@hivemind/view-host/wallpaper-link`). What it is told is what the
 * app's scenes are, in the words of live wallpaper protocol 1: no tile's name, folder or output, and
 * not even its id: each agent's tile is named by a handle of this session's, the same for its
 * creature and its tile. It is shown once it has drawn its first frame, so a slow one never flashes
 * empty. It never has the keyboard: one that takes it is turned off, and what had it gets it back.
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
  /** Each agent tile's handle, and back: what the wallpaper calls it instead of its id. */
  private handles = new Map<string, string>();
  private keys = new Map<string, string>();
  /** The handles of the creatures there now. */
  private named = new Set<string>();
  private boxes: { list: Box[]; seeThrough: boolean } | null = null;
  /** What it last said is under the pointer, taken at most once a frame. */
  private saidHover: string | null = null;
  private hoverFrame = 0;
  /** What had the keyboard before it, to give it back. */
  private hadFocus: Element | null = document.activeElement;

  /** `look`: the colours it is told first, with everything else, once it says it is ready. */
  constructor(host: HTMLElement, wallpaper: PluginWallpaper, look: PageLook, events: SceneEvents) {
    // Everything about the frame is set before it joins the page, which is when it is created.
    const frame = document.createElement("iframe");
    // Scripts and nothing else: no same origin, no forms, no pop-ups. It draws, and is told.
    frame.setAttribute("sandbox", "allow-scripts");
    frame.referrerPolicy = "no-referrer";
    frame.tabIndex = -1;
    // Out of the keyboard's way and the accessibility tree: it is a picture.
    frame.inert = true;
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
      onHover: (id) => this.heard(id),
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
    window.addEventListener("focusin", this.onFocusIn);
    window.addEventListener("blur", this.onBlur);
    this.resize();
  }

  destroy() {
    this.offRunaway();
    this.link.dispose();
    cancelAnimationFrame(this.hoverFrame);
    window.removeEventListener("focusin", this.onFocusIn);
    window.removeEventListener("blur", this.onBlur);
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
    const told = creatures.map((c) => ({ id: this.handleOf(c.key), agent: c.agent ?? null, kind: c.variant, size: c.size, state: STATE[c.mood] }));
    this.named = new Set(told.map((c) => c.id));
    this.link.setCreatures(told);
    // A tile is named only while it has a creature.
    if (this.boxes) this.setBoxes(this.boxes.list, this.boxes.seeThrough);
  }

  setBoxes(boxes: Box[], seeThrough: boolean) {
    this.boxes = { list: boxes, seeThrough };
    this.link.setTiles(boxes.map((b) => {
      const id = b.key ? this.handles.get(b.key) : undefined;
      return { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, ...(id && this.named.has(id) ? { id } : {}) };
    }), seeThrough);
  }

  finished(key: string) {
    const id = this.handles.get(key);
    if (id) this.link.done(id);
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

  private handleOf(key: string): string {
    let h = this.handles.get(key);
    if (!h) {
      h = crypto.randomUUID();
      this.handles.set(key, h);
      this.keys.set(h, key);
    }
    return h;
  }

  /** It may change its mind as often as it likes; the page hears the last word once a frame. */
  private heard(id: string | null) {
    this.saidHover = id;
    if (this.hoverFrame) return;
    this.hoverFrame = requestAnimationFrame(() => {
      this.hoverFrame = 0;
      this.hover(this.saidHover === null ? null : this.keys.get(this.saidHover) ?? null);
    });
  }

  private onFocusIn = (e: FocusEvent) => {
    if (e.target !== this.frame) this.hadFocus = e.target as Element;
  };

  // Focus that moves into a frame leaves this window: when it went to the wallpaper's, the
  // wallpaper took it (nothing the person does can give it the keyboard).
  private onBlur = () => {
    if (document.activeElement !== this.frame) return;
    this.link.dispose();
    this.frame.remove();
    if ((this.hadFocus instanceof HTMLElement || this.hadFocus instanceof SVGElement) && this.hadFocus.isConnected) this.hadFocus.focus();
    this.events.disable?.("it took the keyboard");
  };

  private lookOf(l: PageLook): WallpaperLook {
    return { page: hex(l.page), text: hex(l.text), attention: hex(l.attention), dark: l.dark, colour: l.colour, mono: l.mono || getComputedStyle(this.host).fontFamily };
  }
}
