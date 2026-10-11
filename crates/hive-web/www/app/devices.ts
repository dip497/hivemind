// Devices (the Android app's DevicesScreen): the computer this browser is paired with and whether it
// is reached, the person's other computers and hosts it tells of, this browser's own id, and
// forgetting the computer, which it is told.

import { Ask, h, pill } from "./dom.js";
import type { Others, Paired } from "./types.js";

const KINDS: Record<string, string> = { app: "computer", host: "host" };

export class Devices {
  readonly el = h("section", { class: "screen", "data-screen": "devices" });
  private readonly title = h("h1", { class: "title" }, "Devices");
  private readonly computer = h("article", { class: "card device" });
  private readonly others = h("div", { class: "list", "data-others": "" });
  private readonly id = h("p", { class: "mono" });
  private readonly reached = h("p", { class: "status mono" });
  private readonly forgetting: Ask;
  private paired: Paired | null = null;

  constructor(forget: () => void) {
    this.forgetting = new Ask("Forget", forget, { "data-forget-ask": "" });
    this.el.append(
      this.title,
      h("div", { class: "list" }, this.computer),
      this.others,
      h("div", { class: "list" },
        h("article", { class: "card device" }, h("span", { class: "label-small" }, "This browser"), this.id),
        this.forgetting.el,
        pill("Forget this computer", () => this.paired && this.forgetting.ask(`Forget ${this.paired.with.name}? Each forgets the other. To pair again, scan the code on it.`), "danger", { "data-forget": "" })));
  }

  show(id: string, paired: Paired | null): void {
    this.id.textContent = id;
    this.id.dataset.id = id;
    this.paired = paired;
    this.forgetting.el.hidden = true;
    this.title.textContent = "Devices";
    this.others.replaceChildren();
    if (!paired) return this.computer.replaceChildren();
    this.computer.dataset.paired = paired.with.device;
    this.computer.replaceChildren(
      h("span", { class: "label-small" }, "Your computer"),
      h("h3", {}, paired.with.name),
      h("p", { class: "mono" }, paired.with.device),
      this.reached);
  }

  /** The person's other devices, as the computer tells of them. */
  showOthers(o: Others): void {
    this.title.textContent = o.whose ? `${o.whose}'s devices` : "Devices";
    const through = this.paired?.with.name ?? "your computer";
    this.others.replaceChildren(...o.devices.map((d) =>
      h("article", { class: "card device", "data-other": d.device },
        h("span", { class: "label-small" }, KINDS[d.kind] ?? d.kind),
        h("h3", {}, d.name),
        h("p", { class: "mono" }, d.device),
        h("p", { class: "status mono" }, `paired with ${through}`))));
  }

  status(live: boolean, error: string | null): void {
    this.reached.textContent = live ? "connected" : error ? `not reached: ${error}` : "connecting…";
    this.reached.classList.toggle("problem", !live && error !== null);
  }
}
