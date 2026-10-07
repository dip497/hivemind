/**
 * Widgets on a host (the workspace API's `widget.*`). Where a widget's code runs: in one window of
 * the person's per workspace, the first to ask (`widget.run`), on this machine or on another of
 * their devices with it open (a `hive host` has no window of its own), until it lets go or goes;
 * the others are then told (`widget.runner`) and the first to ask again takes over. Someone else's
 * device never runs it: it would act in the workspace as them. The packages are this machine's
 * (`widget.packages`), so a device that runs or shows a widget has the host's, not its own. What it draws: kept
 * in memory here and told to every client, never written to the workspace's document, whose
 * history would keep each drawing for good; at most every 250 ms per widget, the latest winning.
 * The images a widget draws are served from its package here, to a client that does not have it.
 * A press anywhere else (a guest's window, a phone's view) is passed to the window that runs it.
 */
import { text } from "@hivemind/workspace-api/protocol";
import { emit, type Connection, type Domain, type WorkspaceServer } from "@hivemind/workspace-api/server";
import type { WidgetPress } from "@hivemind/workspace-api/methods";
import { WIDGET_FIELD_BYTES } from "@hivemind/workspace-doc/shapes";
import { viewWidget, type PlacedWidget, type WidgetPackage } from "@hivemind/core/widget-format";
import type { ViewWidget } from "@hivemind/view-sdk/protocol";

export const WIDGET_EVERY_MS = 250;

/** Whether `from` is the person: a window of this machine's, or one of their own devices. */
const isPerson = (from: Connection): boolean => from.actor.kind === "person" || (from.actor.kind === "peer" && from.actor.access === "owner");

/** Every widget in a workspace as a view is given it, and a press from a view: what a phone's view
 *  of widgets is served (view protocol 1.8). */
export interface WidgetsForViews {
  watch(repo: string, cb: (widgets: ViewWidget[]) => void): () => void;
  press(repo: string, id: string, press: WidgetPress): void;
}

export function widgets(
  server: () => WorkspaceServer,
  asset: (widget: string, name: string) => Promise<string | null> = async () => null,
  installed: () => Promise<WidgetPackage[]> = async () => [],
  board: (repo: string) => readonly { kind: string }[] = () => [],
): Domain<"widget.all" | "widget.run" | "widget.asset" | "widget.packages", "widget.draw" | "widget.release" | "widget.press"> & WidgetsForViews {
  const drawn = new Map<string, Map<string, unknown>>();
  const runners = new Map<string, Connection>();
  const toldAt = new Map<string, number>();
  const due = new Map<string, ReturnType<typeof setTimeout>>();
  const tell = (repo: string, id: string): void => {
    const key = `${repo}\n${id}`;
    if (due.has(key)) return;
    const send = () => { due.delete(key); toldAt.set(key, Date.now()); server().publish("widget.drawn", repo, id, drawn.get(repo)?.get(id) ?? null); };
    const wait = WIDGET_EVERY_MS - (Date.now() - (toldAt.get(key) ?? -Infinity));
    if (wait <= 0) return send();
    due.set(key, setTimeout(send, wait));
  };
  // A view's watch of a workspace's widgets, told when one draws (the board's changes it hears itself).
  const watchers = new Map<string, Set<() => void>>();
  /** Pass a press from anywhere but the runner to the window that runs the workspace's widgets. */
  const pass = (r: string, from: Connection | null, id: string, press: unknown): void => {
    const runner = runners.get(r);
    if (!runner || runner === from || runner.closed.aborted) return;
    const p = press as Partial<{ action: unknown; click: unknown }> | null;
    let size = Infinity;
    try { size = JSON.stringify(p?.action ?? null).length; } catch { /* not JSON: refused below */ }
    if (p?.click === true) emit(runner, "widget.pressed", r, id, { click: true });
    else if (p && "action" in p && size <= 1024) emit(runner, "widget.pressed", r, id, { action: p.action });
  };
  const release = (repo: string, from: Connection): void => {
    if (runners.get(repo) !== from) return;
    runners.delete(repo);
    server().publish("widget.runner", repo);
  };
  return {
    answers: {
      "widget.all": (_from, repo) => Object.fromEntries(drawn.get(text(repo, "repo")) ?? []),
      "widget.asset": (_from, repo, widget, name) => { text(repo, "repo"); return asset(text(widget, "widget"), text(name, "name")); },
      "widget.packages": async (from, repo) => {
        text(repo, "repo");
        const list = await installed();
        return isPerson(from) ? list : list.map((p) => ({ ...p, code: "" }));
      },
      "widget.run": (from, repo) => {
        if (!isPerson(from) || from.closed.aborted) return false;
        const r = text(repo, "repo");
        const now = runners.get(r);
        if (now && now !== from && !now.closed.aborted) return false;
        runners.set(r, from);
        return true;
      },
    },
    effects: {},
    notices: {
      "widget.draw": (from, repo, id, tree) => {
        const r = text(repo, "repo");
        if (runners.get(r) !== from) return;
        const w = text(id, "id");
        let size = Infinity;
        try { size = JSON.stringify(tree ?? null).length; } catch { /* not JSON: refused below */ }
        if (size > WIDGET_FIELD_BYTES) return;
        let here = drawn.get(r);
        if (!here) drawn.set(r, (here = new Map()));
        if (tree === null) here.delete(w); else here.set(w, tree);
        tell(r, w);
        for (const told of watchers.get(r) ?? []) told();
      },
      "widget.release": (from, repo) => release(text(repo, "repo"), from),
      "widget.press": (from, repo, id, press) => pass(text(repo, "repo"), from, text(id, "id"), press),
    },
    gone: (connection) => {
      for (const [repo, runner] of [...runners]) if (runner === connection) release(repo, connection);
    },
    watch: (repo, cb) => {
      let packages: WidgetPackage[] = [];
      let last = "";
      const told = (): void => {
        const byId = new Map(packages.map((p) => [p.id, p]));
        const list = board(repo).filter((o): o is PlacedWidget & { kind: string } => o.kind === "widget")
          // What the runner sends is a drawing, `{tree, chrome, move?}`: a view is given its tree.
          .map((o) => viewWidget(o, byId.get(o.widget), (drawn.get(repo)?.get(o.id) as { tree?: unknown } | undefined)?.tree));
        const key = JSON.stringify(list);
        if (key === last) return;
        last = key;
        cb(list);
      };
      let mine = watchers.get(repo);
      if (!mine) watchers.set(repo, (mine = new Set()));
      mine.add(told);
      // The board's changes, as every client hears them.
      const stop = new AbortController();
      server().connect({ actor: { kind: "person" }, closed: stop.signal, send: (m) => { if (m.event === "store.changed" && (m.params[0] as { repo?: unknown } | undefined)?.repo === repo) told(); } });
      void installed().then((p) => { packages = p; told(); }, () => told());
      return () => { mine!.delete(told); stop.abort(); };
    },
    press: (repo, id, press) => pass(repo, null, id, press),
  };
}
