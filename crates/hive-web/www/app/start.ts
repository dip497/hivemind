// Starting an agent: one line on top saying what starts where ("Claude Code · api · this computer"),
// the project it was opened from or else what was last started, which opens the choices (agent,
// workspace, machine, folder); the prompt under it, with + for photos and Start, always in sight,
// which opens the new agent; the agent's mode and model as the desktop offers them. What the computer said last shows at once,
// its answer taking its place when it comes.

import type { App } from "./app.js";
import { chips, h, icon, iconButton, pill } from "./dom.js";
import { PHOTOS_MAX, photoOf } from "./photos.js";
import { get, put } from "./store.js";
import type { Folders, Held, Photo, PlaceFolder, Places, Program } from "./types.js";
import { message } from "./words.js";

type Machine = Places["machines"][number];
/** What was last started from this browser: chosen again the next time, where it still is. */
interface Last { workspace: string; machine: string; folder: string; program: string }
const LAST = "start-last";
/** The workspaces and the places in each, as the computer last said them. */
interface Kept { held: Held[]; places: Record<string, Places> }
export const KEPT = "start-kept";
/** An option left unchosen: the agent starts as the desktop's settings say. */
const AS_SET = "As set in Settings";

/** Labels for `items` by `name`, and where two share a name, by the end of `path` too. */
function apart<T>(items: readonly T[], name: (x: T) => string, path: (x: T) => string | undefined): (x: T) => string {
  const count = new Map<string, number>();
  for (const x of items) count.set(name(x), (count.get(name(x)) ?? 0) + 1);
  return (x) => {
    const p = path(x);
    return count.get(name(x))! > 1 && p ? `${name(x)} · ${p.split("/").filter(Boolean).slice(-2).join("/")}` : name(x);
  };
}

export class StartScreen {
  readonly el = h("section", { class: "screen start-screen", "data-screen": "start" });
  private readonly prompt = h("textarea", { class: "field", rows: 4, placeholder: "What should it do?", "aria-label": "Prompt", "data-start-prompt": "" });
  private readonly photosRow = h("div", { class: "photos", "data-start-photos": "" });
  private readonly summary = h("button", { type: "button", class: "summary", "aria-expanded": "false", "data-start-summary": "" });
  private readonly settings = h("div", { class: "options" });
  private readonly choices = h("div", { class: "choices", hidden: true, "data-start-choices": "" });
  private readonly notes = h("div", { class: "notes" });
  private readonly picker = h("input", { type: "file", accept: "image/*", multiple: true, hidden: true, "data-start-photo-input": "" });
  private readonly go = h("button", { type: "button", class: "send ready", "aria-label": "Start", "data-start-go": "" }, icon("send"));
  private readonly addPhoto: HTMLButtonElement;
  private held: Held[] | null = null;
  private workspace: string | null = null;
  private places: Places | null = null;
  private machine: Machine | null = null;
  /** The folder chosen, and the folders above it inside its project, the project first. */
  private trail: Array<{ name: string; path: string }> = [];
  private project = false;
  private inside: Folders | null = null;
  private program: Program | null = null;
  private readonly options = new Map<string, string>();
  private photos: Array<Photo & { url: string }> = [];
  private problem: string | null = null;
  private last: Last | undefined;
  private kept: Kept = { held: [], places: {} };
  /** Whether the person chose something since it opened: an answer then keeps it. */
  private picked = false;
  /** Whether the last question failed, to be asked again once the computer is reached. */
  private failed = false;
  /** Whether the choices show. */
  private choosing = false;
  /** Each question asked, so an answer to one superseded is dropped; a folder's own count. */
  private asked = 0;
  private looked = 0;
  /** Where it was last opened for. */
  private at: { workspace?: string | null; frame?: string | null } = {};
  /** What this browser keeps, read as the page loads, so a page opened on Start shows it at once. */
  private read: Promise<[Kept | undefined, Last | undefined]> | null = this.reading();

  constructor(private readonly app: App) {
    const back = h("button", { type: "button", class: "back", "aria-label": "Back", "data-back": "" }, icon("back"));
    back.addEventListener("click", () => app.back());
    this.go.addEventListener("click", () => void this.run());
    this.addPhoto = iconButton("plus", "Add photos", () => this.picker.click(), { "data-start-add-photo": "" });
    this.summary.addEventListener("click", () => this.pick(() => (this.choosing = !this.choosing)));
    this.picker.addEventListener("change", () => void this.addPhotos());
    this.el.append(
      h("header", { class: "backbar" }, back, h("div", { class: "what" }, h("h1", {}, "New agent"))),
      h("div", { class: "start" },
        this.summary,
        h("div", { class: "prompt-card" }, this.prompt, this.photosRow, h("div", { class: "prompt-row" }, this.addPhoto, this.go)),
        this.choices, this.settings),
      h("div", { class: "dock" }, this.notes),
      this.picker);
    // A question that failed (the connection dropped): asked again once the computer is reached.
    app.onReach(() => !this.el.hidden && this.failed && void this.ask(this.asked, this.at.workspace, this.at.frame));
  }

  /** Shown afresh, from what the computer said last, then asked again; in `workspace`'s frame
   *  `frame` when given, else where an agent was last started from here, else the first workspace. */
  async open(workspace?: string | null, frame?: string | null): Promise<void> {
    const n = ++this.asked;
    this.at = { workspace, frame };
    this.held = null;
    this.prompt.value = "";
    this.dropPhotos();
    this.choosing = false;
    this.picked = false;
    this.unchoose(null);
    this.prompt.focus();
    const [kept, last] = await (this.read ?? this.reading());
    this.read = null;
    if (n !== this.asked) return;
    this.last = last;
    this.kept = kept ?? { held: [], places: {} };
    if (this.kept.held.length) this.inWorkspace(this.kept.held, workspace, frame);
    this.render();
    await this.ask(n, workspace, frame);
  }

  private reading(): Promise<[Kept | undefined, Last | undefined]> {
    return Promise.all([get<Kept>(KEPT).catch(() => undefined), get<Last>(LAST).catch(() => undefined)]);
  }

  /** What the computer holds now, and the places in the workspace chosen. */
  private async ask(n: number, workspace?: string | null, frame?: string | null): Promise<void> {
    this.failed = false;
    try {
      const held = await this.app.workspaces();
      if (n !== this.asked) return;
      this.keep({ held, places: Object.fromEntries(held.flatMap((w) => (this.kept.places[w.workspace] ? [[w.workspace, this.kept.places[w.workspace]!]] : []))) });
      this.inWorkspace(held, workspace, frame);
      this.render();
      if (this.workspace) await this.askPlaces(n, this.workspace, frame);
    } catch (e) {
      if (n === this.asked) this.fail(e);
    }
  }

  private async askPlaces(n: number, workspace: string, frame?: string | null): Promise<void> {
    try {
      const places = await this.app.places(workspace);
      if (n !== this.asked) return;
      this.keep({ ...this.kept, places: { ...this.kept.places, [workspace]: places } });
      this.inPlaces(places, frame);
    } catch (e) {
      if (n === this.asked) this.fail(e);
    }
    this.render();
  }

  private fail(e: unknown): void {
    this.problem = message(e);
    this.failed = true;
    this.render();
  }

  private keep(kept: Kept): void {
    this.kept = kept;
    void put(KEPT, kept).catch(() => undefined);
  }

  /** Among `held`: the workspace chosen while it is there, else `workspace`, else the last started
   *  from, else the first; in its places as last said, when they were. */
  private inWorkspace(held: Held[], workspace?: string | null, frame?: string | null): void {
    this.held = held;
    const named = held.find((w) => w.workspace === workspace);
    const at = held.find((w) => w.workspace === this.workspace) ?? named ?? held.find((w) => w.workspace === this.last?.workspace) ?? held[0];
    if (at?.workspace !== this.workspace) this.unchoose(at?.workspace ?? null);
    const places = at && this.kept.places[at.workspace];
    if (places) this.inPlaces(places, named === at ? frame : undefined);
  }

  /** The person's choice of workspace: its places as last said at once, then as the computer says. */
  private async choose(workspace: string): Promise<void> {
    const n = ++this.asked;
    this.unchoose(workspace);
    const places = this.kept.places[workspace];
    if (places) this.inPlaces(places);
    this.render();
    await this.askPlaces(n, workspace);
  }

  /** In the workspace's `places`: what the person chose while it is still there, else the machine and
   *  folder of `frame`, else where an agent was last started, else the first. */
  private inPlaces(places: Places, frame?: string | null): void {
    const chose: Last | undefined = this.picked && this.machine && this.workspace
      ? { workspace: this.workspace, machine: this.machine.id, folder: this.trail.at(-1)?.path ?? "", program: this.program?.id ?? "" }
      : undefined;
    this.places = places;
    const there = !chose && frame ? places.machines.find((m) => m.folders.some((f) => f.frame === frame)) : undefined;
    const prefer = chose ?? this.last;
    const was = prefer?.workspace === this.workspace ? prefer.machine : undefined;
    this.onMachine(there ?? places.machines.find((m) => m.id === was) ?? places.machines[0] ?? null, there?.folders.find((f) => f.frame === frame), prefer);
  }

  /** In `workspace`, nothing else chosen yet. */
  private unchoose(workspace: string | null): void {
    this.workspace = workspace;
    this.places = null;
    this.problem = null;
    this.onMachine(null);
  }

  /** On `machine`: in `folder`, else where `prefer` started there, else its first folder; the agent
   *  of `prefer` when it is there, else its first. */
  private onMachine(machine: Machine | null, folder?: PlaceFolder, prefer = this.last): void {
    const program = machine?.programs.find((p) => p.id === prefer?.program) ?? machine?.programs[0] ?? null;
    if (program?.id !== this.program?.id) this.options.clear();
    this.program = program;
    const was = prefer?.workspace === this.workspace && prefer.machine === machine?.id ? prefer.folder : undefined;
    const top = folder
      ?? machine?.folders.find((f) => f.path === was)
      ?? machine?.folders.find((f) => f.kind === "project" && was?.startsWith(`${f.path}/`))
      ?? machine?.folders[0];
    const trail = top ? [{ name: top.name, path: top.path }] : [];
    if (top && top.kind === "project" && was?.startsWith(`${top.path}/`)) {
      for (const name of was.slice(top.path.length + 1).split("/")) trail.push({ name, path: `${trail.at(-1)!.path}/${name}` });
    }
    if (machine?.id !== this.machine?.id || trail.at(-1)?.path !== this.trail.at(-1)?.path) this.inside = null;
    this.machine = machine;
    this.trail = trail;
    this.project = top?.kind === "project";
  }

  private render(): void {
    const heading = (text: string) => h("h2", { class: "label-small" }, text);
    const m = this.machine;
    const ready = !!this.program && this.trail.length > 0 && !m?.unreached;
    // Nothing can start as chosen: the choices show until it can.
    if (this.places && !ready) this.choosing = true;
    const asking = this.held === null && !this.problem;
    const where = m ? (m.id === "" ? "this computer" : m.name) : "";
    this.summary.replaceChildren(
      h("span", { class: "said" }, asking ? "Asking…" : [this.program?.label, this.trail.at(-1)?.name, where].filter(Boolean).join(" · ") || "Choose where"),
      h("span", { class: "chev", "aria-hidden": "true" }, this.choosing ? "▴" : "▾"));
    this.summary.setAttribute("aria-expanded", String(this.choosing));
    this.summary.hidden = this.held?.length === 0;
    this.choices.hidden = !this.choosing;

    this.settings.replaceChildren(...(this.program?.options ?? []).map((option) => {
      const value = this.options.get(option.id) ?? "";
      let control: HTMLSelectElement | HTMLInputElement;
      if (option.values.length) {
        const select = h("select", { class: "field", "aria-label": option.label, "data-start-option": option.id },
          h("option", { value: "" }, AS_SET), ...option.values.map((v) => h("option", { value: v }, v)));
        select.value = value;
        select.addEventListener("change", () => this.options.set(option.id, select.value));
        control = select;
      } else {
        const field = h("input", { class: "field", value, placeholder: AS_SET, autocapitalize: "off", spellcheck: "false", "aria-label": option.label, "data-start-option": option.id });
        field.addEventListener("input", () => this.options.set(option.id, field.value.trim()));
        control = field;
      }
      return h("label", { class: "option" }, h("span", { class: "label-small" }, option.label), control);
    }));

    const parts: Node[] = [];
    if (m?.programs.length) {
      parts.push(heading("Agent"), chips(m.programs, (x) => x.label, (x) => x.id === this.program?.id, (x) => this.pick(() => {
        this.picked = true;
        this.program = x;
        this.options.clear();
      }), { "data-start-programs": "" }));
    }
    if (this.held && this.held.length > 1) {
      const label = apart(this.held, (w) => w.name, (w) => w.repo);
      parts.push(heading("Workspace"), chips(this.held, label, (w) => w.workspace === this.workspace, (w) => void this.choose(w.workspace), { "data-start-workspaces": "" }));
    }
    const p = this.places;
    if (p && p.machines.length > 1) {
      parts.push(heading("Machine"), chips(p.machines, (x) => (x.id === "" ? `${x.name} (this computer)` : x.name), (x) => x.id === m?.id, (x) => this.pick(() => {
        this.picked = true;
        this.onMachine(x);
      }), { "data-start-machines": "" }));
    }
    if (m && !m.unreached) parts.push(...this.folderParts(m, heading));
    this.choices.replaceChildren(...parts);

    const notes: HTMLElement[] = [];
    if (this.held?.length === 0) notes.push(h("p", { class: "quiet" }, `No workspace is open on ${this.app.computer()}: open one in hivemind there.`));
    if (m?.unreached) notes.push(h("p", { class: "problem", "data-start-unreached": "" }, `${m.name} could not be asked which agents it has: ${m.unreached}`));
    else if (m && !m.programs.length) notes.push(h("p", { class: "quiet" }, `No agent is installed on ${m.name}.`));
    if (this.problem) notes.push(h("p", { class: "problem", "data-start-error": "" }, this.problem));
    this.notes.replaceChildren(...notes);
    this.go.disabled = !ready;
    this.photoParts();
  }

  /** The machine's projects and the folders opened lately, told apart where two share a name; in a
   *  project, the folders inside it once asked for. */
  private folderParts(m: Machine, heading: (text: string) => HTMLElement): Node[] {
    const top = this.trail[0]?.path;
    const label = apart(m.folders, (f) => f.name, (f) => f.path);
    const of = (kind: PlaceFolder["kind"]) => m.folders.filter((f) => f.kind === kind);
    const choose = (f: PlaceFolder) => this.pick(() => {
      this.picked = true;
      this.trail = [{ name: f.name, path: f.path }];
      this.project = f.kind === "project";
      this.inside = null;
    });
    const parts: Node[] = [heading("Folder"), chips(of("project"), label, (f) => f.path === top, choose, { "data-start-folders": "" })];
    if (of("recent").length) parts.push(heading("Opened lately"), chips(of("recent"), label, (f) => f.path === top, choose, { "data-start-recent": "" }));
    if (!this.project) return parts;
    const here = this.trail.at(-1)!;
    const row = h("div", { class: "row" });
    if (this.trail.length > 1) {
      row.append(h("p", { class: "trail mono", "data-start-folder": here.path }, this.trail.map((t) => t.name).join(" / ")),
        pill("Up", () => void this.look(this.trail.slice(0, -1)), "compact", { "data-start-up": "" }));
    }
    if (!this.inside) row.append(pill(`Folders in ${here.name}`, () => void this.look(this.trail), "compact", { "data-start-look": "" }));
    parts.push(row);
    if (this.inside) {
      if (this.inside.folders.length) {
        parts.push(chips(this.inside.folders, (f) => f.name, () => false, (f) => void this.look([...this.trail, f]), { "data-start-inside": "" }));
      } else {
        parts.push(h("p", { class: "quiet" }, `No folders in ${here.name}.`));
      }
      if (this.inside.more) parts.push(h("p", { class: "quiet", "data-start-more": "" }, `The first ${this.inside.folders.length} shown.`));
    }
    return parts;
  }

  /** In the last of `trail`: the folders inside it, asked. */
  private async look(trail: Array<{ name: string; path: string }>): Promise<void> {
    if (!this.workspace) return;
    const n = ++this.looked;
    this.picked = true;
    this.trail = trail;
    this.problem = null;
    try {
      const inside = await this.app.folders(this.workspace, trail.at(-1)!.path);
      if (n !== this.looked) return;
      this.inside = inside;
    } catch (e) {
      if (n === this.looked) this.problem = message(e);
    }
    this.render();
  }

  private photoParts(): void {
    this.photosRow.replaceChildren(...this.photos.map((p, i) => {
      const remove = h("button", { type: "button", class: "remove", "aria-label": "Remove the photo", "data-start-photo-remove": String(i) }, "×");
      remove.addEventListener("click", () => this.pick(() => {
        URL.revokeObjectURL(p.url);
        this.photos.splice(i, 1);
      }));
      return h("span", { class: "photo", "data-start-photo": "" }, h("img", { src: p.url, alt: "" }), remove);
    }));
    this.addPhoto.hidden = this.photos.length >= PHOTOS_MAX;
  }

  private async addPhotos(): Promise<void> {
    const files = [...(this.picker.files ?? [])].slice(0, PHOTOS_MAX - this.photos.length);
    this.picker.value = "";
    try {
      for (const file of files) {
        const photo = await photoOf(file);
        this.photos.push({ ...photo, url: URL.createObjectURL(file) });
      }
    } catch (e) {
      this.problem = `That photo could not be read: ${message(e)}`;
    }
    this.render();
  }

  private dropPhotos(): void {
    for (const p of this.photos) URL.revokeObjectURL(p.url);
    this.photos = [];
  }

  private pick(choose: () => void): void {
    choose();
    this.render();
  }

  private async run(): Promise<void> {
    const folder = this.trail.at(-1)?.path;
    const machine = this.machine;
    if (!this.workspace || !this.program || !folder || !machine) return;
    const last: Last = { workspace: this.workspace, machine: machine.id, folder, program: this.program.id };
    const chosen = (id: string) => this.options.get(id) || undefined;
    this.go.disabled = true;
    const tile = await this.app.start(this.workspace, {
      program: this.program.id,
      folder,
      prompt: this.prompt.value.trim() || undefined,
      model: chosen("model"),
      mode: chosen("mode"),
      ...(this.photos.length ? { images: this.photos.map(({ type, data }) => ({ type, data })) } : {}),
    });
    this.go.disabled = false;
    if (tile) {
      this.last = last;
      void put(LAST, last).catch(() => undefined);
      this.dropPhotos();
      this.app.open(tile, true);
    }
  }
}
