/**
 * Widgets in this window. Every window draws what a workspace's widgets drew, as its host tells it
 * (`widget.drawn`). One window per workspace also runs their code, the one the host chose
 * (`widget.run`): a worker per widget, which reaches no network (the page's CSP) and nothing of
 * the app but what `hive` gives it: draw, move its card, keep state, read its options, notify,
 * hear its buttons and clicks on it, and read and act on the workspace through `hive.hm`: the
 * client a view has, held here for it (WidgetLinks.tsx) and held to its manifest's permissions.
 * A joined workspace's widgets run on its host.
 *
 * What a widget shows travels as one drawing: what it draws, how its card looks, and the last move
 * it asked for. A move is said once ("go there over 3 s") and every window animates it itself, so
 * motion is smooth everywhere without a stream of drawings.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { isPluginEnabled, resolveSettings } from "@hivemind/core/plugin-settings";
import type { BoardObject, WidgetObject } from "@hivemind/workspace-doc/shapes";
import type { WidgetPackage } from "../../../shared/ipc";
import { BUILTIN_WIDGETS, viewWidget } from "@hivemind/core/widget-format";
import type { ViewWidget } from "@hivemind/view-sdk/protocol";
import { onStoreChange, readBoard } from "../workspace/workspace-store-client";
import { WIDGET_PRELUDE } from "@hivemind/core/widget-api";
import { useSettings } from "../settings-store";
import type { WidgetBridge } from "./widget-hm";


type Update = (id: string, change: (o: BoardObject) => BoardObject) => void;

/** A move a widget asked for: to (x, y), each 0 to 1 across the screen, over `over` ms. `n` tells
 *  one move from the next. */
export interface WidgetMove { x: number; y: number; over: number; n: number }
/** What a widget shows: its drawing, its card's look, and the last move it asked for. */
export interface Drawing { tree: unknown; chrome: "card" | "none"; move?: WidgetMove }

/** A drawing as the host tells it, or undefined when it is not one. */
export function asDrawing(v: unknown): Drawing | undefined {
  if (typeof v !== "object" || v === null || !("tree" in v)) return undefined;
  const d = v as Partial<Drawing>;
  const m = d.move;
  const move = m && [m.x, m.y, m.over, m.n].every((n) => typeof n === "number" && Number.isFinite(n)) ? m : undefined;
  return { tree: d.tree, chrome: d.chrome === "none" ? "none" : "card", ...(move ? { move } : {}) };
}

// ── what widgets drew, for drawing them ─────────────────────────────────────

const drawn = new Map<string, unknown>();
const listeners = new Set<() => void>();
const changed = (): void => { for (const l of listeners) l(); };

/** The workspace whose widgets this window draws now. */
let shownRepo: string | null = null;
export const widgetsRepo = (): string | null => shownRepo;

/** Follow what the widgets of `repo` draw; returns how to stop. */
function followDrawn(repo: string): () => void {
  shownRepo = repo;
  drawn.clear();
  changed();
  let live = true;
  const stop = window.hive.onWidgetDrawn((r, id, tree) => {
    if (r !== repo) return;
    if (tree === null) drawn.delete(id); else drawn.set(id, tree);
    changed();
  });
  void window.hive.widgetsDrawn(repo).then((all) => {
    if (!live || !all) return;
    for (const [id, tree] of Object.entries(all)) if (!drawn.has(id)) drawn.set(id, tree);
    changed();
  }).catch(() => {});
  return () => { live = false; stop(); };
}

/** What the widget `id` last drew, or undefined. */
export function useDrawn(id: string): Drawing | undefined {
  return asDrawing(useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => drawn.get(id)));
}

// ── running their code ──────────────────────────────────────────────────────

const workers = new Map<string, Worker>();

/** Whether the person asked for less motion, which each widget is told at its start and on a change. */
const lessMotion = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
lessMotion?.addEventListener("change", (e) => { for (const w of workers.values()) w.postMessage({ type: "motion", payload: e.matches }); });

/** The widgets whose code runs in this window, with their packages: what WidgetLinks links. */
let runningWidgets: { id: string; pkg: WidgetPackage }[] = [];
const runningListeners = new Set<() => void>();
const announceRunning = () => {
  runningWidgets = [...workers.keys()].flatMap((id) => { const pkg = packageOf.get(id); return pkg ? [{ id, pkg }] : []; });
  for (const l of runningListeners) l();
};
const packageOf = new Map<string, WidgetPackage>();
export function useRunningWidgets(): { id: string; pkg: WidgetPackage }[] {
  return useSyncExternalStore((l) => { runningListeners.add(l); return () => { runningListeners.delete(l); }; }, () => runningWidgets);
}

/** Each running widget's `hive.hm`, once its link is up; what its worker asks before then waits. */
const bridges = new Map<string, WidgetBridge>();
const early = new Map<string, Array<{ type: string }>>();
export function setWidgetBridge(id: string, bridge: WidgetBridge | null): void {
  if (!bridge) { bridges.delete(id); return; }
  bridges.set(id, bridge);
  for (const m of early.get(id) ?? []) bridge.handle(m);
  early.delete(id);
}
export const postToWidget = (id: string, m: unknown): void => workers.get(id)?.postMessage(m);
/** The options each running widget was last given, as JSON. */
const sentOptions = new Map<string, string>();

/** A widget's options: what the person set, else each option's default; nothing it does not list. */
export function optionsOf(pkg: WidgetPackage, w: WidgetObject): Record<string, unknown> {
  return resolveSettings(pkg.options, w.options);
}

/** A widget's button was pressed: its code hears `action`, here or in the window that runs it. */
export function pressWidget(id: string, action: unknown): void {
  const w = workers.get(id);
  if (w) w.postMessage({ type: "action", payload: action });
  else if (shownRepo) window.hive.widgetPress(shownRepo, id, { action });
}

/** A widget's card was clicked (not on a button): its code hears "click", here or where it runs. */
export function clickWidget(id: string): void {
  const w = workers.get(id);
  if (w) w.postMessage({ type: "click" });
  else if (shownRepo) window.hive.widgetPress(shownRepo, id, { click: true });
}

// ── the installed packages, one list per window, read again when they change ──

// The app's own widgets are there from the first frame; the installed ones join when listed.
let packages: WidgetPackage[] = BUILTIN_WIDGETS;
const packageListeners = new Set<() => void>();
let watching = false;
const reloadPackages = (): void => {
  void window.hive.listWidgets().then((list) => {
    packages = list ?? [];
    for (const l of packageListeners) l();
  }).catch(() => {});
};

export function useWidgetPackages(): WidgetPackage[] {
  return useSyncExternalStore((l) => {
    packageListeners.add(l);
    if (!watching) { watching = true; window.hive.onWidgetsChanged?.(reloadPackages); reloadPackages(); }
    return () => packageListeners.delete(l);
  }, () => packages);
}

// ── the packages of the workspace shown: its host's, for one joined from another machine ──

let hosted: { repo: string; list: WidgetPackage[] } | null = null;
const hostedListeners = new Set<() => void>();
const loadHosted = (repo: string): void => {
  void window.hive.widgetPackagesOf(repo).then((list) => {
    if (hosted?.repo !== repo && hosted !== null) return;
    hosted = { repo, list: Array.isArray(list) ? list : [] };
    for (const l of hostedListeners) l();
  }, () => {});
};

/** The window shows `repo`: a joined one's widgets are its host's (the ones it has installed, read
 *  again when the window comes back to the front), a local one's this machine's. */
export function useShownWorkspace(repo: string | null, joined: boolean): void {
  useEffect(() => {
    if (!repo || !joined) { hosted = null; for (const l of hostedListeners) l(); return; }
    hosted = { repo, list: hosted?.repo === repo ? hosted.list : [] };
    loadHosted(repo);
    const again = () => loadHosted(repo);
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [repo, joined]);
}

/** The widgets of the workspace shown: what its board draws, its Add menu offers and its code runs
 *  on. Settings lists this machine's (`useWidgetPackages`). */
export function useShownWidgetPackages(): WidgetPackage[] {
  const local = useWidgetPackages();
  const here = useSyncExternalStore((l) => { hostedListeners.add(l); return () => hostedListeners.delete(l); }, () => hosted);
  return here ? here.list : local;
}

/** The widgets switched on (Settings ▸ Plugins): the ones offered to add, and the only ones whose
 *  code runs. One switched off keeps its boxes and what they hold. */
export function useEnabledWidgetPackages(): WidgetPackage[] {
  const all = useShownWidgetPackages();
  const state = useSettings().plugins.state;
  // Which are off, as text: any other setting changed (a view switched, a theme) must not hand
  // the runner a new list, which starts every widget's code again and loses what it was doing.
  const off = all.filter((p) => !isPluginEnabled(state, "widget", p.id)).map((p) => p.id).join("\n");
  return useMemo(() => {
    const skip = new Set(off ? off.split("\n") : []);
    return all.filter((p) => !skip.has(p.id));
  }, [all, off]);
}

/** Every widget in `repo` as a view is given it (view protocol 1.8), now and whenever one is drawn,
 *  changed on the board or its package changes: what a view that shows widgets (a phone's) draws. */
export function watchViewWidgets(repo: string, cb: (widgets: ViewWidget[]) => void): () => void {
  let queued = false;
  let last = "";
  const tell = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      const list = hosted?.repo === repo ? hosted.list : packages;
      const byId = new Map(list.map((p) => [p.id, p]));
      const widgets = readBoard(repo).filter((o): o is WidgetObject => o.kind === "widget")
        .map((o) => viewWidget(o, byId.get(o.widget), repo === shownRepo ? asDrawing(drawn.get(o.id))?.tree : undefined));
      const key = JSON.stringify(widgets);
      if (key === last) return;
      last = key;
      cb(widgets);
    });
  };
  listeners.add(tell);
  packageListeners.add(tell);
  hostedListeners.add(tell);
  const stopStore = onStoreChange((c) => { if (c.repo === repo) tell(); });
  tell();
  return () => { listeners.delete(tell); packageListeners.delete(tell); hostedListeners.delete(tell); stopStore(); };
}

/** The workspace this window runs widgets for now, if any. */
let runningFor: string | null = null;

/** Whether this window runs `repo`'s widgets: asked of its host, and again whenever the host
 *  says nobody does (asking again keeps it, so a lost answer heals itself). */
function useRunner(repo: string | null): boolean {
  const [running, setRunning] = useState(false);
  useEffect(() => {
    setRunning(false);
    if (!repo) return;
    runningFor = repo;
    let live = true;
    const ask = () => void window.hive.widgetRun(repo).then((yes) => {
      // A late answer for a workspace this window has left gives it back; one for the workspace it
      // still shows is the same claim as the newer ask's.
      if (!live) { if (yes && runningFor !== repo) window.hive.widgetRelease(repo); return; }
      setRunning(yes);
    }).catch(() => {});
    const stop = window.hive.onWidgetRunner((r) => { if (r === repo) ask(); });
    ask();
    return () => {
      live = false;
      stop();
      if (runningFor === repo) runningFor = null;
      // Let go only on leaving: a remount for the same workspace claims it again at once.
      queueMicrotask(() => { if (runningFor !== repo) window.hive.widgetRelease(repo); });
    };
  }, [repo]);
  return running;
}

/** Run `repo`'s widgets here while the host lets this window (the person's, on any of their
 *  devices with it open; a `hive host` has no window of its own). */
export function useWidgetRuntime(repo: string | null, objects: BoardObject[], packages: WidgetPackage[], update: Update): void {
  useEffect(() => (repo ? followDrawn(repo) : undefined), [repo]);
  const runner = useRunner(repo);
  const onBoard = useRef(new Set<string>());
  onBoard.current = new Set(objects.map((o) => o.id));

  // A press from wherever else it is shown (another window, a guest, a phone's view).
  useEffect(() => {
    if (!repo || !runner) return;
    return window.hive.onWidgetPressed((r, id, press) => {
      if (r !== repo) return;
      if (press.click) clickWidget(id); else pressWidget(id, press.action);
    });
  }, [repo, runner]);

  const widgets = runner ? objects.filter((o): o is WidgetObject => o.kind === "widget") : [];
  const key = widgets.map((w) => `${w.id}:${w.widget}`).join(",") + "|" + packages.map((p) => p.id).join(",");
  useEffect(() => {
    if (!repo) return;
    const byId = new Map(packages.map((p) => [p.id, p]));
    const want = new Set<string>();
    for (const w of widgets) {
      const pkg = byId.get(w.widget);
      // A widget drawn from its `draw` alone has no code to run.
      if (!pkg?.code) continue;
      want.add(w.id);
      if (workers.has(w.id)) continue;
      const url = URL.createObjectURL(new Blob([WIDGET_PRELUDE, pkg.code], { type: "text/javascript" }));
      const worker = new Worker(url);
      URL.revokeObjectURL(url);
      const id = w.id;
      const shown: Drawing = { tree: null, chrome: pkg.chrome };
      let moves = 0;
      const show = () => window.hive.widgetDraw(repo, id, shown);
      worker.onmessage = (e: MessageEvent<{ type: string; tree?: unknown; state?: unknown; text?: string; x?: number; y?: number; over?: number; req?: number; verb?: string; args?: unknown[] }>) => {
        const m = e.data;
        if (m.type.startsWith("hm-")) {
          const bridge = bridges.get(id);
          if (bridge) bridge.handle(m); else early.set(id, [...(early.get(id) ?? []), m].slice(-200));
          return;
        }
        if (m.type === "render") { shown.tree = m.tree ?? null; show(); }
        else if (m.type === "move") { shown.move = { x: m.x ?? 0, y: m.y ?? 0, over: m.over ?? 0, n: Date.now() * 1000 + (++moves % 1000) }; show(); }
        else if (m.type === "state") update(id, (o) => (o.kind === "widget" ? { ...o, state: m.state } : o));
        else if (m.type === "notify" && typeof Notification !== "undefined") new Notification(pkg.name, { body: m.text });
      };
      worker.onerror = (err) => console.warn(`[widget ${pkg.id}] ${err.message}`);
      worker.postMessage({ type: "init", state: w.state, options: optionsOf(pkg, w), reducedMotion: lessMotion?.matches === true });
      sentOptions.set(id, JSON.stringify(optionsOf(pkg, w)));
      workers.set(id, worker);
      packageOf.set(id, pkg);
    }
    for (const [id, worker] of workers) {
      if (want.has(id)) continue;
      worker.terminate();
      workers.delete(id);
      packageOf.delete(id);
      early.delete(id);
      // Taken off the board: what it drew goes too. Still there, another window runs it now.
      if (!onBoard.current.has(id)) window.hive.widgetDraw(repo, id, null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
    announceRunning();
  }, [key, update, repo, packages]);

  // Options the person changed reach the widget's code as they are set.
  useEffect(() => {
    const byId = new Map(packages.map((p) => [p.id, p]));
    for (const w of widgets) {
      const pkg = byId.get(w.widget);
      const worker = workers.get(w.id);
      if (!pkg || !worker) continue;
      const now = JSON.stringify(optionsOf(pkg, w));
      if (sentOptions.get(w.id) === now) continue;
      sentOptions.set(w.id, now);
      worker.postMessage({ type: "options", payload: JSON.parse(now) });
    }
  });

  // A workspace left, or packages added, removed or replaced: every widget starts again on its code now.
  useEffect(() => () => {
    for (const w of workers.values()) w.terminate();
    workers.clear(); packageOf.clear(); early.clear();
    announceRunning();
  }, [repo, packages]);
}
