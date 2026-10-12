// Starting an agent: workspace, then machine, then folder (a project, one opened lately, or a
// folder inside a project), then an agent found there with its model and mode when it has them,
// then a prompt and photos; Start opens the new agent.

import type { App } from "./app.js";
import { chips, h, icon, pill } from "./dom.js";
import { PHOTOS_MAX, photoOf } from "./photos.js";
import type { Folders, Held, Photo, PlaceFolder, Places, Program } from "./types.js";
import { message } from "./words.js";

type Machine = Places["machines"][number];

export class StartScreen {
  readonly el = h("section", { class: "screen", "data-screen": "start" });
  private readonly body = h("div", { class: "start" });
  private readonly prompt = h("textarea", { class: "field", rows: 3, placeholder: "Prompt (optional)", "aria-label": "Prompt", "data-start-prompt": "" });
  private readonly picker = h("input", { type: "file", accept: "image/*", multiple: true, hidden: true, "data-start-photo-input": "" });
  private readonly go: HTMLButtonElement;
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
  /** Each question asked, so an answer to one superseded is dropped. */
  private asked = 0;
  /** Where it was last opened for. */
  private at: { workspace?: string | null; frame?: string | null } = {};

  constructor(private readonly app: App) {
    const back = h("button", { type: "button", class: "back", "aria-label": "Back", "data-back": "" }, icon("back"));
    back.addEventListener("click", () => app.back());
    this.go = pill("Start", () => void this.run(), "primary", { "data-start-go": "" });
    this.picker.addEventListener("change", () => void this.addPhotos());
    this.el.append(h("header", { class: "backbar" }, back, h("div", { class: "what" }, h("h1", {}, "Start an agent"))), this.body, this.picker);
    // Opened before the computer was reached (the page reloaded on it): asked again once it is.
    // Once it answered, what the person chose stays.
    app.onReach(() => !this.el.hidden && this.held === null && void this.open(this.at.workspace, this.at.frame));
  }

  /** Shown afresh: what the computer holds, asked again; in `workspace`'s frame `frame` when given. */
  async open(workspace?: string | null, frame?: string | null): Promise<void> {
    const n = ++this.asked;
    this.at = { workspace, frame };
    this.held = null;
    this.prompt.value = "";
    this.dropPhotos();
    this.unchoose(null);
    try {
      const held = await this.app.workspaces();
      if (n !== this.asked) return;
      this.held = held;
      const at = held.find((w) => w.workspace === workspace) ?? (held.length === 1 ? held[0] : undefined);
      if (at) return void this.choose(at.workspace, frame);
    } catch (e) {
      if (n === this.asked) this.problem = message(e);
    }
    this.render();
  }

  private async choose(workspace: string, frame?: string | null): Promise<void> {
    const n = ++this.asked;
    this.unchoose(workspace);
    try {
      const places = await this.app.places(workspace);
      if (n !== this.asked) return;
      this.places = places;
      const there = frame ? places.machines.find((m) => m.folders.some((f) => f.frame === frame)) : undefined;
      this.onMachine(there ?? places.machines[0] ?? null, there?.folders.find((f) => f.frame === frame));
    } catch (e) {
      if (n === this.asked) this.problem = message(e);
    }
    this.render();
  }

  /** In `workspace`, nothing else chosen yet. */
  private unchoose(workspace: string | null): void {
    this.workspace = workspace;
    this.places = null;
    this.problem = null;
    this.onMachine(null);
    this.render();
  }

  private onMachine(machine: Machine | null, folder?: PlaceFolder): void {
    this.machine = machine;
    this.program = machine?.programs.length === 1 ? machine.programs[0]! : null;
    this.options.clear();
    const first = folder ?? machine?.folders[0];
    this.trail = first ? [{ name: first.name, path: first.path }] : [];
    this.project = first?.kind === "project";
    this.inside = null;
  }

  private render(): void {
    const heading = (text: string, props = {}) => h("h2", { class: "label-small", ...props }, text);
    const parts: Array<Node | null> = [];
    if (this.held === null && !this.problem) parts.push(h("p", { class: "quiet" }, "Asking…"));
    else if (this.held?.length === 0) parts.push(h("p", { class: "quiet" }, `No workspace is open on ${this.app.computer()}: open one in hivemind there.`));
    if (this.held && this.held.length > 1) {
      parts.push(heading("Workspace"), chips(this.held, (w) => w.name, (w) => w.workspace === this.workspace, (w) => void this.choose(w.workspace), { "data-start-workspaces": "" }));
    }
    const p = this.places;
    const m = this.machine;
    if (p && p.machines.length > 1) {
      parts.push(heading("Machine"), chips(p.machines, (x) => x.name, (x) => x.id === m?.id, (x) => this.pick(() => this.onMachine(x)), { "data-start-machines": "" }));
    }
    if (m) parts.push(...this.folderParts(m, heading));
    if (m?.unreached) parts.push(h("p", { class: "problem", "data-start-unreached": "" }, `${m.name} could not be asked which agents it has: ${m.unreached}`));
    else if (m && !m.programs.length) parts.push(h("p", { class: "quiet" }, `No agent is installed on ${m.name}.`));
    if (m?.programs.length) {
      parts.push(heading("Agent"), chips(m.programs, (x) => x.label, (x) => x.id === this.program?.id, (x) => this.pick(() => {
        this.program = x;
        this.options.clear();
      }), { "data-start-programs": "" }));
      for (const option of this.program?.options ?? []) {
        parts.push(heading(option.label));
        if (option.values.length) {
          parts.push(chips(option.values, (v) => v, (v) => this.options.get(option.id) === v, (v) => this.pick(() => this.options.set(option.id, v)), { "data-start-option": option.id }));
        } else {
          const field = h("input", { class: "field", value: this.options.get(option.id) ?? "", "aria-label": option.label, "data-start-option": option.id });
          field.addEventListener("input", () => this.options.set(option.id, field.value.trim()));
          parts.push(field);
        }
      }
      this.go.disabled = !this.program || !this.trail.length;
      parts.push(this.prompt, this.photoParts(), this.go);
    }
    if (this.problem) parts.push(h("p", { class: "problem", "data-start-error": "" }, this.problem));
    this.body.replaceChildren(...parts.filter((x): x is Node => x !== null));
  }

  /** The machine's projects and the folders opened lately, then where in a project the chosen one is,
   *  and the folders inside it once asked. */
  private folderParts(m: Machine, heading: (text: string, props?: object) => HTMLElement): Node[] {
    const top = this.trail[0]?.path;
    const of = (kind: PlaceFolder["kind"]) => m.folders.filter((f) => f.kind === kind);
    const choose = (f: PlaceFolder) => this.pick(() => {
      this.trail = [{ name: f.name, path: f.path }];
      this.project = f.kind === "project";
      this.inside = null;
    });
    const parts: Node[] = [heading("Folder"), chips(of("project"), (f) => f.name, (f) => f.path === top, choose, { "data-start-folders": "" })];
    if (of("recent").length) parts.push(heading("Opened lately"), chips(of("recent"), (f) => f.name, (f) => f.path === top, choose, { "data-start-recent": "" }));
    if (!this.project) return parts;
    const trail = h("p", { class: "trail mono", "data-start-folder": this.trail.at(-1)!.path }, this.trail.map((t) => t.name).join(" / "));
    const row = h("div", { class: "row" }, trail);
    if (this.trail.length > 1) row.append(pill("Up", () => void this.look(this.trail.slice(0, -1)), "compact", { "data-start-up": "" }));
    if (!this.inside) row.append(pill("Folders inside", () => void this.look(this.trail), "compact", { "data-start-look": "" }));
    parts.push(row);
    if (this.inside) {
      if (this.inside.folders.length) {
        parts.push(chips(this.inside.folders, (f) => f.name, () => false, (f) => void this.look([...this.trail, f]), { "data-start-inside": "" }));
      } else {
        parts.push(h("p", { class: "quiet" }, "No folders in it."));
      }
      if (this.inside.more) parts.push(h("p", { class: "quiet", "data-start-more": "" }, `The first ${this.inside.folders.length} shown.`));
    }
    return parts;
  }

  /** In the last of `trail`: the folders inside it, asked. */
  private async look(trail: Array<{ name: string; path: string }>): Promise<void> {
    if (!this.workspace) return;
    const n = ++this.asked;
    this.trail = trail;
    this.problem = null;
    try {
      const inside = await this.app.folders(this.workspace, trail.at(-1)!.path);
      if (n !== this.asked) return;
      this.inside = inside;
    } catch (e) {
      if (n === this.asked) this.problem = message(e);
    }
    this.render();
  }

  private photoParts(): HTMLElement {
    const shown = h("div", { class: "photos", "data-start-photos": "" }, ...this.photos.map((p, i) => {
      const remove = h("button", { type: "button", class: "remove", "aria-label": "Remove the photo", "data-start-photo-remove": String(i) }, "×");
      remove.addEventListener("click", () => this.pick(() => {
        URL.revokeObjectURL(p.url);
        this.photos.splice(i, 1);
      }));
      return h("span", { class: "photo", "data-start-photo": "" }, h("img", { src: p.url, alt: "" }), remove);
    }));
    if (this.photos.length < PHOTOS_MAX) shown.append(pill("Add photos", () => this.picker.click(), "compact", { "data-start-add-photo": "" }));
    return shown;
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
    if (!this.workspace || !this.program || !folder) return;
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
      this.dropPhotos();
      this.app.open(tile, true);
    }
  }
}
