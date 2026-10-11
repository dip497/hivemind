// Devices: the computer this browser is paired with, whether it is reached, this browser's own id,
// and forgetting the computer here (it still lists this browser until unpaired there).

import { h, pill } from "./dom.js";
import type { Paired } from "./types.js";

export class Devices {
  readonly el = h("section", { class: "screen", "data-screen": "devices" });
  private readonly computer = h("article", { class: "card device" });
  private readonly id = h("p", { class: "mono" });
  private readonly reached = h("p", { class: "status mono" });

  constructor(forget: () => void) {
    this.el.append(
      h("h1", { class: "title" }, "Devices"),
      h("div", { class: "list" },
        this.computer,
        h("article", { class: "card device" }, h("span", { class: "label-small" }, "This browser"), this.id),
        pill("Forget this computer", forget, "danger", { "data-forget": "" })));
  }

  show(id: string, paired: Paired | null): void {
    this.id.textContent = id;
    this.id.dataset.id = id;
    if (!paired) return this.computer.replaceChildren();
    this.computer.dataset.paired = paired.with.device;
    this.computer.replaceChildren(
      h("span", { class: "label-small" }, "Your computer"),
      h("h3", {}, paired.with.name),
      h("p", { class: "mono" }, paired.with.device),
      this.reached);
  }

  status(live: boolean, error: string | null): void {
    this.reached.textContent = live ? "connected" : error ? `not reached: ${error}` : "connecting…";
    this.reached.classList.toggle("problem", !live && error !== null);
  }
}
