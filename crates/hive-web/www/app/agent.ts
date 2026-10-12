// One agent (the Android app's AgentScreen): its chat; what it waits on as a card above the reply
// box, where the thumb is; Stop while it is in a turn. Its terminal is B4's.

import type { App } from "./app.js";
import { answers } from "./answers.js";
import { Chat } from "./chat.js";
import { Ask, composer, h, icon, pill, say } from "./dom.js";
import type { Agent, Overview } from "./types.js";
import { NOTICES, ago, kindLabel, stateLabel, where } from "./words.js";

export class AgentScreen {
  readonly el = h("section", { class: "screen agent-screen", "data-screen": "agent" });
  private readonly title = h("h1", {});
  private readonly dot = h("span", { class: "dot" });
  private readonly sub = h("span", { class: "status mono" });
  private readonly stop = pill("Stop", () => void this.stopIt(), "danger compact", { "data-stop": "" });
  private readonly closing = new Ask("Close", () => void this.closeIt(), { "data-close-ask": "" });
  private body: HTMLElement = h("div", {});
  private readonly dock = h("div", { class: "dock" });
  private readonly waits = h("div", { "data-waits": "" });
  private readonly gone = h("p", { class: "quiet", hidden: true }, NOTICES.notRunning);
  private readonly message: HTMLTextAreaElement;
  private tile: string | null = null;
  private agent: Agent | null = null;
  private waitSig = "";
  private chat: Chat | null = null;
  private unfollow: (() => void) | null = null;

  constructor(private readonly app: App) {
    const back = h("button", { type: "button", class: "back", "aria-label": "Back", "data-back": "" }, icon("back"));
    back.addEventListener("click", () => app.back());
    this.el.append(
      h("header", { class: "backbar" }, back, h("div", { class: "what" }, this.title, h("p", { class: "sub" }, this.dot, this.sub)), this.stop,
        pill("Close", () => this.agent && this.closing.ask(`Close ${this.agent.agent}? It stops, and its tile closes on ${app.computer()}.`), "compact", { "data-close": "" })),
      this.gone,
      this.body,
      this.dock);
    const message = composer("Message", (text) => (this.agent ? app.send(this.agent, text) : Promise.resolve(false)), { "data-message": "" });
    this.message = message.querySelector("textarea")!;
    this.dock.append(this.closing.el, this.waits, message);
  }

  /** Show the agent of `tile`, as `o` tells of it, its chat afresh. */
  open(tile: string, o: Overview | null): void {
    if (this.tile === tile) return;
    this.close();
    this.tile = tile;
    this.agent = null;
    this.waitSig = "";
    this.waits.replaceChildren();
    this.chat = new Chat((use) => (this.agent ? this.app.tool(this.agent, use) : Promise.reject(new Error("it is no longer there"))));
    this.body.replaceWith(this.chat.el);
    this.body = this.chat.el;
    if (o) this.show(o);
  }

  /** No longer shown: its conversation is followed no more. */
  close(): void {
    this.closing.el.hidden = true;
    this.unfollow?.();
    this.unfollow = null;
    this.tile = null;
  }

  show(o: Overview): void {
    if (!this.tile) return;
    const a = o.agents.find((x) => x.tile === this.tile) ?? null;
    this.gone.hidden = a !== null;
    this.dock.inert = a === null;
    if (!a) return;
    const was = this.agent;
    this.agent = a;
    if (was?.agent !== a.agent) {
      say(this.title, a.agent);
      this.message.placeholder = `Message ${a.agent}`;
    }
    if (was?.state !== a.state || was.name !== a.name || was.machine !== a.machine) {
      this.dot.dataset.state = a.state;
      say(this.sub, [stateLabel(a.state), where(a.name, a.machine)].join(" · "));
      this.sub.classList.toggle("waits", a.state === "waiting");
      this.stop.hidden = !(a.interrupt && (a.state === "working" || a.state === "waiting"));
    }
    this.showWait(a);
    if (!this.unfollow && this.chat) {
      const chat = this.chat;
      if (a.conversation) this.unfollow = this.app.conversation(a, (p) => chat.said(p), (why) => chat.ended(why));
      else {
        chat.ended("It keeps no conversation the phone can read.");
        this.unfollow = () => {};
      }
    }
  }

  /** What it waits on, as a card above the reply box: made again only for another wait. */
  private showWait(a: Agent): void {
    const w = a.waiting;
    const sig = w ? JSON.stringify(w) : "";
    if (sig === this.waitSig) return;
    this.waitSig = sig;
    if (!w) return this.waits.replaceChildren();
    const label = h("p", { class: "kind" }, `${kindLabel(w.kind)} · `, h("span", { "data-since": w.since }, ago(w.since)));
    this.waits.replaceChildren(h("div", { class: "card rail waiting", "data-waiting-card": w.kind }, label, answers(a.tile, w, (reply) => this.app.answer(a, reply))));
  }

  private async stopIt(): Promise<void> {
    if (this.agent) await this.app.stop(this.agent);
  }

  private async closeIt(): Promise<void> {
    if (this.agent && (await this.app.close(this.agent))) this.app.back();
  }
}
