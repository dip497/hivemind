// What an agent and the person say to each other, as a chat (the Android app's ChatView): the
// person's words in bubbles, the agent's as light markdown, each tool it used as one row that
// unfolds to its input and what it gave back, whole, asked of the computer when first opened; tools
// used one after another fold into one row counting them, and what the agent's own program wrote
// into one quiet line. Append-only, by entry id; it follows the newest until the person
// scrolls up. A long conversation is drawn newest first, a slice a task, so the screen shows at once
// and a tap waits on no more than a slice.

import { h, icon, pill, say } from "./dom.js";
import { markdown } from "./markdown.js";
import type { Entry, Piece, Unfolded } from "./types.js";
import { message } from "./words.js";

type Result = NonNullable<Entry["result"]>;

/** How far before it was sent a session file's record of a message may say it was said, the
 *  computer's clock and the phone's apart. */
const SKEW_MS = 5 * 60_000;

/** A message of the person's, shown at the foot of the chat from when it is sent until the session
 *  file has it: going, then sent, or held until the agent's turn ends, with a way to send it now
 *  when `now` is given; failed, with `again` to try again and `back` to put it back in the box, which
 *  says whether it could. */
export interface Sending {
  /** How much has gone, of 1; 0 when it cannot be told. */
  going(part: number): void;
  sent(): void;
  held(now?: () => Promise<boolean>): void;
  failed(why: string, again: () => void, back: () => boolean): void;
}

/** Where an agent attached a photo, its mark in the message: "[Image #2]". */
const PHOTO_MARK = /\[Image #\d+\]\s*/g;
const wordsOf = (text: string): string => text.replace(PHOTO_MARK, "").trim();
/** What an agent given a photo as a path adds after the person's words: those paths and no more. */
const onlyPaths = (text: string): boolean => text.split(/\s+/).every((word) => !word || /[/\\]/.test(word));

/** How long one task draws for. */
const SLICE_MS = 12;
/** Scrolled this far up from the newest, a button brings it back (hapi
 *  web/src/components/AssistantChat/HappyThread.tsx:287-327). */
const AWAY_PX = 200;

export class Chat {
  readonly el = h("div", { class: "chat", "data-chat": "" });
  /** Back to the newest, counting what came since the person scrolled up; placed by the screen. */
  readonly newest = h("button", { type: "button", class: "newest", hidden: true, "aria-label": "Newest", "data-newest": "" });
  private unseen = 0;
  /** How far above the newest the person reads: kept as the chat's box changes size, the keyboard
   *  coming up among them. */
  private away = 0;
  private readonly nothing = h("p", { class: "ended", hidden: true }, "Nothing said yet");
  /** Until the computer first answers. */
  private readonly loading = h("p", { class: "ended loading", role: "status", "data-loading": "" }, h("span", { class: "dot", "data-state": "working" }), "Loading chat…");
  private ids = new Set<string>();
  private tools = new Map<string, HTMLElement>();
  /** What a tool gave back before its row was drawn, by the tool's id. */
  private given = new Map<string, Result>();
  /** Tools whose rows are still to be drawn. */
  private drawing = new Set<string>();
  private session = "";
  /** The person's messages not yet in the session file, oldest first, with when each was sent. */
  private pending: Array<{ el: HTMLElement; text: string; photos: HTMLElement | null; at: number; arrived?: () => void }> = [];
  /** The thumbnails of photos sent from here, by the entry that has their message. */
  private photosOf = new Map<string, HTMLElement>();

  /** `unfold`: a tool use of its, whole; none, a tool shows what it gave back as sent. */
  constructor(private readonly unfold?: (use: string) => Promise<Unfolded>) {
    this.el.append(this.loading, this.nothing);
    this.el.addEventListener("scroll", () => this.placed(), { passive: true });
    new ResizeObserver(() => (this.el.scrollTop = this.el.scrollHeight - this.el.clientHeight - this.away)).observe(this.el);
    this.newest.addEventListener("click", () => {
      this.el.scrollTop = this.el.scrollHeight;
      this.placed();
    });
  }

  said(piece: Piece): void {
    // Another session began: what was said before it is not this conversation.
    if (this.session && piece.session !== this.session) this.clear();
    this.session = piece.session;
    this.loading.remove();
    const following = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 48;
    const fresh: Entry[] = [];
    for (const e of piece.entries) {
      if (this.ids.has(e.id)) continue;
      this.ids.add(e.id);
      if (e.who === "person") this.arrived(e);
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
    this.nothing.hidden = this.ids.size > 0 || this.pending.length > 0;
    if (!fresh.length) return;
    let next = fresh.length;
    let older: HTMLElement | null = null;
    const slice = (): void => {
      const t = performance.now();
      const rows: HTMLElement[] = [];
      while (next > 0 && (!rows.length || performance.now() - t < SLICE_MS)) rows.unshift(this.row(fresh[--next]!));
      const news = rows.filter((row) => !row.classList.contains("said-program")).length;
      if (!older) {
        // Above what is still being sent, which stays at the foot.
        const foot = this.pending[0]?.el;
        if (foot) foot.before(...rows);
        else this.el.append(...rows);
        this.fold();
        if (following) this.el.scrollTop = this.el.scrollHeight;
        else this.unseen += news;
        this.placed();
      } else {
        // What the person sees stays where it is as what was said before goes in above it.
        const below = this.el.scrollHeight - this.el.scrollTop;
        older.before(...rows);
        this.fold();
        this.el.scrollTop = this.el.scrollHeight - below;
      }
      // The chat's own child it went into, a fold perhaps.
      older = rows[0]!.closest<HTMLElement>("[data-chat] > *");
      if (next > 0) setTimeout(slice);
    };
    slice();
  }

  /** `text`, sent at `at` with the photos whose thumbnails `photos` draws: shown at the foot as
   *  going, until the session file has it, when `arrived` is told. */
  sending(text: string, photos: string[] = [], at = Date.now(), arrived?: () => void): Sending {
    const state = h("span", {}, "Sending…");
    const line = h("p", { class: "pending-state", "data-pending-state": "" }, state);
    const bar = h("span", { class: "pending-bar", hidden: true, "data-pending-bar": "" });
    const thumbs = photos.length ? h("div", { class: "photos", "data-pending-photos": "" }, ...photos.map((src) => h("span", { class: "photo" }, h("img", { src, alt: "" })))) : null;
    const el = h("div", { class: "pending", "data-pending": "going" }, thumbs, text ? h("div", { class: "said-person", "data-who": "person" }, text) : null, bar, line);
    const mine = { el, text: text.trim(), photos: thumbs, at, ...(arrived ? { arrived } : {}) };
    this.pending.push(mine);
    this.el.append(el);
    this.nothing.hidden = true;
    this.el.scrollTop = this.el.scrollHeight;
    this.placed();
    /** Its line says `words`, with these buttons after them; the bar is for what goes. */
    const tell = (stage: string, words: string, ...buttons: HTMLElement[]): void => {
      const following = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 48;
      el.dataset.pending = stage;
      say(state, words);
      line.replaceChildren(state, ...buttons);
      bar.hidden = true;
      if (following) this.el.scrollTop = this.el.scrollHeight;
    };
    const held = (now?: () => Promise<boolean>): void => tell("held", "Queued · sends when it finishes", ...(now ? [pill("Send now", () => {
      tell("held", "Stopping its turn…");
      now().catch(() => false).then((stopped) => {
        if (!stopped) held(now);
      });
    }, "", { "data-send-now": "" })] : []));
    return {
      going: (part) => {
        tell("going", part > 0 ? `Sending… ${Math.round(part * 100)}%` : "Sending…");
        bar.hidden = part <= 0;
        bar.style.setProperty("--part", String(part));
      },
      sent: () => tell("sent", "Sent"),
      held,
      failed: (why, again, back) => {
        const putBack = pill("Put back", () => {
          if (back()) this.drop(mine);
        }, "compact", { "data-put-back": "" });
        tell("failed", `Not sent. ${why.charAt(0).toUpperCase()}${why.slice(1)}`, pill("Try again", again, "primary compact", { "data-try-again": "" }), putBack);
      },
    };
  }

  /** A message of the person's in the session file: the same one shown as being sent goes. */
  private arrived(e: Entry): void {
    const text = wordsOf(e.text ?? "");
    // With photos, the session file has their paths after the words, or the agent's own marks.
    const mine = this.pending.find((p) => (p.text === text || (p.photos && text.startsWith(p.text) && onlyPaths(text.slice(p.text.length).trim()))) && e.at >= p.at - SKEW_MS);
    if (!mine) return;
    if (mine.photos) this.photosOf.set(e.id, mine.photos);
    mine.arrived?.();
    this.drop(mine);
  }

  private drop(mine: { el: HTMLElement }): void {
    mine.el.remove();
    this.pending = this.pending.filter((p) => p !== mine);
    this.nothing.hidden = this.loading.isConnected || this.ids.size > 0 || this.pending.length > 0;
  }

  /** The newest's button: shown while scrolled away, its count what came since. */
  private placed(): void {
    const away = (this.away = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight);
    if (away < 48) this.unseen = 0;
    this.newest.hidden = away <= AWAY_PX;
    const said = this.unseen > 99 ? "99+" : this.unseen ? String(this.unseen) : "";
    if (this.newest.textContent === said && this.newest.childElementCount === (said ? 0 : 1)) return;
    this.newest.replaceChildren(said || icon("down"));
    this.newest.setAttribute("aria-label", said ? `${said} new, back to the newest` : "Back to the newest");
  }

  /** Why the conversation is told no more. */
  ended(why: string): void {
    this.loading.remove();
    this.nothing.hidden = true;
    this.el.append(h("p", { class: "ended" }, why));
  }

  /** Each run of two or more tool rows next to each other, in one fold (hapi
   *  web/src/chat/toolGroups.ts:270-326); a fold is made again only when its run changed. */
  private fold(): void {
    this.foldNotices();
    let rows: HTMLElement[] = [];
    let folds: HTMLElement[] = [];
    let first: Element | null = null;
    const done = (): void => {
      const same = folds.length === 1 && rows.length === folds[0]!.querySelectorAll(":scope > .tools-list > .tool").length;
      if (rows.length >= 2 && !same) {
        const fold = folds[0] ?? foldOf();
        if (!folds[0]) first!.before(fold);
        fold.querySelector(".tools-list")!.append(...rows);
        for (const other of folds.slice(1)) other.remove();
        summed(fold);
      }
      rows = [];
      folds = [];
      first = null;
    };
    for (const child of [...this.el.children]) {
      if (child.classList.contains("tool")) rows.push(child as HTMLElement);
      else if (child.hasAttribute("data-tools")) {
        folds.push(child as HTMLElement);
        rows.push(...child.querySelectorAll<HTMLElement>(":scope > .tools-list > .tool"));
      } else {
        done();
        continue;
      }
      first ??= child;
    }
    done();
  }

  /** Each run of two or more notices next to each other, in one line that opens to them. */
  private foldNotices(): void {
    let rows: HTMLElement[] = [];
    let folds: HTMLElement[] = [];
    let first: Element | null = null;
    const done = (): void => {
      const same = folds.length === 1 && rows.length === folds[0]!.querySelectorAll(":scope > .said-programs-list > .said-program").length;
      if (rows.length >= 2 && !same) {
        const fold = folds[0] ?? noticesFold();
        if (!folds[0]) first!.before(fold);
        fold.querySelector(".said-programs-list")!.append(...rows);
        for (const other of folds.slice(1)) other.remove();
        noticesSummed(fold);
      }
      rows = [];
      folds = [];
      first = null;
    };
    for (const child of [...this.el.children]) {
      if (child.classList.contains("said-program")) rows.push(child as HTMLElement);
      else if (child.hasAttribute("data-notices")) {
        folds.push(child as HTMLElement);
        rows.push(...child.querySelectorAll<HTMLElement>(":scope > .said-programs-list > .said-program"));
      } else {
        done();
        continue;
      }
      first ??= child;
    }
    done();
  }

  private clear(): void {
    // What is still being sent is not of the session that ended: it stays.
    this.el.replaceChildren(this.nothing, ...this.pending.map((p) => p.el));
    this.ids = new Set();
    this.tools = new Map();
    this.given = new Map();
    this.drawing = new Set();
    this.photosOf = new Map();
  }

  private row(e: Entry): HTMLElement {
    const use = e.tool?.id;
    const row = rowOf(e, use !== undefined && this.unfold ? () => this.unfold!(use) : undefined);
    const photos = this.photosOf.get(e.id);
    if (photos) row.prepend(photos);
    this.photosOf.delete(e.id);
    if (!e.tool) return row;
    this.tools.set(e.tool.id, row);
    this.drawing.delete(e.tool.id);
    const result = this.given.get(e.tool.id);
    if (result) gaveBack(row, result);
    this.given.delete(e.tool.id);
    return row;
  }
}

function rowOf(e: Entry, unfold?: () => Promise<Unfolded>): HTMLElement {
  const props = { "data-entry": e.id, "data-who": e.who };
  if (e.notice) return noticeRow(e.notice, props);
  if (e.tool) return toolRow(e.tool.name, e.tool.about, props, unfold);
  if (e.result) {
    // What a tool gave back, its use told before what is shown began.
    const row = toolRow("Result", undefined, props);
    gaveBack(row, e.result);
    return row;
  }
  if (e.who === "person") return h("div", { class: "said-person", ...props }, wordsOf(e.text ?? ""));
  return h("div", { class: "said-agent md", ...props }, ...markdown(e.text ?? ""));
}

/** A line the agent's own program wrote; tapped, what it says more, when it says more. */
function noticeRow(notice: NonNullable<Entry["notice"]>, props: Record<string, string>): HTMLElement {
  const quiet = notice.quiet ? { "data-quiet": "" } : {};
  const line = h("span", { class: "label", "data-notice-line": "" }, notice.text);
  if (!notice.detail) return h("div", { class: "said-program", ...props, ...quiet }, h("p", {}, line));
  const button = h("button", { type: "button", "aria-expanded": "false" }, line, icon("chevron", "chev"));
  const detail = h("div", { class: "said-program-detail md", hidden: true, "data-notice-detail": "" }, ...markdown(notice.detail));
  const row = h("div", { class: "said-program", ...props, ...quiet }, button, detail);
  button.addEventListener("click", () => {
    const open = !row.hasAttribute("data-open");
    row.toggleAttribute("data-open", open);
    button.setAttribute("aria-expanded", String(open));
    detail.hidden = !open;
  });
  return row;
}

/** A run of notices as one line that opens to them. */
function noticesFold(): HTMLElement {
  const button = h("button", { type: "button", "aria-expanded": "false" }, h("span", { class: "label", "data-notices-summary": "" }), icon("chevron", "chev"));
  const fold = h("div", { class: "said-programs", "data-notices": "" }, button, h("div", { class: "said-programs-list", hidden: true }));
  button.addEventListener("click", () => {
    const open = !fold.hasAttribute("data-open");
    fold.toggleAttribute("data-open", open);
    button.setAttribute("aria-expanded", String(open));
    (fold.lastElementChild as HTMLElement).hidden = !open;
  });
  return fold;
}

/** A fold of notices' line, said again from them: how many say something, those that only say
 *  something is still waiting not counted while others do. One that does says itself. */
function noticesSummed(fold: HTMLElement): void {
  const rows = [...fold.querySelectorAll<HTMLElement>(".said-programs-list > .said-program")];
  const loud = rows.filter((row) => !row.hasAttribute("data-quiet"));
  const lone = loud.length === 1 ? loud[0]!.querySelector("[data-notice-line]")?.textContent : null;
  const count = loud.length || rows.length;
  say(fold.querySelector("[data-notices-summary]")!, lone ?? `${count} background ${count === 1 ? "update" : "updates"}`);
  fold.toggleAttribute("data-quiet", !loud.length);
}

/** What a tool's row and its fold call it: a command is run. */
const VERBS: Record<string, string> = { Bash: "Run", shell: "Run", exec_command: "Run", local_shell: "Run" };
const verb = (name: string) => VERBS[name] ?? name;

/** A fold of tool rows: one row saying how many of each, which unfolds to them. */
function foldOf(): HTMLElement {
  const button = h("button", { type: "button", "aria-expanded": "false" },
    h("span", { class: "label" }, h("span", { "data-tools-summary": "" }), h("span", { class: "failed", "data-tools-failed": "" })),
    icon("chevron", "chev"));
  const fold = h("div", { class: "tools", "data-tools": "" }, button, h("div", { class: "tools-list", hidden: true }));
  button.addEventListener("click", () => {
    const open = !fold.hasAttribute("data-open");
    fold.toggleAttribute("data-open", open);
    button.setAttribute("aria-expanded", String(open));
    (fold.lastElementChild as HTMLElement).hidden = !open;
  });
  return fold;
}

/** A fold's row, said again from its tools. */
function summed(fold: HTMLElement): void {
  const counts = new Map<string, number>();
  let failed = 0;
  for (const row of fold.querySelectorAll<HTMLElement>(".tools-list > .tool")) {
    const name = verb(row.dataset.tool ?? "");
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if (row.dataset.ended === "failed") failed++;
  }
  say(fold.querySelector("[data-tools-summary]")!, [...counts].map(([name, n]) => `${name} ${n}`).join(" · "));
  say(fold.querySelector("[data-tools-failed]")!, failed ? `${failed} failed` : "");
}

/** How each tool row shows what it holds now, by its row. */
const shows = new WeakMap<HTMLElement, () => void>();

/** A tool used: what it did and what to, a command in mono, red once it failed; tapped, what it gave
 *  back, or with `unfold`, its input and what it gave back whole, asked when first opened and again
 *  on an open after it gave back nothing yet. */
function toolRow(name: string, about: string | undefined, props: Record<string, string>, unfold?: () => Promise<Unfolded>): HTMLElement {
  const said = verb(name);
  const button = h("button", { type: "button", "aria-expanded": "false", disabled: !unfold },
    h("span", { class: "label" }, h("b", {}, said), about ? h("span", { class: said === "Run" ? "about mono" : "about" }, about) : ""),
    icon("chevron", "chev"));
  const result = h("pre", { class: "mono", hidden: true });
  const whole = h("div", { class: "whole", hidden: true, "data-unfolded": "" });
  const row = h("div", { class: "tool", "data-tool": name, ...props }, button, whole, result);
  let got: Unfolded | null = null;
  let problem: string | null = null;
  let asking = false;
  const show = (): void => {
    const open = row.hasAttribute("data-open");
    const parts: Array<HTMLElement | null> = [];
    if (got) {
      const input = got.input ?? got.about;
      if (input) parts.push(h("p", { class: "part" }, "Input"), h("pre", { class: "mono", "data-input": "" }, input));
      if (got.result) parts.push(h("p", { class: "part" }, got.result.error ? "Failed" : "Gave back"), h("pre", { class: "mono", "data-gave": "" }, got.result.text));
      if (got.truncated) parts.push(h("p", { class: "part quiet", "data-truncated": "" }, "Cut short: it is longer than the phone is sent."));
    }
    if (asking) parts.push(h("p", { class: "part quiet" }, "Asking…"));
    if (problem) parts.push(h("p", { class: "part problem", "data-unfold-error": "" }, `It could not be unfolded: ${problem}`));
    whole.replaceChildren(...parts.filter((x): x is HTMLElement => x !== null));
    whole.hidden = !open || !whole.childElementCount;
    // What it gave back as sent, until the whole of it is here.
    result.hidden = !open || !!got?.result || !result.textContent;
  };
  shows.set(row, show);
  button.addEventListener("click", () => {
    const open = !row.hasAttribute("data-open");
    row.toggleAttribute("data-open", open);
    button.setAttribute("aria-expanded", String(open));
    if (open && unfold && !got?.result && !asking) {
      asking = true;
      problem = null;
      unfold().then((u) => { got = u; }, (e: unknown) => { problem = message(e); }).finally(() => {
        asking = false;
        show();
      });
    }
    show();
  });
  return row;
}

function gaveBack(row: HTMLElement, result: Result): void {
  row.dataset.ended = result.error ? "failed" : "ok";
  row.querySelector(":scope > pre")!.textContent = result.text;
  row.querySelector("button")!.disabled = false;
  shows.get(row)?.();
  const fold = row.closest<HTMLElement>("[data-tools]");
  if (fold) summed(fold);
}
