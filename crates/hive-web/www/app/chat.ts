// What an agent and the person say to each other, as a chat (the Android app's ChatView): the
// person's words in bubbles, the agent's as light markdown, each tool it used as one row that
// unfolds to its input and what it gave back, whole, asked of the computer when first opened. Append-only, by entry id; it follows the newest until the person
// scrolls up. A long conversation is drawn newest first, a slice a task, so the screen shows at once
// and a tap waits on no more than a slice.

import { h, icon } from "./dom.js";
import { markdown } from "./markdown.js";
import type { Entry, Piece, Unfolded } from "./types.js";
import { message } from "./words.js";

type Result = NonNullable<Entry["result"]>;

/** How long one task draws for. */
const SLICE_MS = 12;

export class Chat {
  readonly el = h("div", { class: "chat", "data-chat": "" });
  private readonly nothing = h("p", { class: "ended", hidden: true }, "Nothing said yet");
  private ids = new Set<string>();
  private tools = new Map<string, HTMLElement>();
  /** What a tool gave back before its row was drawn, by the tool's id. */
  private given = new Map<string, Result>();
  /** Tools whose rows are still to be drawn. */
  private drawing = new Set<string>();
  private session = "";

  /** `unfold`: a tool use of its, whole; none, a tool shows what it gave back as sent. */
  constructor(private readonly unfold?: (use: string) => Promise<Unfolded>) {
    this.el.append(this.nothing);
  }

  said(piece: Piece): void {
    // Another session began: what was said before it is not this conversation.
    if (this.session && piece.session !== this.session) this.clear();
    this.session = piece.session;
    const following = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 48;
    const fresh: Entry[] = [];
    for (const e of piece.entries) {
      if (this.ids.has(e.id)) continue;
      this.ids.add(e.id);
      if (e.result) {
        const use = this.tools.get(e.result.of);
        if (use) {
          gaveBack(use, e.result);
          continue;
        }
        if (this.drawing.has(e.result.of)) {
          this.given.set(e.result.of, e.result);
          continue;
        }
      }
      if (e.tool) this.drawing.add(e.tool.id);
      fresh.push(e);
    }
    this.nothing.hidden = this.ids.size > 0;
    if (!fresh.length) return;
    let next = fresh.length;
    let older: HTMLElement | null = null;
    const slice = (): void => {
      const t = performance.now();
      const rows: HTMLElement[] = [];
      while (next > 0 && (!rows.length || performance.now() - t < SLICE_MS)) rows.unshift(this.row(fresh[--next]!));
      if (!older) {
        this.el.append(...rows);
        if (following) this.el.scrollTop = this.el.scrollHeight;
      } else {
        // What the person sees stays where it is as what was said before goes in above it.
        const below = this.el.scrollHeight - this.el.scrollTop;
        older.before(...rows);
        this.el.scrollTop = this.el.scrollHeight - below;
      }
      older = rows[0]!;
      if (next > 0) setTimeout(slice);
    };
    slice();
  }

  /** Why the conversation is told no more. */
  ended(why: string): void {
    this.nothing.hidden = true;
    this.el.append(h("p", { class: "ended" }, why));
  }

  private clear(): void {
    this.el.replaceChildren(this.nothing);
    this.ids = new Set();
    this.tools = new Map();
    this.given = new Map();
    this.drawing = new Set();
  }

  private row(e: Entry): HTMLElement {
    const use = e.tool?.id;
    const row = rowOf(e, use !== undefined && this.unfold ? () => this.unfold!(use) : undefined);
    if (!e.tool) return row;
    this.tools.set(e.tool.id, row);
    this.drawing.delete(e.tool.id);
    const result = this.given.get(e.tool.id);
    if (result) gaveBack(row, result);
    this.given.delete(e.tool.id);
    return row;
  }
}

function rowOf(e: Entry, unfold?: () => Promise<Unfolded>): HTMLElement {
  const props = { "data-entry": e.id, "data-who": e.who };
  if (e.tool) return toolRow(e.tool.name, e.tool.about, props, unfold);
  if (e.result) {
    // What a tool gave back, its use told before what is shown began.
    const row = toolRow("Result", undefined, props);
    gaveBack(row, e.result);
    return row;
  }
  if (e.who === "person") return h("div", { class: "said-person", ...props }, e.text ?? "");
  return h("div", { class: "said-agent md", ...props }, ...markdown(e.text ?? ""));
}

/** How each tool row shows what it holds now, by its row. */
const shows = new WeakMap<HTMLElement, () => void>();

/** A tool used: a mark for how it went, `name · about` in mono; tapped, what it gave back, or with
 *  `unfold`, its input and what it gave back whole, asked when first opened and again on an open
 *  after it gave back nothing yet. */
function toolRow(name: string, about: string | undefined, props: Record<string, string>, unfold?: () => Promise<Unfolded>): HTMLElement {
  const button = h("button", { type: "button", "aria-expanded": "false", disabled: !unfold },
    h("span", { class: "mark mono" }, "○"),
    h("span", { class: "label mono" }, h("b", {}, name), about ? ` · ${about}` : ""),
    icon("chevron", "chev"));
  const result = h("pre", { class: "mono", hidden: true });
  const whole = h("div", { class: "whole", hidden: true, "data-unfolded": "" });
  const row = h("div", { class: "tool", ...props }, button, whole, result);
  let got: Unfolded | null = null;
  let problem: string | null = null;
  let asking = false;
  const show = (): void => {
    const open = row.hasAttribute("data-open");
    const parts: Array<HTMLElement | null> = [];
    if (got) {
      const input = got.input ?? got.about;
      if (input) parts.push(h("p", { class: "part" }, "Input"), h("pre", { class: "mono", "data-input": "" }, input));
      if (got.result) parts.push(h("p", { class: "part" }, got.result.error ? "Failed" : "Gave back"), h("pre", { class: "mono", "data-gave": "" }, got.result.text));
      if (got.truncated) parts.push(h("p", { class: "part quiet", "data-truncated": "" }, "Cut short: it is longer than the phone is sent."));
    }
    if (asking) parts.push(h("p", { class: "part quiet" }, "Asking…"));
    if (problem) parts.push(h("p", { class: "part problem", "data-unfold-error": "" }, `It could not be unfolded: ${problem}`));
    whole.replaceChildren(...parts.filter((x): x is HTMLElement => x !== null));
    whole.hidden = !open || !whole.childElementCount;
    // What it gave back as sent, until the whole of it is here.
    result.hidden = !open || !!got?.result || !result.textContent;
  };
  shows.set(row, show);
  button.addEventListener("click", () => {
    const open = !row.hasAttribute("data-open");
    row.toggleAttribute("data-open", open);
    button.setAttribute("aria-expanded", String(open));
    if (open && unfold && !got?.result && !asking) {
      asking = true;
      problem = null;
      unfold().then((u) => { got = u; }, (e: unknown) => { problem = message(e); }).finally(() => {
        asking = false;
        show();
      });
    }
    show();
  });
  return row;
}

function gaveBack(row: HTMLElement, result: Result): void {
  row.dataset.ended = result.error ? "failed" : "ok";
  row.querySelector(".mark")!.textContent = result.error ? "✕" : "✓";
  row.querySelector(":scope > pre")!.textContent = result.text;
  row.querySelector("button")!.disabled = false;
  shows.get(row)?.();
}
