// A live terminal (docs/design/phone-browser-2026-10-03.md §11.4): the screen hive-phone's core
// keeps of it, its emulator in this page's wasm, drawn on a canvas at the session's own columns,
// as the Android app draws it (TerminalView.kt): fitted to the width at first, pinched to zoom,
// dragged to pan, following the newest line until the person scrolls up. What is typed goes to the
// terminal; a bar under it has the keys a phone's keyboard lacks, and Fit to phone.

import type { App } from "./app.js";
import { h } from "./dom.js";

/** What the core hands over of its screen (wasm `Term.update`, phone-app design §5.3). */
export interface Update {
  revision: number;
  cols: number;
  rows: number;
  firstLine: number;
  lineCount: number;
  cursorLine: number;
  cursorCol: number;
  cursorVisible: boolean;
  lines: Array<{ index: number; text: string; runs: Uint8Array }>;
}

/** The core's terminal, as this view uses it (wasm `Term`). */
export interface TermSource {
  readonly held: boolean;
  update(since: number): Update | null;
  typeText(text: string): void;
  typeKeys(keys: string[]): void;
  fit(cols: number, rows: number): void;
  unfit(): void;
}

interface Line {
  text: string;
  runs: Uint8Array;
}

const BLANK: Line = { text: "", runs: new Uint8Array(0) };
const MAX_ZOOM = 6;
/** A line's height, in font sizes. */
const LINE = 1.25;
/** The font size Fit to phone reads at, in CSS pixels. */
const READABLE = 12;
/** The least time between two frames taken from the core: its pace (§3.4). */
const EVERY_MS = 16;
const FONT = '"JetBrains Mono", ui-monospace, Menlo, monospace';

// The desktop's default terminal colours (its Signal theme), as the Android app draws them.
const FG = "#e6e7e9";
const BG = "#1a1c1f";
const NAMED = [
  "#2a2d32", "#c8756a", "#8fb39a", "#d9b26b", "#7d9bc4", "#a894c4", "#7fb3b8", "#d5d8dc",
  "#5a5f66", "#dc8b80", "#a6c8af", "#e6c688", "#98b2d6", "#bdabd6", "#98c8cc", "#f0f1f3",
];
const PALETTE = (() => {
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  const table = [...NAMED];
  const levels = [0, 95, 135, 175, 215, 255];
  for (let i = 0; i < 216; i++) table.push(`#${hex(levels[Math.floor(i / 36)]!)}${hex(levels[Math.floor(i / 6) % 6]!)}${hex(levels[i % 6]!)}`);
  for (let i = 0; i < 24; i++) table.push(`#${hex(8 + 10 * i).repeat(3)}`);
  return table;
})();
const RGB = new Map<number, string>();

/** The colour a run's `fg` or `bg` names (top byte 0: the default; 1: a palette index; 2: RGB). */
function colour(spec: number, fallback: string): string {
  switch (spec >>> 24) {
    case 1: return PALETTE[spec & 0xff]!;
    case 2: {
      let c = RGB.get(spec);
      if (!c) RGB.set(spec, (c = `#${(spec & 0xffffff).toString(16).padStart(6, "0")}`));
      return c;
    }
    default: return fallback;
  }
}

/** Keys a keyboard names, as the core takes them by name (`keys.rs`). */
const KEYS: Record<string, string> = {
  Enter: "enter", Backspace: "backspace", Tab: "tab", Escape: "esc", Delete: "del", Home: "home", End: "end",
  PageUp: "pageup", PageDown: "pagedown", ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
};
/** The key bar: what a phone's keyboard has no key for. */
const BAR: Array<[string, string, string]> = [
  ["Esc", "esc", "Escape"], ["Tab", "tab", "Tab"], ["←", "left", "Left"], ["↑", "up", "Up"],
  ["↓", "down", "Down"], ["→", "right", "Right"], ["^C", "ctrl-c", "Control C"],
];

export class TerminalView {
  readonly el = h("div", { class: "term", "data-terminal": "" });
  private readonly view = h("div", { class: "term-view" });
  private readonly canvas = h("canvas", { "aria-hidden": "true" });
  /** The lines in sight as text, for a screen reader: the canvas draws none. */
  private readonly text = h("div", { class: "term-text", role: "log", "aria-label": "Terminal", "data-term-text": "" });
  private readonly input = h("textarea", {
    class: "term-input", "aria-label": "Type into the terminal", autocapitalize: "off", autocomplete: "off",
    spellcheck: "false", rows: 1, "data-term-input": "",
  });
  private readonly fitButton: HTMLButtonElement;
  private readonly ended = h("p", { class: "term-ended", role: "status", hidden: true, "data-term-ended": "" });
  /** What is watched, until `unwatch`; `stop` once it is. */
  private wanted: { app: App; workspace: string; tile: string } | null = null;
  private stop: (() => void) | null = null;
  private readonly ctx: CanvasRenderingContext2D;
  private source: TermSource | null = null;

  private revision = 0;
  private cols = 80;
  private firstLine = 0;
  private lines: Line[] = [];
  private cursor = { line: -1, col: 0, visible: false };
  /** The newest line the view keeps in sight while it follows, as a position; -1: none. */
  private newest = -1;

  private zoom = 1;
  /** Where the view is: its first line (a position, fractional), and how far across, in device pixels. */
  private top = 0;
  private across = 0;
  private following = true;
  private fitted = false;

  /** The canvas's size, in device pixels, and the pixel ratio. */
  private width = 0;
  private height = 0;
  private dpr = 1;
  /** A glyph's advance, in font sizes. */
  private advance = 0.6;

  private frame = 0;
  private takenAt = 0;
  private drawn = "";
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private gesture: { moved: number; pinch: number; at: number } | null = null;
  private tapped = false;

  constructor() {
    this.ctx = this.canvas.getContext("2d", { alpha: false })!;
    this.view.append(this.canvas, this.text, this.input, this.ended);
    const bar = h("div", { class: "term-keys", role: "toolbar", "aria-label": "Keys" });
    for (const [label, key, name] of BAR) bar.append(this.key(label, name, () => this.source?.typeKeys([key]), { "data-key": key }));
    bar.append(this.key("⌨", "Keyboard", () => this.input.focus(), { "data-keyboard": "" }));
    this.fitButton = this.key("Fit", "Fit to phone", () => this.toggleFit(), { "data-fit": "", "aria-pressed": "false" });
    bar.append(this.fitButton);
    this.el.append(this.view, bar);
    new ResizeObserver(() => this.measure()).observe(this.view);
    void document.fonts?.load(`400 16px ${FONT}`).then(() => this.measure());
    this.listen();
  }

  /** Watch the terminal of `tile` in `workspace`, until `unwatch`. */
  watch(app: App, workspace: string, tile: string): void {
    this.unwatch();
    this.wanted = { app, workspace, tile };
    this.retry();
  }

  /** Start watching what is wanted, if the phone could not yet. */
  retry(): void {
    const w = this.wanted;
    if (!w || this.stop) return;
    const watched = w.app.terminal(w.workspace, w.tile, () => this.changed(), (why) => {
      this.ended.textContent = why;
      this.ended.hidden = false;
    });
    if (!watched) return;
    this.stop = watched.stop;
    this.draws(watched.source);
  }

  /** Watched no more: if it was fitted, it takes back the size it had. */
  unwatch(): void {
    const stop = this.stop;
    this.wanted = null;
    this.stop = null;
    this.ended.hidden = true;
    this.draws(null);
    stop?.();
  }

  /** Draw `source` from now on, from nothing; null: draw nothing. */
  private draws(source: TermSource | null): void {
    this.source = source;
    this.revision = 0;
    this.lines = [];
    this.firstLine = 0;
    this.newest = -1;
    this.following = true;
    this.zoom = 1;
    this.across = 0;
    this.fitted = false;
    this.fitButton.setAttribute("aria-pressed", "false");
    this.drawn = "";
    this.draw();
    this.changed();
  }

  /** The core's screen may have changed: taken and drawn at the next frame. */
  changed(): void {
    if (!this.frame && this.source) this.frame = requestAnimationFrame((t) => this.take(t));
  }

  private take(now: number): void {
    this.frame = 0;
    const source = this.source;
    if (!source) return;
    if (now - this.takenAt < EVERY_MS || source.held) return this.changed();
    this.takenAt = now;
    const update = source.update(this.revision);
    if (update) this.apply(update);
    this.draw();
  }

  /** What changed since the revision drawn: lines the scrollback let go leave from the front, and
   *  every other line keeps its place. */
  private apply(u: Update): void {
    this.revision = u.revision;
    if (u.cols !== this.cols) {
      this.cols = u.cols;
      this.across = 0;
    }
    const count = Math.max(0, u.lineCount - u.firstLine);
    const gone = u.firstLine - this.firstLine;
    if (gone < 0 || gone >= this.lines.length) this.lines = [];
    else if (gone > 0) {
      this.lines.splice(0, gone);
      if (!this.following) this.top = Math.max(0, this.top - gone);
    }
    this.firstLine = u.firstLine;
    this.lines.length = Math.min(this.lines.length, count);
    while (this.lines.length < count) this.lines.push(BLANK);
    for (const line of u.lines) {
      const at = line.index - u.firstLine;
      if (at >= 0 && at < count) this.lines[at] = { text: line.text, runs: line.runs };
    }
    const cursorAt = u.cursorLine - u.firstLine;
    this.cursor = { line: cursorAt, col: u.cursorCol, visible: u.cursorVisible && cursorAt >= 0 && cursorAt < count };
    let written = count - 1;
    while (written >= 0 && this.lines[written]!.text === "") written--;
    this.newest = this.cursor.visible ? Math.max(cursorAt, written) : written;
  }

  /** A cell's width and a line's height, in device pixels. */
  private cell(): { w: number; h: number; font: number } {
    const w = (this.width / Math.max(1, this.cols)) * this.zoom;
    const font = w / this.advance;
    return { w, h: Math.ceil(font * LINE), font };
  }

  /** Whole lines in sight. */
  private inView(): number {
    return Math.max(1, Math.floor(this.height / this.cell().h));
  }

  /** Where the view rests while it follows: the newest line the last in sight. */
  private rest(): number {
    return Math.max(0, this.newest - this.inView() + 1);
  }

  private bounds(): void {
    const { w } = this.cell();
    const lastTop = Math.max(0, this.lines.length - this.inView());
    if (this.following) this.top = this.rest();
    this.top = Math.min(Math.max(0, this.top), lastTop);
    this.across = Math.min(Math.max(0, this.across), Math.max(0, w * this.cols - this.width));
  }

  private draw(): void {
    if (!this.width || !this.height) return;
    this.bounds();
    const ctx = this.ctx;
    const { w, h: lh, font } = this.cell();
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.textBaseline = "middle";
    const first = Math.floor(this.top);
    const offset = -(this.top - first) * lh;
    const last = Math.min(this.lines.length, first + Math.ceil(this.height / lh) + 1);
    let shownFont = "";
    const texts: string[] = [];
    for (let at = first; at < last; at++) {
      const line = this.lines[at]!;
      texts.push(line.text);
      const y = offset + (at - first) * lh;
      const runs = new DataView(line.runs.buffer, line.runs.byteOffset, line.runs.byteLength);
      for (let r = 0; r + 16 <= runs.byteLength; r += 16) {
        const start = runs.getUint16(r, true);
        const len = runs.getUint16(r + 2, true);
        const col = runs.getUint16(r + 4, true);
        const flags = runs.getUint16(r + 6, true);
        const fgSpec = runs.getUint32(r + 8, true);
        const bgSpec = runs.getUint32(r + 12, true);
        const inverse = (flags & 16) !== 0;
        const fg = inverse ? colour(bgSpec, BG) : colour(fgSpec, FG);
        const bg = inverse ? colour(fgSpec, FG) : bgSpec >>> 24 ? colour(bgSpec, BG) : null;
        const x = col * w - this.across;
        const cells = flags & 256 ? 2 : len;
        if (x > this.width || x + cells * w < 0) continue;
        if (bg) {
          ctx.fillStyle = bg;
          ctx.fillRect(x, y, cells * w + 0.5, lh);
        }
        if (flags & 64) continue;
        const style = `${flags & 4 ? "italic " : ""}${flags & 1 ? 600 : 400} ${font}px ${FONT}`;
        if (style !== shownFont) ctx.font = shownFont = style;
        ctx.fillStyle = fg;
        ctx.globalAlpha = flags & 2 ? 0.6 : 1;
        ctx.fillText(line.text.slice(start, start + len), x, y + lh / 2);
        if (flags & 40) {
          const ly = flags & 8 ? y + lh - Math.max(1, lh / 14) : y + lh / 2;
          ctx.fillRect(x, ly, cells * w, Math.max(1, lh / 14));
        }
      }
      ctx.globalAlpha = 1;
      if (this.cursor.visible && this.cursor.line === at) {
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = FG;
        ctx.fillRect(this.cursor.col * w - this.across, y, w, lh);
        ctx.globalAlpha = 1;
      }
    }
    this.readable(texts);
  }

  /** The lines in sight, as text, made again only when they change. */
  private readable(texts: string[]): void {
    const now = texts.join("\n");
    if (now === this.drawn) return;
    this.drawn = now;
    const rows = this.text.children;
    for (let i = 0; i < texts.length; i++) {
      const row = rows[i] ?? this.text.appendChild(h("div", {}));
      if (row.textContent !== texts[i]) row.textContent = texts[i]!;
    }
    while (rows.length > texts.length) rows[rows.length - 1]!.remove();
  }

  private measure(): void {
    const box = this.view.getBoundingClientRect();
    this.dpr = devicePixelRatio || 1;
    this.width = Math.round(box.width * this.dpr);
    this.height = Math.round(box.height * this.dpr);
    if (!this.width || !this.height) return;
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.ctx.font = `400 100px ${FONT}`;
    this.advance = this.ctx.measureText("M").width / 100 || 0.6;
    this.draw();
  }

  /** Size the terminal to this view at a readable size, or give it back the one it had. */
  private toggleFit(): void {
    const source = this.source;
    if (!source) return;
    this.fitted = !this.fitted;
    this.fitButton.setAttribute("aria-pressed", String(this.fitted));
    if (!this.fitted) return source.unfit();
    const box = this.view.getBoundingClientRect();
    const cols = Math.max(20, Math.floor(box.width / (READABLE * this.advance)));
    const rows = Math.max(5, Math.floor(box.height / Math.ceil(READABLE * LINE)));
    this.zoom = 1;
    this.across = 0;
    this.following = true;
    source.fit(cols, rows);
  }

  private key(label: string, name: string, press: () => void, props: Record<string, string>): HTMLButtonElement {
    const b = h("button", { type: "button", class: "term-key", "aria-label": name, ...props }, label);
    // The keyboard stays up: the press never takes the focus from the input.
    b.addEventListener("pointerdown", (e) => e.preventDefault());
    b.addEventListener("click", press);
    return b;
  }

  private listen(): void {
    const v = this.view;
    v.addEventListener("pointerdown", (e) => {
      v.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.gesture = { moved: this.pointers.size > 1 ? Infinity : 0, pinch: this.spread(), at: e.timeStamp };
    });
    v.addEventListener("pointermove", (e) => {
      const was = this.pointers.get(e.pointerId);
      if (!was || !this.gesture) return;
      const dx = e.clientX - was.x;
      const dy = e.clientY - was.y;
      was.x = e.clientX;
      was.y = e.clientY;
      if (this.pointers.size >= 2) {
        const spread = this.spread();
        if (this.gesture.pinch > 0 && spread > 0) this.zoomBy(spread / this.gesture.pinch, this.centre());
        this.gesture.pinch = spread;
        return;
      }
      this.gesture.moved += Math.abs(dx) + Math.abs(dy);
      this.pan(dx * this.dpr, dy * this.dpr);
    });
    const up = (e: PointerEvent) => {
      if (!this.pointers.delete(e.pointerId)) return;
      const g = this.gesture;
      if (this.pointers.size === 0) {
        this.gesture = null;
        this.tapped = !!g && g.moved < 8 && e.timeStamp - g.at < 400;
      } else if (g) g.pinch = this.spread();
    };
    v.addEventListener("pointerup", up);
    v.addEventListener("pointercancel", up);
    // A tap: the keyboard. On its click, as the mousedown a touch makes first would take the focus.
    v.addEventListener("click", () => {
      if (this.tapped) this.input.focus();
      this.tapped = false;
    });
    v.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (e.ctrlKey) this.zoomBy(Math.exp(-e.deltaY / 200), (e.clientX - v.getBoundingClientRect().left) * this.dpr);
      else this.pan(-e.deltaX * this.dpr, -e.deltaY * this.dpr);
    }, { passive: false });

    const input = this.input;
    input.addEventListener("keydown", (e) => {
      const source = this.source;
      if (!source || e.isComposing || e.metaKey || e.altKey) return;
      if (e.ctrlKey && e.key.length === 1 && /[a-z@[\\\]^_]/i.test(e.key)) {
        e.preventDefault();
        source.typeText(String.fromCharCode(e.key.toUpperCase().charCodeAt(0) & 31));
        return;
      }
      const key = KEYS[e.key];
      if (!key || e.ctrlKey) return;
      e.preventDefault();
      source.typeKeys([key]);
    });
    input.addEventListener("beforeinput", (e) => {
      const source = this.source;
      if (!source || e.isComposing) return;
      if (e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") {
        e.preventDefault();
        source.typeKeys(["enter"]);
      } else if (e.inputType === "deleteContentBackward" && input.value === "") {
        e.preventDefault();
        source.typeKeys(["backspace"]);
      }
    });
    input.addEventListener("input", (e) => {
      if ((e as InputEvent).isComposing) return;
      this.typeWhatIsIn();
    });
    input.addEventListener("compositionend", () => this.typeWhatIsIn());
  }

  private typeWhatIsIn(): void {
    const text = this.input.value;
    this.input.value = "";
    if (text) this.source?.typeText(text);
  }

  /** Move the view by `dx`, `dy` device pixels: up from the newest stops following it; back down
   *  to it follows again. */
  private pan(dx: number, dy: number): void {
    const { h: lh } = this.cell();
    this.across -= dx;
    if (dy !== 0) {
      this.top -= dy / lh;
      if (dy > 0) this.following = false;
      this.bounds();
      if (!this.following && this.top >= this.rest()) this.following = true;
    }
    this.draw();
  }

  /** Zoom by `factor`, the point `x` (device pixels across the view) staying where it is. */
  private zoomBy(factor: number, x: number): void {
    const next = Math.min(MAX_ZOOM, Math.max(1, this.zoom * factor));
    const applied = next / this.zoom;
    this.zoom = next;
    this.across = (this.across + x) * applied - x;
    this.draw();
  }

  private spread(): number {
    const [a, b] = [...this.pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  private centre(): number {
    const [a, b] = [...this.pointers.values()];
    const left = this.view.getBoundingClientRect().left;
    return a && b ? ((a.x + b.x) / 2 - left) * this.dpr : 0;
  }
}
