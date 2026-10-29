/**
 * The page's side of one of the app's own live wallpapers. It puts a canvas in its host, hands it to
 * the scene's worker (worker.ts), where the simulation and its drawing run, and tells it what
 * changes; what every scene gets from the page is page-scene.ts's. What stays here is the font,
 * which a worker sees none of the page's faces of. Each engine makes its own canvas: one can be
 * handed to a worker only once.
 */
import SceneWorker from "./worker?worker";
import { PageScene, type PageLook, type SceneEvents } from "./page-scene";
import type { SceneMode } from "./scene";
import type { FaceSource, SceneId, SceneMessage } from "./worker";

export type { SceneId };

const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, "");

const weightOf = (w: string) => (w === "bold" ? 700 : w === "normal" || w === "" ? 400 : Number(w));

/** The page's @font-face sources for the scene's font, latin only (the scene draws ASCII): its faces
 *  that cover weight 600, which the scene draws in, else all it has (the nearest is used). A font
 *  installed on the computer needs none: the worker sees those as the page does. */
function facesOf(stack: string): FaceSource[] {
  const family = unquote(stack.split(",")[0] ?? "");
  const all: (FaceSource & { bold: boolean })[] = [];
  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const r of rules) {
      if (!(r instanceof CSSFontFaceRule) || unquote(r.style.getPropertyValue("font-family")) !== family) continue;
      const range = r.style.getPropertyValue("unicode-range");
      if (range && !/U\+0+-0*FF\b/i.test(range)) continue;
      const weight = r.style.getPropertyValue("font-weight").trim() || "normal";
      const [lo = 400, hi = lo] = weight.split(/\s+/).map(weightOf);
      const base = sheet.href ?? location.href;
      const src = r.style.getPropertyValue("src").replace(/url\((["']?)([^"')]+)\1\)/g, (_m, _q, u: string) => `url("${new URL(u, base).href}")`);
      all.push({ family, src, weight, bold: lo <= 600 && 600 <= hi, ...(range ? { range } : {}) });
    }
  }
  const at600 = all.filter((f) => f.bold);
  return (at600.length ? at600 : all).map(({ bold: _bold, ...f }) => f);
}

export class LiveEngine extends PageScene {
  private worker = new SceneWorker();
  private font: string;

  constructor(host: HTMLElement, scene: SceneId, events: SceneEvents) {
    const canvas = document.createElement("canvas");
    super(host, canvas, events);
    this.font = getComputedStyle(host).fontFamily;
    const offscreen = canvas.transferControlToOffscreen();
    this.post({ type: "start", scene, canvas: offscreen, font: this.font, faces: facesOf(this.font) }, [offscreen]);
    this.resize();
  }

  destroy() {
    this.worker.terminate();
    super.destroy();
  }

  /** The terminal's font changed (Settings): the scene's characters follow it. */
  fontChanged() {
    const font = getComputedStyle(this.host).fontFamily;
    if (font === this.font) return;
    this.font = font;
    this.post({ type: "font", font, faces: facesOf(font) });
  }

  setLook({ page, text }: PageLook) {
    this.post({ type: "look", look: { page, text } });
  }

  protected sendMode(mode: SceneMode) {
    this.post({ type: "mode", mode });
  }

  protected sendSize(width: number, height: number, dpr: number) {
    this.post({ type: "size", width, height, dpr });
  }

  protected sendPointer(x: number, y: number, active: boolean) {
    this.post({ type: "pointer", x, y, active });
  }

  protected sendClick(x: number, y: number) {
    this.post({ type: "click", x, y });
  }

  private post(m: SceneMessage, transfer: Transferable[] = []) {
    this.worker.postMessage(m, transfer);
  }
}
