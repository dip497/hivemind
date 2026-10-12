// What an agent and the person say to each other, as a chat (the Android app's ChatView): the
// person's words in bubbles, the agent's as light markdown, each tool it used as one row whose
// result unfolds under it. Append-only, by entry id; it follows the newest until the person
// scrolls up. A long conversation is drawn newest first, a slice a task, so the screen shows at once
// and a tap waits on no more than a slice.

import { h, icon } from "./dom.js";
import { markdown } from "./markdown.js";
import type { Entry, Piece } from "./types.js";

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

  constructor() {
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
    const row = rowOf(e);
    if (!e.tool) return row;
    this.tools.set(e.tool.id, row);
    this.drawing.delete(e.tool.id);
    const result = this.given.get(e.tool.id);
    if (result) gaveBack(row, result);
    this.given.delete(e.tool.id);
    return row;
  }
}

function rowOf(e: Entry): HTMLElement {
  const props = { "data-entry": e.id, "data-who": e.who };
  if (e.tool) return toolRow(e.tool.name, e.tool.about, props);
  if (e.result) {
    // What a tool gave back, its use told before what is shown began.
    const row = toolRow("Result", undefined, props);
    gaveBack(row, e.result);
    return row;
  }
  if (e.who === "person") return h("div", { class: "said-person", ...props }, e.text ?? "");
  return h("div", { class: "said-agent md", ...props }, ...markdown(e.text ?? ""));
}

/** A tool used: a mark for how it went, `name · about` in mono; tapped, what it gave back. */
function toolRow(name: string, about: string | undefined, props: Record<string, string>): HTMLElement {
  const button = h("button", { type: "button", "aria-expanded": "false", disabled: true },
    h("span", { class: "mark mono" }, "○"),
    h("span", { class: "label mono" }, h("b", {}, name), about ? ` · ${about}` : ""),
    icon("chevron", "chev"));
  const result = h("pre", { class: "mono", hidden: true });
  const row = h("div", { class: "tool", ...props }, button, result);
  button.addEventListener("click", () => {
    const open = result.hidden === true;
    result.hidden = !open;
    row.toggleAttribute("data-open", open);
    button.setAttribute("aria-expanded", String(open));
  });
  return row;
}

function gaveBack(row: HTMLElement, result: Result): void {
  row.dataset.ended = result.error ? "failed" : "ok";
  row.querySelector(".mark")!.textContent = result.error ? "✕" : "✓";
  row.querySelector("pre")!.textContent = result.text;
  row.querySelector("button")!.disabled = false;
}
