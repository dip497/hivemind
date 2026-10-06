/**
 * Widgets' code, run in this window: one worker per widget on the board, only where the
 * workspace is kept (a joined workspace's widgets run on its host; a guest sees what they drew).
 * A worker reaches no network (the page's CSP) and nothing of the app but what `hive` gives it:
 * draw, keep state, notify, hear the agents' states and its buttons.
 * ponytail: every window of a workspace runs its widgets; one runner per workspace when two
 * windows show one and both write.
 */
import { useEffect, useRef, useState } from "react";
import type { BoardObject, WidgetObject } from "@hivemind/workspace-doc/shapes";
import type { WidgetPackage } from "../../../shared/ipc";

const PRELUDE = `const hive = (() => {
  const on = {}; let state;
  const fire = (t, p) => (on[t] || []).forEach((f) => { try { f(p); } catch (e) { console.error(e); } });
  self.onmessage = (e) => { const m = e.data; if (m.type === "init") state = m.state; fire(m.type === "init" ? "start" : m.type, m.payload); };
  return {
    render: (tree) => postMessage({ type: "render", tree }),
    get state() { return state; },
    setState: (s) => { state = s; postMessage({ type: "state", state: s }); },
    notify: (text) => postMessage({ type: "notify", text: String(text) }),
    on: (t, f) => { (on[t] = on[t] || []).push(f); },
  };
})();
`;

type Update = (id: string, change: (o: BoardObject) => BoardObject) => void;

const workers = new Map<string, Worker>();

/** A widget's button was pressed: its code hears `action`. False when its code does not run here. */
export function pressWidget(id: string, action: unknown): boolean {
  const w = workers.get(id);
  w?.postMessage({ type: "action", payload: action });
  return !!w;
}

export function useWidgetPackages(): WidgetPackage[] {
  const [list, setList] = useState<WidgetPackage[]>([]);
  useEffect(() => { void window.hive.listWidgets?.().then(setList).catch(() => setList([])); }, []);
  return list;
}

export function useWidgetRuntime(objects: BoardObject[], packages: WidgetPackage[], update: Update, joined: boolean): void {
  const agents = useRef<Record<string, string>>({});

  useEffect(() => window.hive.onHcpStatus((e) => {
    agents.current = { ...agents.current, [e.tileId]: e.status.state };
    for (const w of workers.values()) w.postMessage({ type: "agents", payload: agents.current });
  }), []);

  const widgets = joined ? [] : objects.filter((o): o is WidgetObject => o.kind === "widget");
  const key = widgets.map((w) => `${w.id}:${w.widget}`).join(",") + "|" + packages.map((p) => p.id).join(",");
  useEffect(() => {
    const byId = new Map(packages.map((p) => [p.id, p]));
    const want = new Set<string>();
    for (const w of widgets) {
      const pkg = byId.get(w.widget);
      if (!pkg) continue;
      want.add(w.id);
      if (workers.has(w.id)) continue;
      const url = URL.createObjectURL(new Blob([PRELUDE, pkg.code], { type: "text/javascript" }));
      const worker = new Worker(url);
      URL.revokeObjectURL(url);
      const id = w.id;
      worker.onmessage = (e: MessageEvent<{ type: string; tree?: unknown; state?: unknown; text?: string }>) => {
        const m = e.data;
        if (m.type === "render") update(id, (o) => (o.kind === "widget" ? { ...o, render: m.tree } : o));
        else if (m.type === "state") update(id, (o) => (o.kind === "widget" ? { ...o, state: m.state } : o));
        else if (m.type === "notify" && typeof Notification !== "undefined") new Notification(pkg.name, { body: m.text });
      };
      worker.onerror = (err) => console.warn(`[widget ${pkg.id}] ${err.message}`);
      worker.postMessage({ type: "init", state: w.state });
      worker.postMessage({ type: "agents", payload: agents.current });
      workers.set(id, worker);
    }
    for (const [id, worker] of workers) if (!want.has(id)) { worker.terminate(); workers.delete(id); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, update]);

  useEffect(() => () => { for (const w of workers.values()) w.terminate(); workers.clear(); }, []);
}
