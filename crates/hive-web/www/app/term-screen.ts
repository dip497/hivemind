// A terminal tile that runs no agent: its terminal, and Back.

import type { App } from "./app.js";
import { h, icon, say } from "./dom.js";
import { TerminalView } from "./terminal.js";

export class TermScreen {
  readonly el = h("section", { class: "screen agent-screen", "data-screen": "terminal" });
  private readonly title = h("h1", {});
  private readonly term = new TerminalView();
  private shown = "";

  constructor(private readonly app: App) {
    const back = h("button", { type: "button", class: "back", "aria-label": "Back", "data-back": "" }, icon("back"));
    back.addEventListener("click", () => app.back());
    this.el.append(h("header", { class: "backbar" }, back, h("div", { class: "what" }, this.title)), this.term.el);
  }

  /** Show the terminal of `tile` in `workspace`, called `name`. */
  open(workspace: string, tile: string, name: string): void {
    say(this.title, name || "Terminal");
    const shown = `${workspace}\n${tile}`;
    if (shown === this.shown) return this.term.retry();
    this.shown = shown;
    this.term.watch(this.app, workspace, tile);
  }

  /** Start watching, if it could not yet be known which computer holds it. */
  retry(): void {
    this.term.retry();
  }

  close(): void {
    this.shown = "";
    this.term.unwatch();
  }
}
