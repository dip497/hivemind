// One agent (the Android app's AgentScreen): its chat, or its terminal a tap away; what it waits on
// as a card above the reply box, where the thumb is, the box its one place to type, its button Stop
// while the agent is in a turn and nothing is typed; Close in the header's ⋯.

import type { App } from "./app.js";
import { type Answers, answers } from "./answers.js";
import { Chat } from "./chat.js";
import { Ask, type Composer, composer, h, icon, iconButton, say } from "./dom.js";
import { TerminalView } from "./terminal.js";
import type { Agent, Overview } from "./types.js";
import { NOTICES, ago, elapsed, kindLabel, stateLabel, where } from "./words.js";

export class AgentScreen {
  readonly el = h("section", { class: "screen agent-screen", "data-screen": "agent" });
  private readonly title = h("h1", {});
  private readonly dot = h("span", { class: "dot" });
  private readonly sub = h("span", { class: "status" });
  private readonly closing = new Ask("Close", () => void this.closeIt(), { "data-close-ask": "" });
  private body: HTMLElement = h("div", {});
  private readonly dock = h("div", { class: "dock" });
  /** Where the chat's button back to its newest sits: over the dock's right. */
  private readonly newestSlot = h("div", { class: "newest-slot" });
  private readonly waits = h("div", { "data-waits": "" });
  private readonly gone = h("p", { class: "quiet", hidden: true }, NOTICES.notRunning);
  /** While it works, above the box: for how long (Happy's AgentInput.tsx:545-580). */
  private readonly workingFor = h("span", {});
  private readonly working = h("p", { class: "working-line", hidden: true, "data-working-line": "" }, h("span", { class: "dot", "data-state": "working" }), this.workingFor);
  private ticking = 0;
  private readonly message: HTMLTextAreaElement;
  private readonly composing: Composer;
  private readonly term = new TerminalView();
  private readonly flip = iconButton("agents", "Terminal", () => this.showTerminal(!this.terminal), { "data-view-toggle": "" });
  /** What the ⋯ holds. */
  private readonly menu = h("div", { class: "card menu", role: "menu", hidden: true });
  /** Whether its terminal shows, rather than its chat. */
  private terminal = false;
  private tile: string | null = null;
  private agent: Agent | null = null;
  private waitSig = "";
  /** A line typed answers what it waits on, when that takes one. */
  private typed: Answers["typed"] = null;
  private chat: Chat | null = null;
  private unfollow: (() => void) | null = null;
  /** Agents started from here that the computer has not listed yet. */
  private readonly fresh = new Set<string>();

  constructor(private readonly app: App) {
    const back = h("button", { type: "button", class: "back", "aria-label": "Back", "data-back": "" }, icon("back"));
    back.addEventListener("click", () => app.back());
    const close = h("button", { type: "button", role: "menuitem", "data-close": "" }, "Close");
    close.addEventListener("click", () => {
      this.menu.hidden = true;
      if (this.agent) this.closing.ask(`Close ${this.agent.agent}? It stops, and its tile closes on ${app.computer()}.`);
    });
    this.menu.append(close);
    const more = iconButton("more", "More", () => (this.menu.hidden = !this.menu.hidden), { "data-more": "" });
    this.el.addEventListener("click", () => (this.menu.hidden = true));
    this.el.append(
      h("header", { class: "backbar" }, back, h("div", { class: "what" }, this.title, h("p", { class: "sub" }, this.dot, this.sub)), this.flip, more, this.menu),
      this.gone,
      this.body,
      this.dock);
    const message = composer("Message", (text) => (this.typed ? this.typed.send(text) : this.sendIt(text)), { "data-message": "" },
      () => void this.stopIt());
    this.message = message.querySelector("textarea")!;
    this.composing = message;
    this.dock.append(this.newestSlot, this.closing.el, this.waits, this.working, message);
  }

  /** `tile` was just started from here: until the computer lists it, it is starting, not gone. */
  starting(tile: string): void {
    this.fresh.add(tile);
  }

  /** Show the agent of `tile`, as `o` tells of it, its chat afresh. */
  open(tile: string, o: Overview | null): void {
    if (this.tile === tile) return;
    this.close();
    this.tile = tile;
    this.agent = null;
    // Nothing of the agent shown before stays while this one is not listed yet.
    say(this.title, "");
    say(this.sub, "");
    delete this.dot.dataset.state;
    this.composing.stoppable(false);
    this.menu.hidden = true;
    this.waitSig = "";
    this.typed = null;
    this.waits.replaceChildren();
    this.chat = new Chat((use) => (this.agent ? this.app.tool(this.agent, use) : Promise.reject(new Error("it is no longer there"))));
    this.terminal = false;
    this.place(this.chat.el);
    this.newestSlot.replaceChildren(this.chat.newest);
    this.newestSlot.hidden = false;
    this.composing.hidden = false;
    this.waits.hidden = false;
    this.flipTo(false);
    if (o) this.show(o);
  }

  /** No longer shown: its conversation is followed no more. */
  close(): void {
    this.closing.el.hidden = true;
    this.unfollow?.();
    this.unfollow = null;
    this.term.unwatch();
    this.tile = null;
    this.showWorking();
  }

  show(o: Overview): void {
    if (!this.tile) return;
    const a = o.agents.find((x) => x.tile === this.tile) ?? null;
    if (a) this.fresh.delete(a.tile);
    say(this.gone, this.fresh.has(this.tile) ? NOTICES.starting : NOTICES.notRunning);
    this.gone.hidden = a !== null;
    this.dock.inert = a === null;
    if (!a) return;
    const was = this.agent;
    this.agent = a;
    if (was?.agent !== a.agent) say(this.title, a.agent);
    if (was?.state !== a.state || was.name !== a.name || was.machine !== a.machine) {
      this.dot.dataset.state = a.state;
      say(this.sub, [stateLabel(a.state), where(a.name, a.machine)].join(" · "));
      this.sub.classList.toggle("waits", a.state === "waiting");
      this.composing.stoppable(!!a.interrupt && (a.state === "working" || a.state === "waiting"));
    }
    this.showWait(a);
    this.showWorking();
    const hint = this.typed?.hint ?? `Message ${a.agent}`;
    if (this.message.placeholder !== hint) {
      this.message.placeholder = hint;
      this.message.setAttribute("aria-label", hint);
    }
    if (!this.unfollow && this.chat) {
      const chat = this.chat;
      if (a.conversation) this.unfollow = this.app.conversation(a, (p) => chat.said(p), (why) => chat.ended(why));
      else {
        chat.ended("It keeps no conversation the phone can read.");
        this.unfollow = () => {};
        // Nothing to read: its terminal is what there is.
        this.showTerminal(true);
      }
    }
    this.term.retry();
  }

  /** Its terminal, or its chat: the terminal is watched only while it shows. */
  private showTerminal(on: boolean): void {
    const a = this.agent;
    if (on === this.terminal || !a || !this.chat) return;
    this.terminal = on;
    this.flipTo(on);
    this.showWorking();
    this.composing.hidden = on;
    this.newestSlot.hidden = on;
    // The terminal shows the chooser itself; the header still says it waits.
    this.waits.hidden = on;
    this.place(on ? this.term.el : this.chat.el);
    if (on) this.term.watch(this.app, a.workspace, a.tile);
    else this.term.unwatch();
  }

  /** The working line, shown and counting while the agent works and its chat shows. */
  private showWorking(): void {
    const a = this.tile ? this.agent : null;
    const on = !!a && a.state === "working" && !this.terminal;
    this.working.hidden = !on;
    if (!on) {
      clearInterval(this.ticking);
      this.ticking = 0;
      return;
    }
    const tick = () => say(this.workingFor, `working · ${elapsed(Date.now() - a.since)}`);
    tick();
    if (!this.ticking) this.ticking = setInterval(tick, 1000);
  }

  /** The header's button: to the chat from the terminal, to the terminal from the chat. */
  private flipTo(terminal: boolean): void {
    const label = terminal ? "Chat" : "Terminal";
    if (this.flip.getAttribute("aria-label") === label) return;
    this.flip.setAttribute("aria-label", label);
    this.flip.replaceChildren(icon(terminal ? "chat" : "agents"));
  }

  private place(el: HTMLElement): void {
    if (this.body === el) return;
    this.body.replaceWith(el);
    this.body = el;
  }

  /** What it waits on, as a card above the reply box: made again only for another wait. */
  private showWait(a: Agent): void {
    const w = a.waiting;
    const sig = w ? JSON.stringify(w) : "";
    if (sig === this.waitSig) return;
    this.waitSig = sig;
    this.typed = null;
    if (!w) return this.waits.replaceChildren();
    const label = h("p", { class: "kind" }, h("span", { class: "what" }, kindLabel(w.kind)), " · ", h("span", { "data-since": w.since }, ago(w.since)));
    const given = answers(a.tile, w, (reply) => this.app.answer(a, reply), true);
    this.typed = given.typed;
    this.waits.replaceChildren(h("div", { class: "card waiting", "data-waiting-card": w.kind }, label, given.el));
  }

  /** A message, shown in the chat at once as it goes: sent, or held until the turn ends with a way
   *  to send it now, which stops the turn; taken away again when it did not go. */
  private async sendIt(text: string): Promise<boolean> {
    const [a, chat] = [this.agent, this.chat];
    if (!a || !chat) return false;
    const shown = chat.sending(text);
    const sent = await this.app.send(a, text);
    if (!sent) shown.failed();
    else if (sent.held) shown.held(() => void this.stopIt());
    else shown.sent();
    return !!sent;
  }

  private async stopIt(): Promise<void> {
    if (this.agent) await this.app.stop(this.agent);
  }

  private async closeIt(): Promise<void> {
    if (this.agent && (await this.app.close(this.agent))) this.app.back();
  }
}
