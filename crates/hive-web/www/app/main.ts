// The phone app in a browser (docs/design/phone-browser-2026-10-03.md, B3): Needs you, Agents, one
// agent, Devices. The last overview kept in IndexedDB is shown before the wasm is even compiled;
// what the computer says replaces it, each list applied to what is on screen by key.

import type { App } from "./app.js";
import { AgentScreen } from "./agent.js";
import { Agents } from "./agents.js";
import { Devices } from "./devices.js";
import { h, icon } from "./dom.js";
import { Needs } from "./needs.js";
import { PairScreen, guessName } from "./pair.js";
import type { Phone } from "./phone.js";
import { get, put } from "./store.js";
import type { Agent, Overview, Paired } from "./types.js";
import { NOTICES, ago, message } from "./words.js";

type Tab = "needs" | "agents" | "devices";

let phone: Phone | null = null;
let overview: Overview | null = null;
let paired: Paired | null = null;
/** An agent opened from a list, so Back goes back to it. */
let opened = false;

const act = async (done: () => Promise<boolean>, notLanded: string): Promise<boolean> => {
  try {
    if (!phone) throw new Error("Still starting");
    const landed = await done();
    if (!landed) notify(notLanded);
    return landed;
  } catch (e) {
    notify(message(e));
    return false;
  }
};

const app: App = {
  open(agent) {
    opened = true;
    location.hash = `agent=${encodeURIComponent(agent.tile)}`;
  },
  back() {
    if (opened) history.back();
    else location.hash = "needs";
  },
  answer: (agent, reply) => act(() => phone!.answer(agent, reply), NOTICES.answered),
  send: (agent, text) => act(() => phone!.send(agent, text), NOTICES.notRunning),
  stop: (agent) => act(() => phone!.stop(agent), NOTICES.notStopped),
  conversation: (agent, said, ended) => phone?.conversation(agent, said, ended) ?? (() => {}),
};

const needs = new Needs(app);
const agents = new Agents(app);
const agent = new AgentScreen(app);
const devices = new Devices(() => void forget());
const pairing = new PairScreen((link, name) => pairWith(link, name));
const screens = { needs, agents, agent, devices, pair: pairing };

const tabs = h("nav", { class: "tabs", "aria-label": "hivemind" });
const tabDot = h("span", { class: "tab-dot", hidden: true, "data-tab-dot": "" });
const TABS: Array<[Tab, string]> = [["needs", "Needs you"], ["agents", "Agents"], ["devices", "Devices"]];
for (const [tab, label] of TABS) {
  const button = h("button", { type: "button", "data-tab": tab }, icon(tab), label, tab === "needs" && tabDot);
  button.addEventListener("click", () => {
    opened = false;
    location.hash = tab;
  });
  tabs.append(button);
}
const trouble = h("p", { class: "notice problem", hidden: true, role: "status", "data-error": "" });
const notice = h("p", { class: "notice", hidden: true, role: "status", "data-notice": "" });
document.getElementById("app")!.append(...Object.values(screens).map((s) => s.el), tabs, trouble, notice);

let noticeTimer = 0;
function notify(text: string): void {
  notice.textContent = text;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.hidden = true), 4000);
}

/** The screen the address names: a tab, or `agent=<tile>`; pairing while paired with nothing. */
function route(): void {
  const asked = new URLSearchParams(location.hash.slice(1));
  const tile = asked.get("agent");
  const tab = (TABS.find(([t]) => asked.has(t))?.[0] ?? "needs") as Tab;
  const shown = !paired ? "pair" : tile ? "agent" : tab;
  for (const [name, screen] of Object.entries(screens)) screen.el.hidden = name !== shown;
  tabs.hidden = shown === "pair" || shown === "agent";
  for (const button of tabs.querySelectorAll<HTMLElement>("[data-tab]")) {
    if (button.dataset.tab === shown) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  if (shown === "agent") agent.open(tile!, overview);
  else agent.close();
}
addEventListener("hashchange", route);

let saving = 0;
function apply(o: Overview): void {
  overview = o;
  needs.show(o);
  agents.show(o);
  agent.show(o);
  tabDot.hidden = o.needs.length === 0;
  clearTimeout(saving);
  saving = setTimeout(() => void put("overview", o), 500);
}

async function pairWith(link: string, name: string): Promise<void> {
  if (!phone) throw new Error("Still starting");
  paired = await phone.pair(link, name);
  devices.show(phone.id, paired);
  location.hash = "needs";
  route();
}

async function forget(): Promise<void> {
  await phone?.forget();
  paired = null;
  overview = null;
  apply({ agents: [], needs: [], working: 0 });
  trouble.hidden = true;
  route();
}

// How long ago, kept true as time passes: only the text that changed is touched.
setInterval(() => {
  for (const el of document.querySelectorAll<HTMLElement>("[data-since]")) {
    const text = ago(Number(el.dataset.since));
    if (el.textContent !== text) el.textContent = text;
  }
}, 15_000);

// The keyboard takes the bottom of the screen on a phone: the agent's reply box stays above it.
visualViewport?.addEventListener("resize", () => document.documentElement.style.setProperty("--vh", `${visualViewport!.height}px`));

async function start(): Promise<void> {
  // The link is a secret: out of the address bar and the history once read.
  const address = location.href;
  const linked = new URLSearchParams(location.hash.slice(1));
  if (linked.has("pair")) history.replaceState(null, "", location.pathname + location.search);
  const [kept, last] = await Promise.all([get<Paired>("paired"), get<Overview>("overview")]);
  paired = kept ?? null;
  if (paired && last) apply(last);
  route();

  navigator.serviceWorker?.register("sw.js").catch(() => {});
  // The wasm and its glue after the first screen, which needs neither.
  const { Phone } = await import("./phone.js");
  phone = await Phone.open(paired, {
    overview: apply,
    status(live, error) {
      devices.status(live, error);
      trouble.hidden = live || error === null;
      trouble.textContent = error ? `${paired?.with.name ?? "Your computer"} is not reached: ${error}` : "";
    },
  });
  devices.show(phone.id, paired);
  addEventListener("online", () => phone!.retry());
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && phone!.retry());
  if (linked.has("pair")) await pairing.run(pairWith, address, linked.get("name") ?? guessName());
  else phone.connect();
}

start().catch((e: unknown) => {
  trouble.hidden = false;
  trouble.textContent = message(e);
});
