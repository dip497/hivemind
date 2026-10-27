/**
 * A package's view brings the package's widgets. The first time a workspace shows a view that came
 * in a package (Archipelago), each of that package's widgets that is switched on and not on the
 * workspace already is added, floating down the view's widget edge, and drawn over that view alone
 * (`WidgetObject.view`) until the person shows it on every view. However the view was opened:
 * the switcher, Layers, ⌘E, "Open Archipelago?", `hive ctl plugin open view:`, or the view the app
 * starts in.
 *
 * What it brought is kept with the workspace, in its store beside the board, so every window and
 * browser tab on it reads one record: a widget the person closed is never brought back, and one a
 * later version of the package adds is brought when the view shows. Never in a workspace joined
 * from someone else: the board is theirs.
 */
import { useEffect } from "react";
import type { BoardObject } from "@hivemind/workspace-doc/shapes";
import type { WidgetPackage } from "../../../shared/ipc";
import { useCommunityReport } from "../workspace/views/community/registry";
import { readView, writeView } from "../workspace/workspace-store-client";
import { widgetsToBring } from "./board-model";

/** The workspace's record of the widgets views brought it. */
const BROUGHT = "widgets-brought";

function readBrought(repo: string): string[] {
  const v = readView(repo, BROUGHT);
  return v?.v === 1 && Array.isArray(v.data) ? v.data.filter((x): x is string => typeof x === "string") : [];
}

export function useViewBringsWidgets({ repo, joined, view, widgets, board }: {
  /** The workspace shown. */
  repo: string | null;
  joined: boolean;
  /** The view shown. */
  view: string | null;
  /** The widgets that are switched on. */
  widgets: readonly WidgetPackage[];
  board: { objectsRef: { current: BoardObject[] }; bringWidgets: (pkgs: readonly string[], view: string) => void };
}): void {
  const { packages } = useCommunityReport();
  const pkg = packages.find((p) => p.id === view)?.package;
  const pkgId = pkg?.on ? pkg.id : null;
  // A key, so a list that only came back equal starts nothing.
  const members = pkgId ? widgets.filter((w) => w.package?.id === pkgId).map((w) => w.id).join("\n") : "";
  const { objectsRef, bringWidgets } = board;
  useEffect(() => {
    if (!repo || joined || !members || !view) return;
    // Read, decided and written at once through the store, so a second window on the workspace
    // reads what this one brought.
    const known = readBrought(repo);
    const onBoard = objectsRef.current.flatMap((o) => (o.kind === "widget" ? [o.widget] : []));
    const { add, brought } = widgetsToBring(members.split("\n"), onBoard, known);
    if (!brought.length) return;
    writeView(repo, BROUGHT, { v: 1, data: [...known, ...brought] });
    // Drawn over this view alone: they are its company, not the canvas's.
    bringWidgets(add, view);
  }, [repo, joined, members, view, objectsRef, bringWidgets]);
}
