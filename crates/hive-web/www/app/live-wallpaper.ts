// A live wallpaper the computer draws, on the phone (docs/design/phone-look-2026-11-01.md): its page
// in a frame on the views' origin, shown by the views' shell (view/shell.js), whose service worker
// asks this page for its files, and this page the computer (`appearance.wallpaperFile`). It is told
// what the desktop tells one, through the desktop's own checks (`WallpaperLink`); it is shown once it
// has drawn, never has the keyboard, and is turned off for good when it misbehaves.

import { WallpaperLink } from "../../../../packages/view-host/src/wallpaper-link.js";
import type { WallpaperCreature, WallpaperLook, WallpaperMode } from "../../../../packages/hive-view-sdk/src/wallpaper.js";
import { roster } from "../../../../apps/desktop/src/renderer/src/live/roster.js";
import { h } from "./dom.js";
import type { Agent, ViewFile } from "./types.js";

/** How many of its files may be on their way at once: past them it is told there is none. */
const FILES_AT_ONCE = 16;
/** Its pixel ratio at most, as on the desktop: a phone at 3× would draw 2.25 times the pixels. */
const MOST_DPR = 2;

const STATE = { hunt: "working", cruise: "ready", surface: "needs-you", rest: "resting" } as const;

/** The creatures for the agents the phone knows of, as the desktop's roster picks them. */
export function creaturesOf(agents: readonly Agent[]): WallpaperCreature[] {
  const status = new Map(agents.map((a) => [a.tile, a.state === "working" ? "working" : a.waiting ? (a.waiting.kind as never) : "idle"] as const));
  return roster(agents.map((a) => ({ tileId: `${a.workspace}/${a.tile}`, agent: a.program?.id ?? null, sleeping: a.state === "asleep" })), (t) => status.get(t.slice(t.indexOf("/") + 1)))
    .map((c) => ({ id: c.key, agent: c.agent ?? null, kind: c.variant, size: c.size, state: STATE[c.mood] }));
}

export class LiveWallpaper {
  readonly frame: HTMLIFrameElement;
  private readonly link: WallpaperLink;
  private shell: MessagePort | null = null;
  private files = 0;
  private gone = false;
  private readonly resized = new ResizeObserver(() => this.size());

  constructor(
    private readonly host: HTMLElement,
    origin: string,
    name: string,
    private readonly file: (path: string) => Promise<ViewFile>,
    look: WallpaperLook,
    mode: WallpaperMode,
    creatures: WallpaperCreature[],
    private readonly off: (why: string) => void,
  ) {
    const token = crypto.randomUUID().replaceAll("-", "");
    this.frame = h("iframe", {
      sandbox: "allow-scripts allow-same-origin", referrerpolicy: "no-referrer", title: name, tabindex: "-1",
      class: "wp-live", "data-live-wallpaper": "", src: `${origin}/?s=${token}`,
    });
    this.frame.inert = true;
    this.link = new WallpaperLink({
      onDrawn: () => (this.frame.dataset.drawn = "1"),
      onHover: () => {},
      onDisable: (why) => this.stop(why),
    }, { viewport: this.viewport(), look, mode, creatures, tiles: [], seeThrough: false });
    let loads = 0;
    this.frame.addEventListener("load", () => {
      if (loads++ > 0) return this.stop("it left the page it was shown in");
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = (m) => this.heard((m.data ?? {}) as Record<string, unknown>);
      this.shell = port1;
      this.frame.contentWindow!.postMessage({ t: "start", page: "__entry.html", wallpaper: true }, origin, [port2]);
    });
    addEventListener("blur", this.onBlur);
    host.append(this.frame);
    this.resized.observe(host);
  }

  setLook(look: WallpaperLook): void {
    this.link.setLook(look);
  }

  setMode(mode: WallpaperMode): void {
    this.link.setMode(mode);
  }

  setCreatures(creatures: WallpaperCreature[]): void {
    this.link.setCreatures(creatures);
  }

  dispose(): void {
    this.gone = true;
    removeEventListener("blur", this.onBlur);
    this.resized.disconnect();
    this.link.dispose();
    this.shell?.close();
    this.frame.remove();
  }

  private stop(why: string): void {
    if (this.gone) return;
    this.dispose();
    this.off(why);
  }

  private viewport() {
    const r = this.host.getBoundingClientRect();
    return { w: Math.round(r.width || innerWidth), h: Math.round(r.height || innerHeight), dpr: Math.min(devicePixelRatio || 1, MOST_DPR) };
  }

  private size(): void {
    this.link.setViewport(this.viewport());
  }

  private heard(m: Record<string, unknown>): void {
    if (m.t === "file" && typeof m.id === "number" && typeof m.path === "string") return this.send(m.id, m.path);
    if (m.t === "page") {
      const { port1, port2 } = new MessageChannel();
      this.link.attach(port1);
      this.shell?.postMessage({ t: "port" }, [port2]);
      return;
    }
    if (m.t === "left") return this.stop("it left the page it was shown in");
    if (m.t === "failed") return this.stop(`it could not be shown: ${String(m.why)}`);
  }

  private send(id: number, path: string): void {
    const reply = (file: ViewFile | null) => !this.gone && this.shell?.postMessage({ t: "file", id, file }, file ? [file.data.buffer] : []);
    if (this.files >= FILES_AT_ONCE) return void reply(null);
    this.files++;
    this.file(path).then(reply, () => reply(null)).finally(() => this.files--);
  }

  // Focus that moves into a frame leaves this window: when it went to the wallpaper's, it took it.
  private onBlur = (): void => {
    if (document.activeElement === this.frame) this.stop("it took the keyboard");
  };
}
