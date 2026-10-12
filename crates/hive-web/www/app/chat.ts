// What an agent and the person say to each other, as a chat (the Android app's ChatView): the
// person's words in bubbles, the agent's as light markdown, each tool it used as one row whose
// result unfolds under it. Append-only, by entry id; it follows the newest until the person
// scrolls up.

import { h, icon } from "./dom.js";
import { markdown } from "./markdown.js";
import type { Entry, Piece } from "./types.js";

export class Chat {
  readonly el = h("div", { class: "chat", "data-chat": "" });
  private readonly nothing = h("p", { class: "ended", hidden: true }, "Nothing said yet");
  private ids = new Set<string>();
  private tools = new Map<string, HTMLElement>();
  private session = "";

  constructor() {
    this.el.append(this.nothing);
  }

  said(piece: Piece): void {
    // Another session began: what was said before it is not this conversation.
    if (this.session && piece.session !== this.session) this.clear();
    this.session = piece.session;
    const following = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 48;
    const added = document.createDocumentFragment();
    for (const e of piece.entries) {
      if (this.ids.has(e.id)) continue;
      this.ids.add(e.id);
      const use = e.result && this.tools.get(e.result.of);
      if (use) {
        gaveBack(use, e.result!);
        continue;
      }
      const row = rowOf(e);
      if (e.tool) this.tools.set(e.tool.id, row);
      added.append(row);
    }
    this.el.append(added);
    this.nothing.hidden = this.ids.size > 0;
    if (following) this.el.scrollTop = this.el.scrollHeight;
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

function gaveBack(row: HTMLElement, result: NonNullable<Entry["result"]>): void {
  row.dataset.ended = result.error ? "failed" : "ok";
  row.querySelector(".mark")!.textContent = result.error ? "✕" : "✓";
  row.querySelector("pre")!.textContent = result.text;
  row.querySelector("button")!.disabled = false;
}
