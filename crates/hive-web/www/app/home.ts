// Home (spec/home.md, the desktop's Layers panel): what waits on the person, with its answers;
// what is at work; the pinned; then each machine's projects, frames and tiles, each tile with what
// it last said. With more than one account, a chip for each; a search, the View menu and, with more
// than one machine, a chip for each. Each
// list is kept by key, so one change redraws one row.

import type { App } from "./app.js";
import { answers } from "./answers.js";
import { Ask, Keyed, agentMark, chips, h, icon, iconButton, pill, say } from "./dom.js";
import { onHold, onSwipe } from "./gestures.js";
import { HomeChoices, VIEW_CHOICES, VIEW_GROUPS } from "./home-choices.js";
import type { Agent, HomeEntry, HomeTile, Mark, Overview, Shown } from "./types.js";
import { ago, kindLabel, noneWaiting, stateLabel, where } from "./words.js";

/** What Home is asked to show by: the words searched for and the machine chosen. */
export interface Filter {
  query: string;
  machine: string | null;
}

export class Home {
  readonly el = h("section", { class: "screen", "data-screen": "home" });
  private readonly count = h("span", { class: "count", hidden: true, "data-count": "" });
  private readonly search = h("input", { type: "search", class: "search", placeholder: "Search", "aria-label": "Search", enterkeyhint: "search", "data-search": "" });
  private readonly machines = h("div", { hidden: true, "data-machines": "" });
  private readonly accountChips = h("div", { class: "find", hidden: true, "data-home-accounts": "" });
  private readonly needsList = h("div", { class: "list", "data-needs": "" });
  private readonly clear = h("p", { class: "quiet", hidden: true, "data-clear": "" });
  private readonly workingHead = h("h2", { class: "section", hidden: true }, "Working");
  private readonly workingList = h("div", { "data-working": "" });
  private readonly pinnedHead = h("h2", { class: "section", hidden: true }, "Pinned");
  private readonly pinnedList = h("div", { "data-pinned": "" });
  private readonly treeList = h("div", { "data-tree": "" });
  private readonly none = h("p", { class: "quiet", hidden: true, "data-none": "" });
  private readonly cards: Keyed<Agent>;
  private readonly working: Keyed<HomeEntry>;
  private readonly pinned: Keyed<HomeEntry>;
  private readonly tree: Keyed<HomeEntry>;
  private machinesSig = "";
  private overview: Overview = { agents: [], needs: [], working: 0 };
  /** What can be done to the agent of a row: shown for one at a time, over the list. */
  private readonly sheetName = h("h3", { class: "name" });
  private readonly sheetStop = pill("Stop", () => void this.act((a) => this.app.stop(a)), "danger", { "data-row-stop": "" });
  private readonly sheet = h("div", { class: "card sheet", hidden: true, role: "dialog", "data-row-actions": "" });
  private readonly closing = new Ask("Close", () => void this.act((a) => this.app.close(a)), { "data-row-close-ask": "" });
  private acting: string | null = null;
  private readonly swipes: { shut(): void };
  readonly filter: Filter = { query: "", machine: null };
  /** The View menu's choices, the folded and the seen: given with each call for Home. */
  readonly choices = new HomeChoices();
  private readonly viewOpen = iconButton("view", "View", () => this.openView(), { class: "icon-button view-open", "data-view-open": "" });
  private readonly chosenDot = h("span", { class: "chosen-dot", hidden: true, "data-view-chosen": "" });
  private readonly viewSheet = h("div", { class: "card sheet view-sheet", hidden: true, role: "dialog", "aria-label": "View", "data-view-sheet": "" });
  private readonly scrim = h("div", { class: "scrim", hidden: true });
  private marks: Record<string, Mark> = {};
  private marksSig = "";
  private readonly drawnMarks = new Map<string, SVGSVGElement>();

  /** `changed` is called when the person searches, chooses a machine or a view, or folds: show again. */
  constructor(private readonly app: App, private readonly changed: () => void) {
    const start = iconButton("plus", "Start an agent", () => (location.hash = "start"), { "data-start": "" });
    this.viewOpen.append(this.chosenDot);
    this.scrim.addEventListener("click", () => this.closeView());
    this.el.append(
      h("h1", { class: "title" }, "Home", this.count, start),
      this.accountChips,
      h("div", { class: "find" }, h("div", { class: "find-row" }, this.search, this.viewOpen), this.machines),
      this.needsList, this.clear,
      this.workingHead, this.workingList,
      this.pinnedHead, this.pinnedList,
      this.treeList, this.none, this.sheet, this.scrim, this.viewSheet,
    );
    void this.choices.load().then(() => {
      this.chosenDot.hidden = !this.choices.chosen();
      this.changed();
    });
    this.sheet.append(this.sheetName, h("div", { class: "row" },
      this.sheetStop,
      pill("Close", () => this.askClose(), "", { "data-row-close": "" }),
      pill("Cancel", () => this.putAway(), "", { "data-row-cancel": "" })), this.closing.el);
    onHold(this.el, (target) => {
      const row = target.closest<HTMLElement>(".agent.swipes");
      if (!row) return false;
      this.acting = row.dataset.row!;
      this.closing.el.hidden = true;
      this.showSheet();
      return true;
    });
    this.swipes = onSwipe(this.el, ".agent.swipes", (row) => this.behind(row));
    this.search.addEventListener("input", () => {
      this.filter.query = this.search.value;
      this.changed();
    });
    this.cards = new Keyed(this.needsList, (a) => a.tile, (a) => JSON.stringify([a.agent, a.name, a.machine, a.waiting]), (a) => this.card(a));
    // A tile's row is drawn again once its agent's mark is in hand.
    const sig = (e: HomeEntry) => JSON.stringify(e) + (e.of === "tile" && e.tile.agent && this.marks[e.tile.agent] ? "+mark" : "");
    this.working = new Keyed(this.workingList, (e) => e.key, sig, (e) => this.row(e, false));
    this.pinned = new Keyed(this.pinnedList, (e) => e.key, sig, (e) => this.row(e, true));
    this.tree = new Keyed(this.treeList, (e) => e.key, sig, (e) => this.row(e, true));
  }

  show(shown: Shown, o: Overview): void {
    this.overview = o;
    this.marks = shown.marks ?? {};
    const marksSig = JSON.stringify(this.marks);
    if (marksSig !== this.marksSig) {
      this.marksSig = marksSig;
      this.drawnMarks.clear();
    }
    if (this.acting) this.showSheet();
    const waiting = new Map(o.needs.map((a) => [`t:${a.workspace}/${a.tile}`, a]));
    const needs = shown.needs.flatMap((key) => waiting.get(key) ?? []);
    this.cards.set(needs);
    this.count.hidden = o.needs.length === 0;
    say(this.count, String(o.needs.length));
    this.clear.hidden = needs.length > 0 || !!this.filter.query || this.filter.machine !== null;
    say(this.clear, noneWaiting(o.working));
    this.working.set(shown.working);
    this.workingHead.hidden = shown.working.length === 0;
    this.pinned.set(shown.pinned);
    this.pinnedHead.hidden = shown.pinned.length === 0;
    this.tree.set(shown.tree);
    this.none.hidden = shown.tree.length + shown.pinned.length > 0;
    say(this.none, this.filter.query || this.filter.machine ? "Nothing matches." : "Nothing open on your computer yet.");
    this.showMachines(shown.machines);
    // Each breathing dot is a layer the browser recomposes on every change: past a few, still.
    const still = o.working > STILL_PAST;
    if (this.el.hasAttribute("data-still") !== still) this.el.toggleAttribute("data-still", still);
  }

  /** A chip for each account this browser is paired with, `active` pressed; with one, none. */
  accounts(accounts: Array<{ person: string; name: string }>, active: string | null, switchTo: (person: string) => void): void {
    this.accountChips.hidden = accounts.length < 2;
    this.accountChips.replaceChildren(...(accounts.length < 2 ? [] : [chips(accounts, (a) => a.name, (a) => a.person === active, (a) => switchTo(a.person), { "aria-label": "Accounts" })]));
  }

  private showMachines(machines: string[]): void {
    if (this.filter.machine !== null && !machines.includes(this.filter.machine)) this.filter.machine = null;
    const sig = JSON.stringify([machines, this.filter.machine]);
    if (sig === this.machinesSig) return;
    this.machinesSig = sig;
    this.machines.hidden = machines.length === 0;
    // All first: every machine's, as when none is chosen.
    this.machines.replaceChildren(chips([null, ...machines], (m) => m ?? "All", (m) => m === this.filter.machine, (m) => {
      this.filter.machine = m === null || this.filter.machine === m ? null : m;
      this.changed();
    }, { "aria-label": "Machines" }));
  }

  private card(a: Agent): HTMLElement {
    const w = a.waiting!;
    const card = h("article", { class: "card need", "data-need": a.tile, "data-kind": w.kind },
      h("div", { class: "head" },
        h("p", { class: "kind" }, h("span", { class: "what" }, kindLabel(w.kind))),
        h("span", { class: "age", "data-since": w.since }, ago(w.since))),
      h("div", {},
        h("h3", { class: "name" }, a.agent),
        h("p", { class: "where" }, where(a.name, a.machine))),
      answers(a.tile, w, (reply) => this.app.answer(a, reply)).el);
    card.addEventListener("click", () => this.app.open(a.tile));
    return card;
  }

  /** A line of a list; `listed`: in the tree or the pinned, where each tile is listed once. */
  private row(e: HomeEntry, listed: boolean): HTMLElement {
    if (e.of === "machine") return h("h2", { class: "machine", "data-machine": e.name }, e.name);
    if (e.of === "project") {
      // Its +: start an agent there.
      const start = h("button", { type: "button", class: "more", "aria-label": `Start an agent in ${e.name}`, "data-start-in": e.key }, icon("plus"));
      const at = new URLSearchParams({ workspace: e.workspace, ...(e.frame ? { frame: e.frame } : {}) });
      start.addEventListener("click", () => (location.hash = `start&${at}`));
      return h("h3", { class: "project", "data-project": e.key },
        this.fold(e.key, e.folded, h("span", { class: "name" }, e.name), ...under(e.count, e.state)), start);
    }
    // Grouped by none, its one section has no heading.
    if (e.of === "section") {
      if (!e.label) return h("h3", { hidden: true, "data-section": e.key });
      return h("h3", { class: "group-head", "data-section": e.key },
        // Grouped by status, the heading already says it.
        this.fold(e.key, e.folded, h("span", { class: "name" }, e.label), ...under(e.count, this.choices.prefs.groupBy === "status" ? undefined : e.state)));
    }
    const pad = `--depth:${e.depth}`;
    if (e.of === "frame") {
      const f = e.frame;
      const folder = f.folder && f.folder.name !== f.title ? f.folder.name : null;
      const worktree = !!f.parentId || f.folder?.kind === "worktree";
      // The frame's colour turned down: it says which one, the state says what needs a look.
      const color = f.color || "var(--text3)";
      const mark = icon(worktree ? "branch" : e.folded ? "folder" : "folderOpen", "folder-mark");
      mark.style.color = `color-mix(in oklab, ${color} 62%, var(--text3))`;
      if (!worktree) mark.style.fill = `color-mix(in oklab, ${color} 22%, transparent)`;
      return h("div", { class: "frame", style: pad, "data-frame": e.key, ...(worktree ? { "data-worktree": "" } : {}) },
        this.fold(e.key, e.folded, mark, h("span", { class: "name" }, f.title),
          folder ? h("span", { class: "folder mono" }, folder) : null, ...under(e.count, e.state)));
    }
    const t = e.tile;
    const agent = t.state !== undefined;
    const shows = [
      h("span", { class: "avatar", "data-mark": t.agent && this.marks[t.agent] ? t.agent : t.agent || t.terminal ? "terminal" : "window" },
        this.markOf(t),
        h("span", { class: "dot", "data-state": t.state ?? "none" })),
      h("span", { class: "col" },
        h("span", { class: "top" },
          h("span", { class: "name" }, t.name),
          t.state === "waiting" && h("span", { class: "needs-you" }, "Needs you"),
          t.since !== undefined && h("span", { class: "age", "data-since": t.since }, ago(t.since))),
        h("span", { class: "under" },
          h("span", { class: `status${t.waiting ? " waits" : ""}`, "data-line": "" }, ...lineOf(t, e.line)),
          e.unread && h("span", { class: "unread", "aria-label": "Unread", "data-unread": "" }))),
    ];
    const row = h("div", {
      class: "agent", style: pad, "data-row": e.key, "data-kind": t.kind,
      ...(listed && agent ? { "data-agent": t.id } : {}), ...(listed ? {} : { "data-working-row": t.id }),
      ...(agent ? { "data-state": t.state } : {}),
    });
    if (!agent && !t.terminal) {
      row.append(...shows);
      return row;
    }
    // A shell's row opens its terminal.
    if (!agent) {
      const open = h("button", { type: "button", class: "open" }, ...shows);
      open.addEventListener("click", () => this.app.openTerminal(t.workspace, t.id, t.name));
      row.append(open);
      return row;
    }
    // Tapped, it opens; held or swiped left, what can be done to it (Home's own listeners).
    const open = h("button", { type: "button", class: "open" }, ...shows);
    open.addEventListener("click", () => this.app.open(t.id));
    row.classList.add("swipes");
    if (t.interrupt && (t.state === "working" || t.state === "waiting")) row.setAttribute("data-stoppable", "");
    row.append(open);
    return row;
  }

  /** What a tile's row shows it is: its agent's mark, a terminal for a shell, else a window. */
  private markOf(t: HomeTile): SVGSVGElement {
    const m = t.agent ? this.marks[t.agent] : undefined;
    if (!m) return icon(t.agent || t.terminal ? "terminal" : "window");
    let drawn = this.drawnMarks.get(t.agent!);
    if (!drawn) this.drawnMarks.set(t.agent!, (drawn = agentMark(m)));
    return drawn.cloneNode(true) as SVGSVGElement;
  }

  /** A heading that folds what is under `key` when tapped, its arrow first. */
  private fold(key: string, folded: boolean, ...shows: Array<Node | null | false>): HTMLButtonElement {
    const button = h("button", { type: "button", class: "fold", "aria-expanded": String(!folded), "data-fold": key },
      icon("chevron", "chev"), ...shows);
    button.addEventListener("click", () => {
      this.choices.fold(key);
      this.changed();
    });
    return button;
  }

  private openView(): void {
    this.drawView();
    this.scrim.hidden = false;
    this.viewSheet.hidden = false;
  }

  private closeView(): void {
    this.scrim.hidden = true;
    this.viewSheet.hidden = true;
  }

  /** The View menu: one choice in each group, the chosen pressed. */
  private drawView(): void {
    const prefs = this.choices.prefs;
    const chose = () => {
      this.chosenDot.hidden = !this.choices.chosen();
      this.drawView();
      this.changed();
    };
    const reset = pill("Reset to defaults", () => {
      this.choices.reset();
      chose();
    }, "", { "data-view-reset": "" });
    reset.toggleAttribute("disabled", !this.choices.chosen());
    this.viewSheet.replaceChildren(
      h("h3", { class: "name" }, "View"),
      ...VIEW_GROUPS.map(([group, label]) => h("div", { class: "view-group", "data-view": group },
        h("p", { class: "label-small" }, label),
        chips<readonly [string, string]>(VIEW_CHOICES[group], ([, word]) => word, ([id]) => id === prefs[group], ([id]) => {
          this.choices.choose(group, id);
          chose();
        }, { "aria-label": label }))),
      reset,
      pill("Done", () => this.closeView(), "primary", { "data-view-done": "" }));
  }

  /** What a row swiped left shows: Stop while its agent can be stopped, and Close. */
  private behind(row: HTMLElement): HTMLElement {
    const key = row.dataset.row!;
    const acting = (then: () => void) => () => {
      this.swipes.shut();
      this.acting = key;
      then();
    };
    return h("div", { class: "behind" },
      row.hasAttribute("data-stoppable") && pill("Stop", acting(() => void this.act((a) => this.app.stop(a))), "", { "data-swipe-stop": "" }),
      pill("Close", acting(() => this.askClose()), "danger", { "data-swipe-close": "" }));
  }

  private askClose(): void {
    const a = this.acted();
    if (!a) return;
    this.showSheet();
    this.closing.ask(`Close ${a.agent}? It stops, and its tile closes on ${this.app.computer()}.`);
  }

  /** The agent the sheet is for, as the computer last said; null once it is gone. */
  private acted(): Agent | null {
    return this.overview.agents.find((a) => `t:${a.workspace}/${a.tile}` === this.acting) ?? null;
  }

  private showSheet(): void {
    const a = this.acted();
    if (!a) return this.putAway();
    say(this.sheetName, a.agent);
    this.sheetStop.hidden = !(a.interrupt && (a.state === "working" || a.state === "waiting"));
    this.sheet.hidden = false;
  }

  private putAway(): void {
    this.acting = null;
    this.sheet.hidden = true;
  }

  private async act(done: (a: Agent) => Promise<unknown>): Promise<void> {
    const a = this.acted();
    this.putAway();
    if (a) await done(a);
  }
}

/** What a tile's row says under its name: what it waits on, else what it last said, else its
 *  state and what runs it. Code in it, a command or what is in backticks, is set as code. */
function lineOf(t: HomeTile, line: string | undefined): Array<string | HTMLElement> {
  const w = t.waiting;
  const about = w?.tool?.about?.split("\n")[0];
  if (w?.tool) return about ? [`${w.tool.name}: `, h("code", {}, about)] : [w.tool.name];
  if (w?.asks?.[0]) return [w.asks[0].question];
  if (w) return [kindLabel(w.kind)];
  if (line) return line.split("`").map((part, i) => (i % 2 ? h("code", {}, part) : part)).filter((p) => p !== "");
  if (t.state) return [[stateLabel(t.state), t.program?.label].filter(Boolean).join(" · ")];
  return [t.kind];
}

/** What a heading says of what is under it: the state that most wants a look, then how many. */
function under(count: number, state: string | undefined): HTMLElement[] {
  const shows: HTMLElement[] = [h("span", { class: "gap" })];
  if (state === "waiting") shows.push(h("span", { class: "needs-you" }, "Needs you"));
  else if (state) shows.push(h("span", { class: "dot", "data-state": state }));
  if (count > 0) shows.push(h("span", { class: "rows", "data-rows": "" }, String(count)));
  return shows;
}

/** Working agents past which their dots stop breathing. */
const STILL_PAST = 40;
