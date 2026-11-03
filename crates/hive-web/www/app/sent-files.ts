// Files an agent sent, as rows in its chat: Download, how much came, then Save. A file stays in
// memory until saved or the chat is left, and is never opened in this page: a blob of a sent page
// would run with this page's origin and reach its keys. Only these picture types are drawn.

import { h, icon } from "./dom.js";
import type { SentFile } from "./types.js";

const PICTURES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
/** Files this small come without asking, the newest few: a save right after a tap needs them here. */
const AHEAD_BYTES = 4 * 1024 * 1024;
const AHEAD_FILES = 3;
/** How long a fetch waits between tries once the connection went, and how many it makes. */
const AGAIN_MS = 2000;
const TRIES = 30;

/** Fetch `file` from `from`, each piece told in order: whether it came whole, false when the
 *  connection went first; refused, it throws why. */
export type FetchFile = (file: SentFile, from: number, got: (piece: Uint8Array) => void) => Promise<boolean>;

/** Where the rows go. */
export interface FileRowsPlace {
  placeFile(row: HTMLElement, at: number): void;
  removeFile(row: HTMLElement): void;
}

export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Hand the bytes on: to the phone's share sheet, where Save to Files is, when it takes them; else
 *  as a download whose type no browser draws. */
async function saveFile(file: SentFile, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  const shared = new File([bytes], file.name, { type: file.type });
  if (navigator.canShare?.({ files: [shared] })) {
    try {
      await navigator.share({ files: [shared] });
      return;
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
    }
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const link = h("a", { href: url, download: file.name, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

class FileRow {
  readonly el: HTMLElement;
  private readonly status = h("span", { class: "sent-file-size", "data-sent-file-status": "" });
  private readonly action = h("button", { type: "button", "data-sent-file-action": "" });
  private readonly bar = h("span", {});
  private readonly barTrack = h("span", { class: "sent-file-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", hidden: true }, this.bar);
  private readonly preview = h("div", { class: "sent-file-preview", hidden: true });
  private bytes: Uint8Array<ArrayBuffer> | null = null;
  private at = 0;
  private fetching = false;
  private gone = false;
  private pictureUrl: string | null = null;

  constructor(readonly file: SentFile, private readonly fetch: FetchFile) {
    this.el = h("div", { class: "sent-file", "data-sent-file": file.id, "data-at": String(file.at) },
      this.preview,
      h("div", { class: "sent-file-row" },
        icon("file", "sent-file-icon"),
        h("div", { class: "sent-file-about" }, h("span", { class: "sent-file-name", "data-sent-file-name": "" }, file.name), this.status),
        this.action),
      this.barTrack);
    this.action.addEventListener("click", () => this.act());
    this.idle(sizeWords(file.size));
  }

  private idle(status: string): void {
    this.status.textContent = status;
    this.action.hidden = false;
    this.action.disabled = false;
    this.action.textContent = "Download";
    this.action.setAttribute("aria-label", `Download ${this.file.name}`);
    this.barTrack.hidden = true;
  }

  private act(): void {
    if (this.complete()) void saveFile(this.file, this.bytes!);
    else void this.get();
  }

  private complete(): boolean {
    return !!this.bytes && this.at >= this.file.size;
  }

  /** Fetch what is not here yet, going on from what is. */
  async get(): Promise<void> {
    if (this.fetching || this.gone || this.complete()) return;
    this.fetching = true;
    this.bytes ??= new Uint8Array(this.file.size);
    this.action.disabled = true;
    this.action.textContent = "Download";
    this.showCame();
    try {
      for (let tried = 0; tried < TRIES && !this.gone; tried++) {
        if (tried) {
          this.status.textContent = "Connection lost. Trying again…";
          await new Promise((resolve) => setTimeout(resolve, AGAIN_MS));
          if (this.gone) return;
        }
        const whole = await this.fetch(this.file, this.at, (piece) => {
          if (this.gone) return;
          this.bytes!.set(piece, this.at);
          this.at += piece.length;
          this.showCame();
        });
        if (whole) return this.saveable();
      }
      if (!this.gone) this.idle("Connection lost. Try again when you're back online.");
      if (!this.gone) this.action.textContent = "Try again";
    } catch {
      if (this.gone) return;
      this.status.textContent = "No longer on the computer.";
      this.action.hidden = true;
      this.barTrack.hidden = true;
      this.release();
    } finally {
      this.fetching = false;
    }
  }

  private showCame(): void {
    const part = this.file.size ? Math.floor((this.at / this.file.size) * 100) : 100;
    this.barTrack.hidden = false;
    this.barTrack.setAttribute("aria-valuenow", String(part));
    this.bar.style.width = `${part}%`;
    this.status.textContent = `${sizeWords(this.at)} of ${sizeWords(this.file.size)}`;
  }

  private saveable(): void {
    this.barTrack.hidden = true;
    this.status.textContent = sizeWords(this.file.size);
    this.action.disabled = false;
    this.action.textContent = "Save";
    this.action.setAttribute("aria-label", `Save ${this.file.name}`);
    if (!PICTURES.has(this.file.type) || this.file.size > AHEAD_BYTES) return;
    this.pictureUrl = URL.createObjectURL(new Blob([this.bytes!], { type: this.file.type }));
    this.preview.replaceChildren(h("img", { src: this.pictureUrl, alt: this.file.name, "data-sent-file-picture": "" }));
    this.preview.hidden = false;
  }

  private release(): void {
    if (this.pictureUrl) URL.revokeObjectURL(this.pictureUrl);
    this.pictureUrl = null;
    this.bytes = null;
    this.at = 0;
  }

  drop(): void {
    this.gone = true;
    this.release();
  }
}

export class FileRows {
  private rows = new Map<string, FileRow>();

  constructor(private readonly place: FileRowsPlace, private readonly fetch: FetchFile, private readonly changed: () => void) {}

  get count(): number {
    return this.rows.size;
  }

  /** The agent's whole list now: rows for what is new, none for what is gone, what came stays. */
  listed(files: SentFile[]): void {
    const now = new Set(files.map((f) => f.id));
    for (const [id, row] of this.rows) {
      if (now.has(id)) continue;
      row.drop();
      this.place.removeFile(row.el);
      this.rows.delete(id);
    }
    for (const file of files) {
      if (this.rows.has(file.id)) continue;
      const row = new FileRow(file, this.fetch);
      this.rows.set(file.id, row);
      this.place.placeFile(row.el, file.at);
    }
    this.fetchAhead(files);
    this.changed();
  }

  private fetchAhead(files: SentFile[]): void {
    if ((navigator as { connection?: { saveData?: boolean } }).connection?.saveData) return;
    for (const file of files.slice(-AHEAD_FILES)) if (file.size <= AHEAD_BYTES) void this.rows.get(file.id)?.get();
  }

  /** The chat is left: nothing it fetched stays in memory. */
  close(): void {
    for (const row of this.rows.values()) row.drop();
    this.rows.clear();
  }
}
