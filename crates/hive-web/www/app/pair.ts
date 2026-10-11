// Pairing (the Android app's PairScreen): the link the computer shows under Settings → Devices →
// Pair a phone, opened here from its QR code or pasted; hive-phone's core reads it and pairs.

import { h, mark, pill } from "./dom.js";

export class PairScreen {
  readonly el = h("section", { class: "screen", "data-screen": "pair" });
  private readonly link = h("textarea", { class: "field mono", rows: 3, placeholder: "hivemind://pair/…", "aria-label": "Pairing link", "data-pair-link": "" });
  private readonly name = h("input", { class: "field", value: guessName(), "aria-label": "This device's name", "data-pair-name": "" });
  private readonly said = h("p", { hidden: true, "data-pairing": "" });
  private readonly error = h("p", { class: "problem", hidden: true, "data-pair-error": "" });
  private readonly button: HTMLButtonElement;

  constructor(pair: (link: string, name: string) => Promise<void>) {
    this.button = pill("Pair", () => void this.run(pair, this.link.value.trim(), this.name.value.trim() || guessName()), "primary", { "data-pair": "" });
    this.el.append(h("div", { class: "pair" },
      mark(),
      h("h1", {}, "Pair with hivemind"),
      h("p", {}, "On your computer, open Settings → Devices → Pair a phone, and scan its code with your camera, or paste here the link it shows."),
      this.link, this.name, this.button, this.said, this.error));
  }

  /** Pair with `link`, saying so while it does. */
  async run(pair: (link: string, name: string) => Promise<void>, link: string, name: string): Promise<void> {
    if (!link) return;
    this.error.hidden = true;
    this.said.hidden = false;
    this.said.textContent = "Pairing…";
    this.button.disabled = true;
    try {
      await pair(link, name);
      this.link.value = "";
    } catch (e) {
      this.error.hidden = false;
      this.error.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      this.said.hidden = true;
      this.button.disabled = false;
    }
  }
}

/** What this device is likely called, for the computer's list of the person's devices. */
export function guessName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  return "Browser";
}
