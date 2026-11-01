// The computer's look on the phone (docs/design/phone-look-2026-11-01.md): its colours on the page
// and its terminals, and its wallpaper behind the screens, as the desktop draws it: a built-in
// scene, a photo or video (kept in this browser by its revision), or a live wallpaper.

import { h } from "./dom.js";
import { LiveWallpaper, creaturesOf } from "./live-wallpaper.js";
import { setTerminalColours } from "./terminal.js";
import type { Agent, HeldLook, Look, ViewFile } from "./types.js";
import { viewsOrigin } from "./views.js";

/** What the look asks of the computer whose look it is. */
export interface LookFiles {
  wallpaperFile(device: string, workspace: string, path: string): Promise<ViewFile>;
  wallpaperMedia(device: string, workspace: string, revision: string, got: (at: number, of: number) => void): Promise<{ data: Uint8Array; type: string }>;
}

/** The desktop's built-in scenes, drawn by CSS (app.css, as styles.css draws them). */
const SCENES = new Set(["aurora", "ember", "ice", "mesh", "sunset", "forest", "nebula", "mono"]);
const KEPT = "hivemind-look";
const MEDIA = "hivemind-wallpaper";
/** Hidden this long, a live wallpaper's frame is let go of, not only held. */
const LET_GO_MS = 30_000;
/** The phone's tokens, and the computer's palette token each takes. */
const TOKENS: Array<[string, string]> = [
  ["canvas", "bg"], ["panel", "bg2"], ["card", "bg2"], ["raised", "bg3"], ["line", "line"], ["line2", "line2"],
  ["text", "fg"], ["text2", "fg2"], ["text3", "fg3"], ["on-text", "bg"], ["accent", "brand"], ["warn", "warn"], ["ok", "ok"], ["err", "err"],
];

const motionless = matchMedia("(prefers-reduced-motion: reduce)");

export class LookShown {
  private readonly layer = h("div", { class: "wallpaper", "aria-hidden": "true", hidden: true, "data-wallpaper-layer": "" });
  private held: HeldLook | null = null;
  private colours = "";
  private drawn = "";
  private live: LiveWallpaper | null = null;
  private liveOff: string | null = null;
  private media: string | null = null;
  private agents: Agent[] = [];
  private covered = false;
  private behind = false;
  private hiddenTimer = 0;
  private round = 0;

  constructor(private readonly files: () => LookFiles | null) {
    document.body.prepend(this.layer);
    document.addEventListener("visibilitychange", () => this.seen());
    motionless.addEventListener("change", () => this.mode());
    try {
      const kept = localStorage.getItem(KEPT);
      if (kept) this.show(JSON.parse(kept) as HeldLook);
    } catch {}
  }

  /** Look as `held` says, or as this page does on its own while no computer has said. */
  show(held: HeldLook | null): void {
    if (!held) return;
    this.held = held;
    const colours = JSON.stringify([held.look.mode, held.look.colors, held.look.terminal]);
    if (colours !== this.colours) {
      this.colours = colours;
      this.paint(held.look);
    }
    const drawn = JSON.stringify([held.device, !!held.workspace, held.look.wallpaper, held.look.colors.bg, held.look.colors.fg, held.look.colors.warn, held.look.mode]);
    if (drawn !== this.drawn) {
      this.drawn = drawn;
      this.liveOff = null;
      void this.wallpaper();
    }
    try {
      localStorage.setItem(KEPT, JSON.stringify(held));
    } catch {}
  }

  /** The agents the phone knows of, as a live wallpaper's creatures. */
  setAgents(agents: Agent[]): void {
    if (agents === this.agents) return;
    this.agents = agents;
    this.live?.setCreatures(creaturesOf(agents));
  }

  /** A view is shown over everything: a live wallpaper would share its origin, so it goes meanwhile. */
  cover(covered: boolean): void {
    if (covered === this.covered) return;
    this.covered = covered;
    void this.wallpaper();
  }

  /** A solid screen (a conversation, a terminal) is shown over it: it holds still, unseen. */
  hide(hidden: boolean): void {
    if (hidden === this.behind) return;
    this.behind = hidden;
    this.mode();
  }

  private paint(look: Look): void {
    const root = document.documentElement;
    for (const [token, from] of TOKENS) {
      const c = look.colors[from];
      if (c) root.style.setProperty(`--${token}`, c);
    }
    root.style.colorScheme = look.mode;
    root.dataset.mode = look.mode;
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.content = look.colors.bg ?? meta.content;
    setTerminalColours(look.terminal);
  }

  /** Draw the wallpaper the computer draws now. */
  private async wallpaper(): Promise<void> {
    const round = ++this.round;
    const held = this.held;
    const w = held?.look.wallpaper;
    const root = document.documentElement;
    this.live?.dispose();
    this.live = null;
    const kind = !w ? "none" : SCENES.has(w.kind) || w.kind === "image" || w.kind === "video" || w.kind.startsWith("@") ? w.kind : "none";
    root.classList.toggle("wallpaper-on", kind !== "none");
    root.classList.toggle("wallpaper-moving", kind === "video" || kind.startsWith("@"));
    root.classList.toggle("wp-static", !w?.motion);
    root.style.setProperty("--glass", `${w?.glass ?? 92}%`);
    root.style.setProperty("--wp-brightness", String((w?.brightness ?? 85) / 100));
    this.layer.hidden = kind === "none";
    if (!held || !w || kind === "none") return void this.layer.replaceChildren();
    if (SCENES.has(kind)) return this.scene(kind);
    if (kind === "image" || kind === "video") {
      const media = w.media;
      this.scene(kind);
      if (!media || !held.workspace) return this.fallback(kind);
      const url = await this.mediaUrl(held, media.revision).catch(() => null);
      if (round !== this.round) return;
      if (!url) return this.fallback(kind);
      return this.showMedia(kind, url);
    }
    // A package's live wallpaper, on the page colour till it draws; turned off, it draws as Mono does.
    if (this.liveOff) return this.scene("mono");
    this.layer.replaceChildren();
    this.layer.dataset.scene = "live";
    if (this.covered || document.hidden || !held.workspace) return;
    const origin = await viewsOrigin();
    if (round !== this.round) return;
    const files = this.files();
    if (!origin || !files) return this.scene("mono");
    const { device, workspace } = { device: held.device, workspace: held.workspace };
    const look = held.look;
    this.live = new LiveWallpaper(
      this.layer, origin, kind,
      (path) => files.wallpaperFile(device, workspace, path),
      { page: look.colors.bg ?? "#000000", text: look.colors.fg ?? "#ffffff", attention: look.colors.warn ?? "#e8a64a", dark: look.mode === "dark", colour: w.colour, mono: '"JetBrains Mono", ui-monospace, monospace' },
      this.liveMode(), creaturesOf(this.agents),
      (why) => {
        console.warn(`[hivemind] live wallpaper off: ${why}`);
        this.live = null;
        this.liveOff = why;
        if (round === this.round) this.scene("mono");
      },
    );
  }

  private scene(kind: string): void {
    this.layer.dataset.scene = kind;
    const media = kind === "image" || kind === "video";
    this.layer.replaceChildren(...(media ? [] : [h("div", { class: "wp-bloom wp-a" }), h("div", { class: "wp-bloom wp-b" }), h("div", { class: "wp-bloom wp-c" }), h("div", { class: "wp-veil" })]));
  }

  /** What the desktop draws when its photo or video cannot be: nothing for a photo, Aurora for a video. */
  private fallback(kind: string): void {
    if (kind === "video") this.scene("aurora");
  }

  private showMedia(kind: "image" | "video", url: string): void {
    const el = kind === "image"
      ? h("img", { class: "wp-image", src: url, alt: "", "data-wallpaper-photo": "" })
      : h("video", { class: "wp-video", src: url, muted: true, loop: true, playsinline: true, autoplay: true, "data-wallpaper-video": "" });
    if (el instanceof HTMLVideoElement) {
      el.muted = true;
      el.addEventListener("error", () => this.scene("aurora"), { once: true });
      if (document.hidden || !this.held?.look.wallpaper.motion || motionless.matches) el.autoplay = false;
    }
    this.layer.replaceChildren(el, h("div", { class: "wp-vignette" }));
  }

  /** The photo or video at `revision`, from this browser's keeping, else asked of the computer and kept. */
  private async mediaUrl(held: HeldLook, revision: string): Promise<string> {
    const files = this.files();
    const key = new URL(`wallpaper/${revision}`, location.href).href;
    const cache = typeof caches === "undefined" ? null : await caches.open(MEDIA).catch(() => null);
    let kept = await cache?.match(key);
    if (!kept) {
      if (!files || !held.workspace) throw new Error("not reached");
      const got = await files.wallpaperMedia(held.device, held.workspace, revision, () => {});
      kept = new Response(new Blob([got.data.slice()], { type: got.type }), { headers: { "content-type": got.type } });
      if (cache) {
        for (const old of await cache.keys()) if (old.url !== key) await cache.delete(old);
        await cache.put(key, kept.clone()).catch(() => {});
      }
    }
    if (this.media) URL.revokeObjectURL(this.media);
    this.media = URL.createObjectURL(await kept.blob());
    return this.media;
  }

  private liveMode(): "run" | "hold" | "still" {
    if (document.hidden || this.behind) return "hold";
    return motionless.matches || !this.held?.look.wallpaper.motion ? "still" : "run";
  }

  private mode(): void {
    this.live?.setMode(this.liveMode());
    const video = this.layer.querySelector("video");
    if (video) {
      if (this.liveMode() === "run") void video.play().catch(() => {});
      else video.pause();
    }
  }

  /** Hidden, it holds; hidden a while, its live wallpaper is let go of; seen again, it runs. */
  private seen(): void {
    clearTimeout(this.hiddenTimer);
    this.mode();
    if (document.hidden) {
      this.hiddenTimer = setTimeout(() => {
        if (!document.hidden || !this.live) return;
        this.live.dispose();
        this.live = null;
      }, LET_GO_MS);
    } else if (!this.live && this.held?.look.wallpaper.kind.startsWith("@")) void this.wallpaper();
  }
}
