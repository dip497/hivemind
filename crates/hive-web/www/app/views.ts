// Views (docs/design/phone-browser-2026-10-03.md §11.6, as the phone apps' Views tab): the community
// views the computer offers a phone, by workspace, and one shown. A view runs in a frame on an
// origin of its own (the server's `--views` port, view/shell.js there), so nothing of this page's
// is reachable from it: not the device key, its storage, its service worker, nor another view.
// Its files and what it says go through this page, which asks only for its own.

import type { ViewSession } from "../pkg/hive_web.js";
import type { App } from "./app.js";
import { Keyed, h, icon } from "./dom.js";
import type { Offered, Screen } from "./types.js";
import { message } from "./words.js";

/** How many of a view's files may be on their way at once: past them it is told there is none. */
const FILES_AT_ONCE = 16;

const EMPTY = "No views yet. A view that works on a phone, installed on your computer, shows here.";

type Row = { workspace: string; place: string; view: Offered };

/** The views' origin: this page's host, on the port its server shows them on; null when none. */
let origin: Promise<string | null> | undefined;
const viewsOrigin = (): Promise<string | null> =>
  (origin ??= fetch("views.json", { cache: "no-store" })
    .then((r) => r.json() as Promise<{ port: number | null }>)
    .then(({ port }) => (port ? `${location.protocol}//${location.hostname}:${port}` : null))
    .catch(() => {
      origin = undefined;
      return null;
    }));

export class Views {
  readonly el = h("section", { class: "screen", "data-screen": "views" });
  private readonly list = h("div", { class: "list", "data-views": "" });
  private readonly empty = h("p", { class: "quiet", hidden: true, "data-views-empty": "" }, EMPTY);
  private readonly rows = new Keyed<Row>(this.list, (r) => `${r.workspace}\n${r.view.id}`, (r) => `${r.view.name}\n${r.place}`, (r) => this.row(r));
  private offered: Row[] = [];

  constructor(private readonly app: App) {
    this.el.append(h("h1", { class: "title" }, "Views"), this.list, this.empty);
    // What the computer offers, asked again once it is reached: shown before, it was not.
    app.onReach(() => !this.el.hidden && void this.open());
  }

  /** Ask the computer what it offers now, for each workspace it holds. */
  async open(): Promise<void> {
    try {
      const held = await this.app.workspaces();
      const said = await Promise.all(held.map(async (w) => (await this.app.views(w.workspace)).map((view) => ({ workspace: w.workspace, place: w.name, view }))));
      this.offered = said.flat();
      this.rows.set(this.offered);
      this.empty.hidden = this.offered.length > 0;
      this.empty.textContent = EMPTY;
    } catch (e) {
      this.empty.hidden = false;
      this.empty.textContent = message(e);
    }
  }

  /** The view `id` in `workspace`, as last offered, else as the computer says now. */
  async find(workspace: string, id: string): Promise<Offered | null> {
    const kept = this.offered.find((r) => r.workspace === workspace && r.view.id === id);
    if (kept) return kept.view;
    return (await this.app.views(workspace)).find((v) => v.id === id) ?? null;
  }

  private row(r: Row): HTMLElement {
    const button = h("button", { type: "button", class: "card view-row", "data-view": r.view.id, "data-workspace": r.workspace },
      h("span", { class: "what" }, h("span", { class: "name" }, r.view.name), h("span", { class: "where" }, r.place)),
      icon("chevron"));
    button.addEventListener("click", () => (location.hash = `view=${encodeURIComponent(r.view.id)}&in=${encodeURIComponent(r.workspace)}`));
    return button;
  }
}

/** The look the view is given: this page's own, by the tokens the computer gives its views. */
function theme(): Screen["theme"] {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(`--${name}`).trim().toLowerCase();
  const hex = (name: string) => (/^#[0-9a-f]{6}$/.test(v(name)) ? v(name) : undefined);
  const colors: Record<string, string | undefined> = {
    bg: hex("canvas"), bg2: hex("panel"), bg3: hex("card"), bg4: hex("raised"),
    fg: hex("text"), fg2: hex("text2"), fg3: hex("text3"), line: hex("line"), line2: hex("line2"),
    brand: hex("accent"), accent: hex("accent"), ok: hex("ok"), warn: hex("warn"), err: hex("err"), info: hex("accent"),
  };
  const status = { working: colors.ok, attention: colors.warn, done: colors.accent, idle: colors.fg3, exited: colors.fg3, failed: colors.err };
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  return {
    colors: Object.fromEntries(Object.entries(colors).filter(([, c]) => c)),
    mode: dark ? "dark" : "light",
    ...(colors.accent ? { accent: colors.accent } : {}),
    radius: 12,
    fonts: { ui: v("sans"), mono: v("mono") },
    ...(colors.bg2 ? { surface: colors.bg2 } : {}),
    ...(colors.bg ? { terminalBackground: colors.bg } : {}),
    glass: false,
    status: Object.fromEntries(Object.entries(status).filter(([, c]) => c)),
  };
}

/** One view, shown. */
export class ViewScreen {
  readonly el = h("section", { class: "screen view-screen", "data-screen": "view" });
  private readonly title = h("h1", {});
  private readonly host = h("div", { class: "view-host" });
  private readonly said = h("p", { class: "quiet", hidden: true, role: "status", "data-view-ended": "" });
  private shown = "";
  /** Each view shown is a round, and each of its sessions: what an older one is told is dropped. */
  private round = 0;
  private sessions = 0;
  private frame: HTMLIFrameElement | null = null;
  private shell: MessagePort | null = null;
  private session: ViewSession | null = null;
  private files = 0;
  private stale = false;
  private readonly resized = new ResizeObserver(() => this.tell());
  private unreach: (() => void) | null = null;

  constructor(private readonly app: App, private readonly views: Views) {
    const back = h("button", { type: "button", class: "back", "aria-label": "Back", "data-back": "" }, icon("back"));
    // Opened from Views, as an agent is from a list.
    back.addEventListener("click", () => (location.hash = "views"));
    this.el.append(h("header", { class: "backbar" }, back, h("div", { class: "what" }, this.title)), this.said, this.host);
    this.resized.observe(this.host);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.tell());
  }

  /** Show the view `id` of `workspace`. */
  async open(workspace: string, id: string): Promise<void> {
    const key = `${workspace}\n${id}`;
    if (this.shown === key) return;
    this.close();
    this.shown = key;
    const round = this.round;
    this.title.textContent = id;
    // Reached again after the connection went: the view starts again on a new session, or at all.
    this.unreach = this.app.onReach(() => {
      if (!this.stale) return;
      this.stale = false;
      this.said.hidden = true;
      if (this.shell) return this.shell.postMessage({ t: "reload" });
      this.shown = "";
      void this.open(workspace, id);
    });
    const [at, found] = await Promise.all([viewsOrigin(), this.views.find(workspace, id).then((view) => ({ view }), (e: unknown) => ({ e }))]);
    if (round !== this.round) return;
    if (!at) return this.end("Views are not shown from this server: it runs without --views.");
    if ("e" in found) return this.unreached(message(found.e));
    const { view } = found;
    if (!view) return this.end(`${this.app.computer()} does not offer this view on a phone.`);
    this.title.textContent = view.name;
    const token = crypto.randomUUID().replaceAll("-", "");
    const frame = h("iframe", { sandbox: "allow-scripts allow-same-origin", referrerpolicy: "no-referrer", title: view.name, "data-view-frame": view.id, src: `${at}/?s=${token}` });
    let loads = 0;
    frame.addEventListener("load", () => {
      // The frame went somewhere else: the view led it away.
      if (loads++ > 0) return this.end("The view left the page it was shown in.");
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = (m) => round === this.round && this.heard(workspace, view, (m.data ?? {}) as Record<string, unknown>);
      this.shell = port1;
      frame.contentWindow!.postMessage({ t: "start", page: view.page }, at, [port2]);
    });
    this.frame = frame;
    this.host.append(frame);
  }

  close(): void {
    this.round++;
    this.shown = "";
    this.session?.close();
    this.session = null;
    this.shell?.close();
    this.shell = null;
    this.frame?.remove();
    this.frame = null;
    this.unreach?.();
    this.unreach = null;
    this.stale = false;
    this.files = 0;
    this.said.hidden = true;
  }

  private heard(workspace: string, view: Offered, m: Record<string, unknown>): void {
    if (m.t === "file" && typeof m.id === "number" && typeof m.path === "string") return this.file(workspace, view, m.id, m.path);
    if (m.t === "page") return void this.begin(workspace, view);
    if (m.t === "left") return this.end("The view left the page it was shown in.");
    if (m.t === "failed") return this.end(`The view could not be shown: ${String(m.why)}`);
  }

  /** One of the view's own files, for the frame; none past those on their way already. */
  private file(workspace: string, view: Offered, id: number, path: string): void {
    const round = this.round;
    const send = (file: unknown, moved: Transferable[] = []) => round === this.round && this.shell?.postMessage({ t: "file", id, file }, moved);
    if (this.files >= FILES_AT_ONCE) return void send(null);
    this.files++;
    this.app.viewFile(workspace, view.id, path).then(
      (file) => send(file, [file.data.buffer]),
      () => send(null),
    ).finally(() => round === this.round && this.files--);
  }

  /** A session for the page the view just loaded, in place of the one before. */
  private async begin(workspace: string, view: Offered): Promise<void> {
    this.session?.close();
    this.session = null;
    const [round, mine] = [this.round, ++this.sessions];
    const current = () => round === this.round && mine === this.sessions;
    let session: ViewSession;
    try {
      session = await this.app.openView(workspace, view.id, this.screen());
    } catch (e) {
      if (current()) this.unreached(message(e));
      return;
    }
    if (!current() || !this.shell) return session.close();
    this.session = session;
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = (m) => {
      let text: string | undefined;
      try {
        text = JSON.stringify(m.data);
      } catch {}
      if (typeof text === "string") session.post(text);
    };
    this.shell.postMessage({ t: "port" }, [port2]);
    session.relay((said: unknown) => port1.postMessage(said)).then(
      (why) => current() && why && this.end(`${this.app.computer()} stopped the view: ${why}`),
      (e: unknown) => current() && this.unreached(message(e)),
    ).finally(() => port1.close());
  }

  private unreached(why: string): void {
    this.stale = true;
    this.say(`Not connected to ${this.app.computer()}: ${why}. The view starts again once it is.`);
  }

  /** Shown no more, and why. */
  private end(why: string): void {
    const shown = this.shown;
    this.close();
    this.shown = shown;
    this.say(why);
  }

  private say(text: string): void {
    this.said.textContent = text;
    this.said.hidden = false;
  }

  private screen(): Screen {
    return { w: Math.round(this.host.clientWidth), h: Math.round(this.host.clientHeight), theme: theme() };
  }

  private tell(): void {
    try {
      this.session?.screen(this.screen());
    } catch {}
  }
}
