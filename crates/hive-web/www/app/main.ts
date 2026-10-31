// The phone app in a browser (docs/design/phone-browser-2026-10-03.md, B3 to B5): Home, one agent,
// starting one, Devices; one account shown at a time, each a person whose computers this browser
// paired with. The last Home kept in IndexedDB is shown before the wasm is even compiled;
// what the computer says replaces it, each list applied to what is on screen by key.

import { type Account, type Computer, type Kept, accountName, forgetAccount, keep, load, pairedWith, save } from "./accounts.js";
import type { App } from "./app.js";
import { AgentScreen } from "./agent.js";
import { Devices } from "./devices.js";
import { h, icon } from "./dom.js";
import { Home } from "./home.js";
import { warm } from "./markdown.js";
import { PairScreen, guessName } from "./pair.js";
import type { Connect, Phone } from "./phone.js";
import { KEPT as START_KEPT, StartScreen } from "./start.js";
import { TermScreen } from "./term-screen.js";
import { followViewport } from "./viewport.js";
import { ViewScreen, Views } from "./views.js";
import { get, put, remove } from "./store.js";
import type { Overview, Shown } from "./types.js";
import { NOTICES, ago, message } from "./words.js";

type Tab = "home" | "views" | "devices" | "start";
/** What Home showed last, kept to show before the wasm is compiled. */
type First = { shown: Shown; overview: Overview };
const NOTHING: First = { shown: { needs: [], working: [], pinned: [], machines: [], tree: [], marks: {} }, overview: { agents: [], needs: [], working: 0 } };

let phone: Phone | null = null;
let overview: Overview | null = null;
/** The wasm's side, once compiled. */
let wasm: typeof import("./phone.js") | null = null;
let kept: Kept = { accounts: [], active: null };
/** The account shown. */
let account: Account | null = null;
/** An agent opened from a list, so Back goes back to it. */
let opened = false;
/** A pairing link the page was opened with, waiting on a tap. */
let offered = false;

const act = async <T extends boolean | null | object>(done: () => Promise<T>, notLanded: string): Promise<T | false> => {
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
let live = false;

/** The phone, once its wasm is compiled. */
const reached = (): Phone => {
  if (!phone) throw new Error("Still starting");
  return phone;
};

/** The phone once the computer is reached, waited for. */
const reachedNow = (): Promise<Phone> => phone && live ? Promise.resolve(phone) : new Promise((resolve) => {
  const off = app.onReach(() => {
    off();
    resolve(phone!);
  });
});

const app: App = {
  open(tile, started) {
    if (started) agent.starting(tile);
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
  send: async (agent, text, photos, going) => reached().send(agent, text, photos, going),
  stop: (agent) => act(() => phone!.stop(agent), NOTICES.notStopped),
  close: (agent) => act(() => phone!.close(agent), NOTICES.closed),
  browserAsks: (agent) => phone ? phone.browserAsks(agent).catch(() => []) : Promise.resolve([]),
  answerBrowserAsk: (agent, ask, answer) => phone ? phone.answerBrowserAsk(agent, ask, answer).catch(() => false) : Promise.resolve(false),
  notes: (agent) => phone ? phone.notes(agent).catch(() => []) : Promise.resolve([]),
  changeNote: (agent, id, to, reason) => phone ? phone.changeNote(agent, id, to, reason) : Promise.resolve(false),
  sendNotes: (agent, ids) => phone ? phone.sendNotes(agent, ids) : Promise.resolve(false),
  conversation: (agent, said, ended) => phone?.conversation(agent, said, ended) ?? (() => {}),
  tool: (agent, use) => reached().tool(agent, use),
  commands: (agent) => reached().commands(agent),
  terminal(workspace, tile, changed, ended) {
    const watched = phone?.watch(workspace, tile, changed, ended);
    return watched ? { source: watched.term, stop: watched.stop } : null;
  },
  openTerminal(workspace, tile, name) {
    location.hash = new URLSearchParams({ terminal: tile, in: workspace, name }).toString();
    opened = true;
  },
  computer: () => account ? accountName(account) : "your computer",
  workspaces: async () => (await reachedNow()).workspaces(),
  places: async (workspace) => (await reachedNow()).places(workspace),
  folders: async (workspace, folder) => (await reachedNow()).folders(workspace, folder),
  async start(workspace, start) {
    try {
      return await (await reachedNow()).start(workspace, start);
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
const devices = new Devices({
  forget: () => void forget(),
  add: () => (location.hash = "add"),
  switchTo: (person) => void switchTo(person),
});
const views = new Views(app);
const viewing = new ViewScreen(app, views);
const pairing = new PairScreen((link, name, shown) => pairWith(link, name, shown), () => {
  offered = false;
  pairing.clear();
  if (new URLSearchParams(location.hash.slice(1)).has("add")) history.back();
  else route();
}, () => wasm && wasm.scan, (text, name) => offer(text, name));

/** A link given this page, opened with it or scanned: shown to pair with on a tap. */
function offer(link: string, name: string): void {
  if (!wasm) return;
  offered = true;
  pairing.offer(link, name, wasm.read(link), account && { name: accountName(account) });
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
// Shown by the router alone: none is drawn before it has run.
for (const screen of Object.values(screens)) screen.el.hidden = true;
tabs.hidden = true;
document.getElementById("app")!.append(...Object.values(screens).map((s) => s.el), tabs, trouble, notice);

let noticeTimer = 0;
function notify(text: string): void {
  notice.textContent = text;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.hidden = true), 4000);
}

/** The tile the agent or terminal shown is, by key. */
let lookedAt: string | null = null;
const tileKey = (tile: string) => {
  const a = overview?.agents.find((x) => x.tile === tile);
  return a ? `t:${a.workspace}/${tile}` : null;
};

/** The screen the address names: a tab, `start`, `agent=<tile>` or `terminal=<tile>&in=<workspace>`;
 *  pairing while paired with nothing or offered a link. */
let shownBefore = "";
function route(): void {
  const asked = new URLSearchParams(location.hash.slice(1));
  const tile = asked.get("agent");
  const view = asked.get("view");
  const term = asked.get("terminal");
  const tab: Tab = asked.has("start") ? "start" : (TABS.find(([t]) => asked.has(t))?.[0] ?? "home");
  const adding = asked.has("add");
  const shown = !account || offered || adding ? "pair" : tile ? "agent" : term ? "terminal" : view ? "view" : tab;
  if (adding && account && !offered) pairing.adding(accountName(account));
  for (const [name, screen] of Object.entries(screens)) screen.el.hidden = name !== shown;
  tabs.hidden = shown === "pair" || shown === "agent" || shown === "terminal" || shown === "start" || shown === "view";
  if (shown === "start" && shownBefore !== "start") void starting.open(asked.get("workspace"), asked.get("frame"));
  if (shown === "views" && shownBefore !== "views") void views.open();
  if (shown === "view") void viewing.open(asked.get("in") ?? "", view!);
  else viewing.close();
  if (shown !== "pair") pairing.stopScan();
  // What an agent or terminal said is read on opening it, and on leaving it.
  const looking = tile ? tileKey(tile) : term ? `t:${asked.get("in") ?? ""}/${term}` : null;
  if (looking) home.choices.saw(looking);
  if (lookedAt && lookedAt !== looking) {
    home.choices.saw(lookedAt);
    render();
  }
  lookedAt = looking;
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
  terminal.retry();
  tabDot.hidden = first.overview.needs.length === 0;
}

/** Home again, from what this browser holds, by what the person searched for; kept a moment after. */
function render(): void {
  if (!phone || !account) return;
  const p = phone;
  const first = { shown: p.shown(home.filter, home.choices.view()), overview: p.overview() };
  apply(first);
  // Kept at once, then at most every 500 ms, what is held then: a busy board changes faster.
  if (saving) return;
  const keep = () => {
    saving = 0;
    if (phone !== p) return;
    savedAt = Date.now();
    const person = p.account.person;
    void put(`home:${person}`, p.kept());
    void put(`first:${person}`, { shown: p.shown({ query: "", machine: null }, home.choices.view()), overview: p.overview() });
  };
  const wait = 500 - (Date.now() - savedAt);
  if (wait <= 0) keep();
  else saving = setTimeout(keep, wait);
}

/** Pair with the computer `link` names: under the key it knows this browser by, when it was paired
 *  with before, else a new one. It joins its person's account, made when there is none, which is
 *  shown; the other accounts stay paired. */
async function pairWith(link: string, name: string, shown: Connect): Promise<void> {
  if (!wasm) throw new Error("Still starting");
  const before = pairedWith(kept, wasm.read(link)?.device ?? "");
  const key = before?.computer.key ?? unusedKey();
  // Pairing again under a key the account shown dials with: one endpoint of it at a time.
  const shared = phone && account?.computers.some((c) => c.key === key);
  if (shared) {
    phone!.disconnect();
    phone = null;
  }
  let paired;
  try {
    paired = await wasm.pairUnder(key, link, name, shown);
  } catch (e) {
    if (!before) void remove(key);
    if (shared && account) await show(account);
    throw e;
  }
  const joined = keep(kept, paired, key);
  await save(kept);
  offered = false;
  await show(joined);
  location.hash = "home";
  route();
}

/** The key a computer not paired with before is paired under: "device", the key a browser pairs
 *  with first, while no account uses it, so that the id shown before pairing is the one paired. */
function unusedKey(): string {
  return kept.accounts.some((a) => a.computers.some((c) => c.key === "device")) ? `key:${crypto.randomUUID()}` : "device";
}

/** Nothing paired: the id this browser pairs with next. */
function showUnpaired(): void {
  devices.show(null, [], []);
  if (wasm && !account) void wasm.idOf(unusedKey()).then((id) => !account && devices.show(id, [], []));
}

/** Show `person`'s account in place of the one shown. */
async function switchTo(person: string): Promise<void> {
  const to = kept.accounts.find((a) => a.person === person);
  if (!to || to === account) return;
  kept.active = person;
  await save(kept);
  await show(to);
  location.hash = "home";
}

/** Forget the account shown: each of its computers is told, and another account is shown. */
async function forget(): Promise<void> {
  if (!phone || !account) return;
  const gone = account;
  const notTold = await phone.forget();
  await drop(gone);
  if (notTold.length) notify(`${notTold.join(", ")} ${notTold.length === 1 ? "was" : "were"} not told: unpair this browser there too.`);
}

/** Forget `gone` here, with what was kept for it, and show another account or pairing. */
async function drop(gone: Account): Promise<void> {
  const keys = forgetAccount(kept, gone.person);
  await save(kept);
  await Promise.all([...keys, `home:${gone.person}`, `first:${gone.person}`].map(remove));
  const next = kept.accounts.find((a) => a.person === kept.active);
  if (next) await show(next);
  else unpaired();
}

/** Paired with nothing now: the pairing screen. */
function unpaired(): void {
  phone?.disconnect();
  phone = null;
  account = null;
  overview = null;
  void remove(START_KEPT);
  apply(NOTHING);
  showUnpaired();
  home.accounts([], null, () => {});
  trouble.hidden = true;
  route();
}

/** `to`'s account on screen, its computers dialled; the one shown before let go of. */
async function show(to: Account): Promise<void> {
  phone?.disconnect();
  phone = null;
  account = to;
  const last = await get<First>(`first:${to.person}`);
  apply(last ?? NOTHING);
  if (!wasm) return;
  const p = await wasm.Phone.open(to, told);
  if (account !== to) return p.disconnect();
  phone = p;
  showAccounts();
  void wasm.idOf(to.computers[0]!.key).then((id) => account === to && devices.show(id, kept.accounts, p.computers(), to));
  render();
  p.connect();
}

function showAccounts(): void {
  home.accounts(kept.accounts.map((a) => ({ person: a.person, name: accountName(a) })), account?.person ?? null, (person) => void switchTo(person));
}

const told = {
  home: render,
  status() {
    if (!phone) return;
    const computers = phone.computers();
    devices.status(computers);
    live = computers.some((c) => c.live);
    const away = computers.filter((c) => c.paired && !c.live && c.error);
    trouble.hidden = live || away.length === 0;
    trouble.textContent = away.length ? `${away.map((c) => c.name).join(", ")} ${away.length === 1 ? "is" : "are"} not reached: ${away[0]!.error}` : "";
    if (live) for (const r of [...reaching]) r();
  },
  named(name: string) {
    if (!account || account.name === name) return;
    account.name = name;
    void save(kept);
    showAccounts();
    devices.named(name);
  },
  refused(computer: Computer) {
    const of = account;
    if (!of) return;
    of.computers = of.computers.filter((c) => c.with.device !== computer.with.device);
    if (of.computers.length) {
      void save(kept);
      notify(`${computer.with.name} no longer lets this browser in: it was unpaired there.`);
      return;
    }
    pairing.refused(computer.with.name);
    void drop(of);
  },
};

// How long ago, kept true as time passes: only the text that changed is touched.
setInterval(() => {
  for (const el of document.querySelectorAll<HTMLElement>("[data-since]")) {
    const text = ago(Number(el.dataset.since));
    if (el.textContent !== text) el.textContent = text;
  }
}, 15_000);

followViewport();

async function start(): Promise<void> {
  // The link is a secret: out of the address bar and the history once read.
  const linked = new URLSearchParams(location.hash.slice(1));
  const link = linked.get("connect") ?? linked.get("pair");
  const name = linked.get("name") ?? guessName();
  if (link !== null) {
    history.replaceState(null, "", location.pathname + location.search);
    offered = true;
    pairing.starting(link, name);
  }
  kept = await load();
  const active = kept.accounts.find((a) => a.person === kept.active) ?? null;
  if (active) {
    account = active;
    apply((await get<First>(`first:${active.person}`)) ?? NOTHING);
  }
  route();

  navigator.serviceWorker?.register("sw.js").catch(() => {});
  followBuilds();
  // Paired computers are kept only while the browser keeps this page's storage.
  void navigator.storage?.persist?.().catch(() => {});
  // The wasm after the first screen, which does not need it.
  const loaded = await import("./phone.js");
  await loaded.ready();
  wasm = loaded;
  if (active) await show(active);
  else showUnpaired();
  warm();
  route();
  addEventListener("online", () => phone?.retry(true));
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return void (hiddenAt = Date.now());
    phone?.retry(Date.now() - hiddenAt >= AWAY);
  });
  if (link !== null) offer(link, name);
}

/** Hidden this long, the page takes it that the phone may have slept or moved: a quick look away
 *  costs no new connection. */
const AWAY = 15_000;

/** A newer build of this page, once the server has one: opened again at once when nothing typed
 *  would be lost, else offered. Asked as the page comes back into view, as a phone keeps it open. */
function followBuilds(): void {
  const sw = navigator.serviceWorker;
  if (!sw) return;
  // The fields the person typed into: one the page filled in itself (a device's name) is no loss.
  const touched = new Set<HTMLInputElement | HTMLTextAreaElement>();
  document.addEventListener("input", (e) => {
    const f = e.target;
    if (f instanceof HTMLTextAreaElement || (f instanceof HTMLInputElement && f.type !== "file")) touched.add(f);
  }, true);
  const typed = () => [...touched].some((f) => f.isConnected && f.value.trim() !== "");
  sw.addEventListener("message", (e: MessageEvent) => {
    if ((e.data as { t?: unknown } | null)?.t !== "newer") return;
    if (!typed()) return location.reload();
    if (document.querySelector("[data-page-newer]")) return;
    const bar = h("div", { class: "page-newer", role: "status", "data-page-newer": "" }, "Hivemind was updated.");
    const reload = h("button", { class: "page-newer-reload" }, "Reload");
    reload.addEventListener("click", () => location.reload());
    bar.append(reload);
    document.body.append(bar);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") sw.controller?.postMessage({ t: "check" });
  });
}

start().catch((e: unknown) => {
  trouble.hidden = false;
  trouble.textContent = message(e);
});
