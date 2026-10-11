// Starting an agent (the Android app's StartScreen): workspace, then folder, then agent with its
// model and mode when it has them, then a prompt; Start opens the new agent.

import type { App } from "./app.js";
import { chips, h, icon, pill } from "./dom.js";
import type { Held, Startable } from "./types.js";
import { message, where } from "./words.js";

type Program = Startable["programs"][number];

export class StartScreen {
  readonly el = h("section", { class: "screen", "data-screen": "start" });
  private readonly body = h("div", { class: "start" });
  private readonly prompt = h("textarea", { class: "field", rows: 3, placeholder: "Prompt (optional)", "aria-label": "Prompt", "data-start-prompt": "" });
  private readonly go: HTMLButtonElement;
  private held: Held[] | null = null;
  private workspace: string | null = null;
  private startable: Startable | null = null;
  private frame: string | null = null;
  private program: Program | null = null;
  private readonly options = new Map<string, string>();
  private problem: string | null = null;
  /** Each question asked, so an answer to one superseded is dropped. */
  private asked = 0;

  constructor(private readonly app: App) {
    const back = h("button", { type: "button", class: "back", "aria-label": "Back", "data-back": "" }, icon("back"));
    back.addEventListener("click", () => app.back());
    this.go = pill("Start", () => void this.run(), "primary", { "data-start-go": "" });
    this.el.append(h("header", { class: "backbar" }, back, h("div", { class: "what" }, h("h1", {}, "Start an agent"))), this.body);
  }

  /** Shown afresh: what the computer holds, asked again. */
  async open(): Promise<void> {
    const n = ++this.asked;
    this.held = null;
    this.prompt.value = "";
    this.unchoose(null);
    try {
      const held = await this.app.workspaces();
      if (n !== this.asked) return;
      this.held = held;
      if (held.length === 1) return void this.choose(held[0]!.workspace);
    } catch (e) {
      if (n === this.asked) this.problem = message(e);
    }
    this.render();
  }

  private async choose(workspace: string): Promise<void> {
    const n = ++this.asked;
    this.unchoose(workspace);
    try {
      const startable = await this.app.startable(workspace);
      if (n !== this.asked) return;
      this.startable = startable;
      this.frame = startable.frames[0]?.id ?? null;
      if (startable.programs.length === 1) this.program = startable.programs[0]!;
    } catch (e) {
      if (n === this.asked) this.problem = message(e);
    }
    this.render();
  }

  /** In `workspace`, nothing else chosen yet. */
  private unchoose(workspace: string | null): void {
    this.workspace = workspace;
    this.startable = null;
    this.frame = null;
    this.program = null;
    this.problem = null;
    this.options.clear();
    this.render();
  }

  private render(): void {
    const heading = (text: string) => h("h2", { class: "label-small" }, text);
    const parts: Array<Node | null> = [];
    if (this.held === null && !this.problem) parts.push(h("p", { class: "quiet" }, "Asking…"));
    else if (this.held?.length === 0) parts.push(h("p", { class: "quiet" }, `No workspace is open on ${this.app.computer()}: open one in hivemind there.`));
    if (this.held?.length) {
      parts.push(heading("Workspace"), chips(this.held, (w) => w.name, (w) => w.workspace === this.workspace, (w) => void this.choose(w.workspace), { "data-start-workspaces": "" }));
    }
    const s = this.startable;
    if (s && s.frames.length > 1) {
      parts.push(heading("Folder"), chips(s.frames, (f) => where(f.name, f.machine), (f) => f.id === this.frame, (f) => this.pick(() => (this.frame = f.id)), { "data-start-frames": "" }));
    }
    if (s) {
      parts.push(heading("Agent"), chips(s.programs, (p) => p.label, (p) => p.id === this.program?.id, (p) => this.pick(() => {
        this.program = p;
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
      this.go.disabled = !this.program;
      parts.push(this.prompt, this.go);
    }
    if (this.problem) parts.push(h("p", { class: "problem", "data-start-error": "" }, this.problem));
    this.body.replaceChildren(...parts.filter((p): p is Node => p !== null));
  }

  private pick(choose: () => void): void {
    choose();
    this.render();
  }

  private async run(): Promise<void> {
    if (!this.workspace || !this.program) return;
    const chosen = (id: string) => this.options.get(id) || undefined;
    this.go.disabled = true;
    const tile = await this.app.start(this.workspace, {
      program: this.program.id,
      frame: this.frame ?? undefined,
      prompt: this.prompt.value.trim() || undefined,
      model: chosen("model"),
      mode: chosen("mode"),
    });
    this.go.disabled = false;
    if (tile) this.app.open(tile);
  }
}
