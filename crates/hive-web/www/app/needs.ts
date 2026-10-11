// Needs you (the Android app's NeedsScreen): what waits on the person, the longest first, each with
// its agent, where it runs, why it waits and for how long, and its answers on the card.

import type { App } from "./app.js";
import { answers } from "./answers.js";
import { Keyed, h, say } from "./dom.js";
import type { Agent, Overview } from "./types.js";
import { ago, kindLabel, noneWaiting, where } from "./words.js";

export class Needs {
  readonly el = h("section", { class: "screen", "data-screen": "needs" });
  private readonly count = h("span", { class: "count", hidden: true, "data-count": "" });
  private readonly list = h("div", { class: "list", "data-needs": "" });
  private readonly clear = h("p", { class: "clear", hidden: true, "data-working": "" });
  private readonly cards: Keyed<Agent>;

  constructor(private readonly app: App) {
    this.el.append(h("h1", { class: "title" }, "Needs you", this.count), this.list, this.clear);
    this.cards = new Keyed(this.list, (a) => a.tile, (a) => JSON.stringify([a.agent, a.name, a.machine, a.waiting]), (a) => this.card(a));
  }

  show(o: Overview): void {
    this.cards.set(o.needs);
    this.count.hidden = o.needs.length === 0;
    say(this.count, String(o.needs.length));
    this.clear.hidden = o.needs.length > 0;
    say(this.clear, noneWaiting(o.working));
  }

  private card(a: Agent): HTMLElement {
    const w = a.waiting!;
    const card = h("article", { class: "card rail need", "data-need": a.tile, "data-kind": w.kind },
      h("div", { class: "head" },
        h("h3", { class: "name" }, a.agent),
        h("span", { class: "age mono", "data-since": w.since }, ago(w.since))),
      h("p", { class: "where mono" }, where(a.name, a.machine)),
      h("p", { class: "kind" }, kindLabel(w.kind)),
      answers(a.tile, w, (reply) => this.app.answer(a, reply)));
    card.addEventListener("click", () => this.app.open(a.tile));
    return card;
  }
}
