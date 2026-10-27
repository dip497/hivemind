/**
 * A package's view brings the package's widgets. The first time a workspace shows a view that came
 * in a package (Archipelago), each of that package's widgets that is switched on and not on the
 * workspace already is added, floating down the view's widget edge. However the view was opened:
 * the switcher, Layers, ⌘E, "Open Archipelago?", `hive ctl plugin open view:`, or the view the app
 * starts in.
 *
 * What it brought is kept for the workspace, on this machine as card spots are, so a widget the
 * person closed is never brought back, and one a later version of the package adds is brought the
 * next time the view shows. Never in a workspace joined from someone else: the board is theirs.
 */
import { useEffect } from "react";
import type { BoardObject } from "@hivemind/workspace-doc/shapes";
import type { WidgetPackage } from "../../../shared/ipc";
import { useCommunityReport } from "../workspace/views/community/registry";
import { widgetsToBring } from "./board-model";

const broughtKey = (repo: string) => `hivemind:widgets-brought:${repo}`;

function readBrought(repo: string): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(broughtKey(repo)) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}
function writeBrought(repo: string, ids: readonly string[]): void {
  try { localStorage.setItem(broughtKey(repo), JSON.stringify(ids)); } catch { /* not kept: brought again next time, never twice on the board */ }
}

export function useViewBringsWidgets({ repo, joined, view, widgets, board }: {
  /** The workspace shown. */
  repo: string | null;
  joined: boolean;
  /** The view shown. */
  view: string | null;
  /** The widgets that are switched on. */
  widgets: readonly WidgetPackage[];
  board: { objectsRef: { current: BoardObject[] }; addWidget: (pkg: string) => string };
}): void {
  const { packages } = useCommunityReport();
  const pkg = packages.find((p) => p.id === view)?.package;
  const pkgId = pkg?.on ? pkg.id : null;
  // A key, so a list that only came back equal starts nothing.
  const members = pkgId ? widgets.filter((w) => w.package?.id === pkgId).map((w) => w.id).join("\n") : "";
  const { objectsRef, addWidget } = board;
  useEffect(() => {
    if (!repo || joined || !members) return;
    const known = readBrought(repo);
    const onBoard = objectsRef.current.flatMap((o) => (o.kind === "widget" ? [o.widget] : []));
    const { add, brought } = widgetsToBring(members.split("\n"), onBoard, known);
    if (!brought.length) return;
    for (const id of add) addWidget(id);
    writeBrought(repo, [...known, ...brought]);
  }, [repo, joined, members, objectsRef, addWidget]);
}
