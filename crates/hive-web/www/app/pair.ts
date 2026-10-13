// Pairing (the Android app's PairScreen): the link the computer shows under Settings → Devices →
// Pair a phone, opened here from its QR code, scanned here, or pasted; hive-phone's core reads it
// and pairs.

import { h, mark, pill, say } from "./dom.js";
import { Scanner } from "./scan.js";

export class PairScreen {
  readonly el = h("section", { class: "screen", "data-screen": "pair" });
  private readonly link = h("textarea", { class: "field mono", rows: 3, placeholder: "hivemind://pair/…", "aria-label": "Pairing link", "data-pair-link": "" });
  private readonly name = h("input", { class: "field", value: guessName(), "aria-label": "This device's name", "data-pair-name": "" });
  private readonly title = h("h1", {}, "Pair with hivemind");
  private readonly how = h("p", {}, "On your computer, open Settings → Devices → Pair a phone, and scan its code, or paste here the link it shows.");
  private readonly replaces = h("p", { class: "problem", hidden: true, "data-pair-replaces": "" });
  private readonly refusedBy = h("p", { class: "problem", hidden: true, "data-pair-refused": "" });
  private readonly said = h("p", { hidden: true, "data-pairing": "" });
  private readonly error = h("p", { class: "problem", hidden: true, "data-pair-error": "" });
  private readonly button: HTMLButtonElement;
  private readonly keep: HTMLButtonElement;
  private readonly scanner = new Scanner();
  private readonly scan: HTMLButtonElement;

  /** `keep` leaves the pairing as it is, when a link was offered to a page already paired; a code
   *  scanned is `scanned`, once `read` (the wasm's, null until it is compiled) reads one. */
  constructor(
    pair: (link: string, name: string) => Promise<void>,
    keep: () => void,
    read: () => ((rgba: Uint8Array, width: number, height: number) => string | null) | null,
    scanned: (text: string, name: string) => void,
  ) {
    this.button = pill("Pair", () => void this.run(pair, this.link.value.trim(), this.name.value.trim() || guessName()), "primary", { "data-pair": "" });
    this.keep = pill("Keep", keep, "", { hidden: true, "data-pair-keep": "" });
    this.scan = pill("Scan", () => void this.scanWith(read(), scanned), "", { "data-scan": "" });
    this.el.append(h("div", { class: "pair" },
      mark(), this.title, this.refusedBy, this.how, this.replaces,
      this.scan, this.scanner.el, this.link, this.name, this.button, this.keep, this.said, this.error));
  }

  /** The camera, until it reads a code; tapped again, it stops. */
  private async scanWith(read: ((rgba: Uint8Array, width: number, height: number) => string | null) | null, scanned: (text: string, name: string) => void): Promise<void> {
    if (this.scanner.running) return this.stopScan();
    this.error.hidden = true;
    if (!read) return this.fail("Still starting: try again in a moment.");
    this.scan.textContent = "Stop";
    try {
      await this.scanner.start(read, (text) => {
        this.scan.textContent = "Scan";
        scanned(text, this.name.value.trim() || guessName());
      });
    } catch {
      this.stopScan();
      this.fail("The camera can't be opened here. Paste the link instead.");
    }
  }

  /** The camera off, when it was on. */
  stopScan(): void {
    this.scanner.stop();
    this.scan.textContent = "Scan";
  }

  private fail(why: string): void {
    this.error.hidden = false;
    this.error.textContent = why;
  }

  /** A link the page was opened with, shown before the phone can read it: Pair waits, saying so,
   *  since who it pairs with is not yet known. */
  starting(link: string, name: string): void {
    this.link.value = link;
    this.name.value = name;
    this.button.disabled = true;
    say(this.button, "Starting…");
  }

  /**
   * A link the page was opened with, shown to pair with on a tap and never on its own: anyone can
   * send a link, and pairing with theirs would put their computer where this one is.
   */
  offer(link: string, name: string, computer: { name: string } | null, now: { name: string } | null): void {
    this.link.value = link;
    this.name.value = name;
    this.refusedBy.hidden = true;
    this.title.textContent = computer ? `Pair with ${computer.name}?` : "Pair with hivemind";
    this.how.textContent = computer
      ? "Pair only with a computer you just asked to pair with, in its Settings → Devices."
      : "This is not a pairing link. On your computer, open Settings → Devices → Pair a phone.";
    this.button.disabled = !computer;
    say(this.button, "Pair");
    this.replaces.hidden = !now;
    this.replaces.textContent = now ? `This page is paired with ${now.name}; pairing replaces it.` : "";
    this.keep.hidden = !now;
    this.keep.textContent = now ? `Keep ${now.name}` : "Keep";
  }

  /** `computer` turned this browser away: unpaired there, it is to be paired again. */
  refused(computer: string): void {
    this.clear();
    this.title.textContent = "Pair again";
    this.refusedBy.hidden = false;
    this.refusedBy.textContent = `${computer} no longer lets this browser in: it was unpaired there.`;
  }

  /** Back to asking for a link. */
  clear(): void {
    this.refusedBy.hidden = true;
    this.link.value = "";
    this.title.textContent = "Pair with hivemind";
    this.how.textContent = "On your computer, open Settings → Devices → Pair a phone, and scan its code, or paste here the link it shows.";
    this.button.disabled = false;
    say(this.button, "Pair");
    this.replaces.hidden = true;
    this.keep.hidden = true;
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
      this.clear();
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
