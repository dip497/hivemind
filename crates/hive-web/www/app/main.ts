// The phone app in a browser (docs/design/phone-browser-2026-10-03.md, B3 to B5): Home, one agent,
// starting one, Devices. The last Home kept in IndexedDB is shown before the wasm is even compiled;
// what the computer says replaces it, each list applied to what is on screen by key.

import type { App } from "./app.js";
import { AgentScreen } from "./agent.js";
import { Devices } from "./devices.js";
import { h, icon } from "./dom.js";
import { Home } from "./home.js";
import { warm } from "./markdown.js";
import { PairScreen, guessName } from "./pair.js";
import type { Phone } from "./phone.js";
import { StartScreen } from "./start.js";
import { TermScreen } from "./term-screen.js";
import { ViewScreen, Views } from "./views.js";
import { get, put, remove } from "./store.js";
import type { Overview, Paired, Shown } from "./types.js";
import { NOTICES, ago, message } from "./words.js";

type Tab = "home" | "views" | "devices" | "start";
/** What Home showed last, kept to show before the wasm is compiled. */
type First = { shown: Shown; overview: Overview };
const NOTHING: First = { shown: { needs: [], working: [], pinned: [], machines: [], tree: [] }, overview: { agents: [], needs: [], working: 0 } };

let phone: Phone | null = null;
let overview: Overview | null = null;
let paired: Paired | null = null;
/** An agent opened from a list, so Back goes back to it. */
let opened = false;
/** A pairing link the page was opened with, waiting on a tap. */
let offered = false;

const act = async <T extends boolean | null>(done: () => Promise<T>, notLanded: string): Promise<T | false> => {
  try {
    if (!phone) throw new Error("Still starting");
    const landed = await done();
    if (landed === false) notify(notLanded);
    return landed;
  } catch (e) {
    notify(message(e));
    return false;
  }
};

/** Called each time the computer is reached. */
const reaching = new Set<() => void>();

/** The phone, once its wasm is compiled. */
const reached = (): Phone => {
  if (!phone) throw new Error("Still starting");
  return phone;
};

const app: App = {
  open(tile) {
    const at = `#agent=${encodeURIComponent(tile)}`;
    // An agent just started takes the place of the screen that started it.
    if (new URLSearchParams(location.hash.slice(1)).has("start")) location.replace(at);
    else location.hash = at;
    opened = true;
  },
  back() {
    if (opened) history.back();
    else location.hash = "home";
  },
  answer: (agent, reply) => act(() => phone!.answer(agent, reply), NOTICES.answered),
  send: (agent, text) => act(() => phone!.send(agent, text), NOTICES.notRunning),
  stop: (agent) => act(() => phone!.stop(agent), NOTICES.notStopped),
  close: (agent) => act(() => phone!.close(agent), NOTICES.closed),
  conversation: (agent, said, ended) => phone?.conversation(agent, said, ended) ?? (() => {}),
  tool: (agent, use) => reached().tool(agent, use),
  terminal(workspace, tile, changed, ended) {
    if (!phone) return null;
    const { term, stop } = phone.watch(workspace, tile, changed, ended);
    return { source: term, stop };
  },
  openTerminal(workspace, tile, name) {
    location.hash = new URLSearchParams({ terminal: tile, in: workspace, name }).toString();
    opened = true;
  },
  computer: () => paired?.with.name ?? "your computer",
  workspaces: () => reached().workspaces(),
  places: (workspace) => reached().places(workspace),
  folders: (workspace, folder) => reached().folders(workspace, folder),
  async start(workspace, start) {
    try {
      return await reached().start(workspace, start);
    } catch (e) {
      notify(message(e));
      return null;
    }
  },
  views: (workspace) => reached().views(workspace),
  viewFile: (workspace, view, path) => reached().viewFile(workspace, view, path),
  openView: (workspace, view, screen) => reached().openView(workspace, view, screen),
  onReach(cb) {
    reaching.add(cb);
    return () => reaching.delete(cb);
  },
};

const home = new Home(app, () => render());
const agent = new AgentScreen(app);
const terminal = new TermScreen(app);
const starting = new StartScreen(app);
const devices = new Devices(() => void forget());
const views = new Views(app);
const viewing = new ViewScreen(app, views);
const pairing = new PairScreen((link, name) => pairWith(link, name), () => {
  offered = false;
  pairing.clear();
  route();
}, () => phone && ((rgba, width, height) => phone!.readQr(rgba, width, height)), (text, name) => offer(text, name));

/** A link given this page, opened with it or scanned: shown to pair with on a tap. */
function offer(link: string, name: string): void {
  if (!phone) return;
  offered = true;
  pairing.offer(link, name, phone.read(link), paired?.with ?? null);
  route();
}
const screens = { home, agent, terminal, start: starting, views, view: viewing, devices, pair: pairing };

const tabs = h("nav", { class: "tabs", "aria-label": "hivemind" });
const tabDot = h("span", { class: "tab-dot", hidden: true, "data-tab-dot": "" });
const TABS: Array<[Exclude<Tab, "start">, string]> = [["home", "Home"], ["views", "Views"], ["devices", "Devices"]];
for (const [tab, label] of TABS) {
  const button = h("button", { type: "button", "data-tab": tab }, icon(tab === "home" ? "needs" : tab), label, tab === "home" && tabDot);
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

/** The screen the address names: a tab, `start`, `agent=<tile>` or `terminal=<tile>&in=<workspace>`;
 *  pairing while paired with nothing or offered a link. */
let shownBefore = "";
function route(): void {
  const asked = new URLSearchParams(location.hash.slice(1));
  const tile = asked.get("agent");
  const view = asked.get("view");
  const term = asked.get("terminal");
  const tab: Tab = asked.has("start") ? "start" : (TABS.find(([t]) => asked.has(t))?.[0] ?? "home");
  const shown = !paired || offered ? "pair" : tile ? "agent" : term ? "terminal" : view ? "view" : tab;
  for (const [name, screen] of Object.entries(screens)) screen.el.hidden = name !== shown;
  tabs.hidden = shown === "pair" || shown === "agent" || shown === "terminal" || shown === "start" || shown === "view";
  if (shown === "start" && shownBefore !== "start") void starting.open(asked.get("workspace"), asked.get("frame"));
  if (shown === "views" && shownBefore !== "views") void views.open();
  if (shown === "view") void viewing.open(asked.get("in") ?? "", view!);
  else viewing.close();
  if (shown !== "pair") pairing.stopScan();
  shownBefore = shown;
  for (const button of tabs.querySelectorAll<HTMLElement>("[data-tab]")) {
    if (button.dataset.tab === shown) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  if (shown === "agent") agent.open(tile!, overview);
  else agent.close();
  if (shown === "terminal") terminal.open(asked.get("in") ?? "", term!, asked.get("name") ?? "");
  else terminal.close();
}
addEventListener("hashchange", route);

let saving = 0;
let savedAt = 0;
function apply(first: First): void {
  overview = first.overview;
  home.show(first.shown, first.overview);
  agent.show(first.overview);
  tabDot.hidden = first.overview.needs.length === 0;
}

/** Home again, from what this browser holds, by what the person searched for; kept a moment after. */
function render(): void {
  if (!phone || !paired) return;
  const p = phone;
  const first = { shown: p.shown(home.filter), overview: p.overview() };
  apply(first);
  // Kept at once, then at most every 500 ms, what is held then: a busy board changes faster.
  if (saving) return;
  const keep = () => {
    saving = 0;
    if (phone !== p || !paired) return;
    savedAt = Date.now();
    void put("home", p.kept());
    void put("first", { shown: p.shown({ query: "", machine: null }), overview: p.overview() });
  };
  const wait = 500 - (Date.now() - savedAt);
  if (wait <= 0) keep();
  else saving = setTimeout(keep, wait);
}

async function pairWith(link: string, name: string): Promise<void> {
  if (!phone) throw new Error("Still starting");
  const before = paired;
  paired = await phone.pair(link, name);
  offered = false;
  if (before) {
    void remove("first");
    apply(NOTHING);
  }
  devices.show(phone.id, paired);
  location.hash = "home";
  route();
}

async function forget(): Promise<void> {
  const computer = app.computer();
  const told = (await phone?.forget()) ?? false;
  unpaired();
  if (!told) notify(`${computer} was not told: unpair this browser on it too.`);
}

/** Paired with nothing now: the pairing screen. */
function unpaired(): void {
  paired = null;
  overview = null;
  void remove("first");
  apply(NOTHING);
  if (phone) devices.show(phone.id, null);
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
  const [kept, last] = await Promise.all([get<Paired>("paired"), get<First>("first")]);
  paired = kept ?? null;
  if (paired && last) apply(last);
  route();

  navigator.serviceWorker?.register("sw.js").catch(() => {});
  // The wasm after the first screen, which does not need it.
  const { Phone } = await import("./phone.js");
  phone = await Phone.open(paired, {
    home: render,
    status(live, error) {
      devices.status(live, error);
      trouble.hidden = live || error === null;
      trouble.textContent = error ? `${paired?.with.name ?? "Your computer"} is not reached: ${error}` : "";
      if (live) for (const r of reaching) r();
    },
    others: (o) => devices.showOthers(o),
    refused(computer) {
      pairing.refused(computer);
      unpaired();
    },
  });
  devices.show(phone.id, paired);
  render();
  warm();
  route();
  addEventListener("online", () => phone!.retry());
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && phone!.retry());
  phone.connect();
  if (linked.has("pair")) offer(address, linked.get("name") ?? guessName());
}

start().catch((e: unknown) => {
  trouble.hidden = false;
  trouble.textContent = message(e);
});
