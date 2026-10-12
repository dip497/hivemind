// Home (spec/home.md, the desktop's Layers panel): what waits on the person, with its answers;
// what is at work; the pinned; then each machine's projects, frames and tiles, each tile with what
// it last said. A search and, with more than one machine, a chip for each. Each list is kept by
// key, so one change redraws one row.

import type { App } from "./app.js";
import { answers } from "./answers.js";
import { Ask, Keyed, chips, h, pill, say } from "./dom.js";
import type { Agent, HomeEntry, HomeTile, Overview, Shown } from "./types.js";
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
  readonly filter: Filter = { query: "", machine: null };

  /** `changed` is called when the person searches or chooses a machine: show again. */
  constructor(private readonly app: App, private readonly changed: () => void) {
    const start = pill("Start", () => (location.hash = "start"), "compact", { "data-start": "" });
    this.el.append(
      h("h1", { class: "title" }, "Home", this.count, start),
      h("div", { class: "find" }, this.search, this.machines),
      this.needsList, this.clear,
      this.workingHead, this.workingList,
      this.pinnedHead, this.pinnedList,
      this.treeList, this.none, this.sheet,
    );
    this.sheet.append(this.sheetName, h("div", { class: "row" },
      this.sheetStop,
      pill("Close", () => {
        const a = this.acted();
        if (a) this.closing.ask(`Close ${a.agent}? It stops, and its tile closes on ${this.app.computer()}.`);
      }, "", { "data-row-close": "" }),
      pill("Cancel", () => this.putAway(), "", { "data-row-cancel": "" })), this.closing.el);
    this.search.addEventListener("input", () => {
      this.filter.query = this.search.value;
      this.changed();
    });
    this.cards = new Keyed(this.needsList, (a) => a.tile, (a) => JSON.stringify([a.agent, a.name, a.machine, a.waiting]), (a) => this.card(a));
    const sig = (e: HomeEntry) => JSON.stringify(e);
    this.working = new Keyed(this.workingList, (e) => e.key, sig, (e) => this.row(e, false));
    this.pinned = new Keyed(this.pinnedList, (e) => e.key, sig, (e) => this.row(e, true));
    this.tree = new Keyed(this.treeList, (e) => e.key, sig, (e) => this.row(e, true));
  }

  show(shown: Shown, o: Overview): void {
    this.overview = o;
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

  private showMachines(machines: string[]): void {
    if (this.filter.machine !== null && !machines.includes(this.filter.machine)) this.filter.machine = null;
    const sig = JSON.stringify([machines, this.filter.machine]);
    if (sig === this.machinesSig) return;
    this.machinesSig = sig;
    this.machines.hidden = machines.length === 0;
    this.machines.replaceChildren(chips(machines, (m) => m, (m) => m === this.filter.machine, (m) => {
      this.filter.machine = this.filter.machine === m ? null : m;
      this.changed();
    }, { "aria-label": "Machines" }));
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

  /** A line of a list; `listed`: in the tree or the pinned, where each tile is listed once. */
  private row(e: HomeEntry, listed: boolean): HTMLElement {
    if (e.of === "machine") return h("h2", { class: "machine", "data-machine": e.name }, e.name);
    if (e.of === "project") {
      // Its +: start an agent there.
      const start = h("button", { type: "button", class: "more", "aria-label": `Start an agent in ${e.name}`, "data-start-in": e.key }, "+");
      const at = new URLSearchParams({ workspace: e.workspace, ...(e.frame ? { frame: e.frame } : {}) });
      start.addEventListener("click", () => (location.hash = `start&${at}`));
      return h("h3", { class: "project", "data-project": e.key }, h("span", { class: "name" }, e.name), start);
    }
    const pad = `--depth:${e.depth}`;
    if (e.of === "frame") {
      const f = e.frame;
      const folder = f.folder && f.folder.name !== f.title ? f.folder.name : null;
      return h("div", { class: "frame", style: pad, "data-frame": e.key },
        h("span", { class: "swatch", style: `background:${f.color}` }),
        h("span", { class: "name" }, f.title),
        folder && h("span", { class: "status mono" }, folder));
    }
    const t = e.tile;
    const agent = t.state !== undefined;
    const shows = [
      h("span", { class: "dot", "data-state": t.state ?? "none" }),
      h("span", { class: "col" },
        h("span", { class: "name" }, t.name),
        h("span", { class: `status mono${t.waiting ? " waits" : ""}`, "data-line": "" }, lineOf(t, e.line))),
      t.since !== undefined && h("span", { class: "age mono", "data-since": t.since }, ago(t.since)),
    ];
    const row = h("div", {
      class: "agent", style: pad, "data-row": e.key, "data-kind": t.kind,
      ...(listed && agent ? { "data-agent": t.id } : {}), ...(listed ? {} : { "data-working-row": t.id }),
      ...(agent ? { "data-state": t.state } : {}),
    });
    if (!agent && !t.terminal) {
      row.append(...shows.filter((n): n is HTMLElement => !!n));
      return row;
    }
    // A shell's row opens its terminal.
    if (!agent) {
      const open = h("button", { type: "button", class: "open" }, ...shows);
      open.addEventListener("click", () => this.app.openTerminal(t.workspace, t.id, t.name));
      row.append(open);
      return row;
    }
    // Tapped, it opens; its ⋯, what can be done to it.
    const open = h("button", { type: "button", class: "open" }, ...shows);
    open.addEventListener("click", () => this.app.open(t.id));
    const more = h("button", { type: "button", class: "more", "aria-label": `What to do with ${t.name}`, "data-row-more": t.id }, "⋯");
    more.addEventListener("click", () => {
      this.acting = e.key;
      this.closing.el.hidden = true;
      this.showSheet();
    });
    row.append(open, more);
    return row;
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
 *  state and what runs it. */
function lineOf(t: HomeTile, line: string | undefined): string {
  const w = t.waiting;
  if (w?.tool) return [w.tool.name, w.tool.about?.split("\n")[0]].filter(Boolean).join(": ");
  if (w?.asks?.[0]) return w.asks[0].question;
  if (w) return kindLabel(w.kind);
  if (line) return line;
  if (t.state) return [stateLabel(t.state), t.program?.label].filter(Boolean).join(" · ");
  return t.kind;
}

/** Working agents past which their dots stop breathing. */
const STILL_PAST = 40;
