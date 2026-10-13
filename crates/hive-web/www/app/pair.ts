// Pairing (the Android app's PairScreen): the link the computer shows under Settings → Your devices →
// Use on your phone, or its offer to connect under Settings → Connect, opened here from its QR code,
// scanned here, or pasted; hive-phone's core reads it and pairs, or connects.

import { h, mark, pill } from "./dom.js";
import type { Connect } from "./phone.js";
import { Scanner } from "./scan.js";
import { deviceName } from "./device-name.js";

export class PairScreen {
  readonly el = h("section", { class: "screen", "data-screen": "pair" });
  private readonly link = h("textarea", { class: "field mono", rows: 3, placeholder: "hivemind://pair/…", "aria-label": "Pairing link", "data-pair-link": "" });
  private readonly name = h("input", { class: "field", value: guessName(), "aria-label": "This device's name", "data-pair-name": "" });
  private readonly title = h("h1", {}, "Pair with hivemind");
  private readonly how = h("p", {}, "On your computer, open Settings → Your devices → Use on your phone, and scan its code, or paste here the link it shows.");
  private readonly replaces = h("p", { class: "problem", hidden: true, "data-pair-replaces": "" });
  private readonly refusedBy = h("p", { class: "problem", hidden: true, "data-pair-refused": "" });
  private readonly said = h("p", { hidden: true, "data-pairing": "" });
  private readonly error = h("p", { class: "problem", hidden: true, "data-pair-error": "" });
  private readonly words = h("p", { class: "words", hidden: true, "data-connect-words": "" });
  private readonly question = h("p", { hidden: true, "data-connect-ask": "" });
  private readonly yes: HTMLButtonElement;
  private readonly no: HTMLButtonElement;
  /** The person's answer to the question, while it is asked. */
  private answer: ((match: boolean) => void) | null = null;
  private readonly button: HTMLButtonElement;
  private readonly keep: HTMLButtonElement;
  private readonly scanner = new Scanner();
  private readonly scan: HTMLButtonElement;

  /** `keep` leaves the pairing as it is, when a link was offered to a page already paired; a code
   *  scanned is `scanned`, once `read` (the wasm's, null until it is compiled) reads one. */
  constructor(
    pair: (link: string, name: string, shown: Connect) => Promise<void>,
    keep: () => void,
    read: () => ((rgba: Uint8Array, width: number, height: number) => string | null) | null,
    scanned: (text: string, name: string) => void,
  ) {
    this.button = pill("Pair", () => void this.run(pair, this.link.value.trim(), this.name.value.trim() || guessName()), "primary", { "data-pair": "" });
    this.keep = pill("Keep", keep, "", { hidden: true, "data-pair-keep": "" });
    this.yes = pill("Yes", () => this.answer?.(true), "primary", { hidden: true, "data-connect-yes": "" });
    this.no = pill("No", () => this.answer?.(false), "", { hidden: true, "data-connect-no": "" });
    this.scan = pill("Scan", () => void this.scanWith(read(), scanned), "", { "data-scan": "" });
    this.el.append(h("div", { class: "pair" },
      mark(), this.title, this.refusedBy, this.how, this.replaces,
      this.scan, this.scanner.el, this.link, this.name, this.button, this.keep, this.said, this.words, this.question, this.yes, this.no, this.error));
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

  /**
   * A link the page was opened with, shown to pair with on a tap and never on its own: anyone can
   * send a link, and pairing with theirs would put their computer where this one is.
   */
  offer(link: string, name: string, computer: { name: string; connect: boolean } | null, now: { name: string } | null): void {
    this.link.value = link;
    this.name.value = name;
    this.refusedBy.hidden = true;
    this.title.textContent = !computer ? "Pair with hivemind" : computer.connect ? `Connect to ${computer.name}?` : `Pair with ${computer.name}?`;
    this.how.textContent = !computer
      ? "This is not a pairing link. On your computer, open Settings → Your devices → Use on your phone."
      : computer.connect
        ? "Connect only to a computer you just asked to connect to, in its Settings → Connect."
        : "Pair only with a computer you just asked to pair with, in its Settings → Your devices.";
    this.button.textContent = computer?.connect ? "Connect" : "Pair";
    this.button.disabled = !computer;
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
    this.how.textContent = "On your computer, open Settings → Your devices → Use on your phone, and scan its code, or paste here the link it shows.";
    this.button.disabled = false;
    this.button.textContent = "Pair";
    this.replaces.hidden = true;
    this.keep.hidden = true;
  }

  /** Pair with `link`, or connect with it, saying so while it does. */
  async run(pair: (link: string, name: string, shown: Connect) => Promise<void>, link: string, name: string): Promise<void> {
    if (!link) return;
    this.error.hidden = true;
    this.said.hidden = false;
    this.said.textContent = "Pairing…";
    this.button.disabled = true;
    try {
      await pair(link, name, this.connecting);
      this.clear();
    } catch (e) {
      this.error.hidden = false;
      this.error.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      this.said.hidden = true;
      this.words.hidden = true;
      this.ask(null);
      this.button.disabled = false;
    }
  }

  private readonly connecting: Connect = {
    asking: (computer) => {
      this.said.textContent = `Connecting to ${computer}…`;
    },
    words: (words) => {
      this.words.hidden = false;
      this.words.textContent = words.join(" · ");
      this.said.textContent = "Waiting on the person at the computer: they say there whether this phone is theirs.";
    },
    match: (person) => new Promise((answer) => {
      this.said.hidden = true;
      this.ask(`${person ? `${person}'s computer` : "The computer"} says this phone is theirs. Do the words match?`);
      this.answer = (match) => {
        this.ask(null);
        this.said.hidden = false;
        this.said.textContent = match ? "Connecting…" : "Telling the computer…";
        answer(match);
      };
    }),
  };

  /** `question` asked, with Yes and No; none: nothing asked. */
  private ask(question: string | null): void {
    this.question.hidden = this.yes.hidden = this.no.hidden = question === null;
    this.question.textContent = question ?? "";
    if (question === null) this.answer = null;
  }
}

/** What this device is likely called, for the computer's list of the person's devices. */
export function guessName(): string {
  return deviceName(navigator.userAgent);
}
