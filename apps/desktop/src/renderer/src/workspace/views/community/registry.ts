/**
 * Community view loading: ask main for the installed packages (user dir +
 * this repo's `.hivemind/views`), register each loadable one as a view plugin
 * whose component is the sandboxed host (CommunityView.tsx), and drop the ones
 * that went away. Re-run on every repo switch and on `hivemind:reload-views`.
 *
 * A package is refused here (never registered, reason kept for `hive views
 * list` parity + the test seam) when main already flagged it, when it speaks a
 * newer protocol, when its id is a built-in view's, or when it was disabled
 * earlier this session for misbehaving.
 */
import { Puzzle } from "lucide-react";
import { toast } from "sonner";
import { PROTOCOL_VERSION } from "@hivemind/view-sdk/protocol";
import type { ViewPackageInfo } from "../../../../../shared/ipc";
import { getView, registerView, unregisterView, listViews } from "../../workspace-view";
import { lazy, createElement, type ComponentType } from "react";
import type { WorkspaceViewProps } from "../../workspace-view";

// The host component is its own chunk (like the World view): nobody without
// a community view installed pays for it, and the entry-chunk guard
// (renderer-chunks.test.ts) stays meaningful.
const CommunityViewLazy = lazy(() => import("./CommunityView").then((m) => ({ default: m.CommunityViewHost })));
function makeCommunityView(pkg: ViewPackageInfo): ComponentType<WorkspaceViewProps> {
  return function CommunityViewFor(props: WorkspaceViewProps) { return createElement(CommunityViewLazy, { pkg, ...props }); };
}

export interface CommunityLoadReport {
  packages: ViewPackageInfo[];
  /** id → why it is not registered. */
  refused: Record<string, string>;
  registered: string[];
}

const disabled = new Map<string, string>();
const registeredUrl = new Map<string, string>();

export function disableCommunityView(id: string, reason: string): void {
  disabled.set(id, reason);
  registeredUrl.delete(id);
  unregisterView(id);
  publish();
}

// Main's CPU watchdog (view-packages.ts) — a plugin frame pegging a core.
if (typeof window !== "undefined" && window.hive?.onViewRunaway) {
  window.hive.onViewRunaway(({ id, cpuPct }) => {
    if (!getView(id) || getView(id)!.source !== "community") return;
    const reason = `runaway: ${cpuPct}% CPU in its sandbox`;
    toast.error(`The ${getView(id)!.label} view was disabled: ${reason}. Switched back to Canvas — your tiles are untouched.`);
    disableCommunityView(id, reason);
  });
}

let last: CommunityLoadReport = { packages: [], refused: {}, registered: [] };
function publish() {
  last = { ...last, registered: listViews().filter((v) => v.source === "community").map((v) => v.id) };
  for (const [id, why] of disabled) last.refused[id] = `disabled: ${why}`;
  (window as Window & { __hivemindViews?: CommunityLoadReport }).__hivemindViews = last;
}

export async function loadCommunityViews(repoRoot: string | null): Promise<CommunityLoadReport> {
  let packages: ViewPackageInfo[] = [];
  try { packages = await window.hive.listViews(repoRoot); }
  catch (e) { console.warn("[hivemind] views: list failed", e); }
  const refused: Record<string, string> = {};
  const keep = new Set<string>();
  for (const p of packages) {
    let why = p.error;
    if (!why && (!p.manifest || !p.url)) why = "no manifest";
    if (!why && p.manifest!.protocol > PROTOCOL_VERSION) why = `needs protocol ${p.manifest!.protocol}; this app speaks ${PROTOCOL_VERSION}`;
    if (!why && disabled.has(p.id)) why = `disabled: ${disabled.get(p.id)}`;
    if (!why && getView(p.id) && getView(p.id)!.source !== "community") why = `"${p.id}" is a built-in view`;
    if (!why && keep.has(p.id)) why = "duplicate id";
    if (why) { refused[p.id] = why; continue; }
    keep.add(p.id);
    if (registeredUrl.get(p.id) !== p.url) {
      registerView({ id: p.id, label: p.manifest!.name, hint: `Community view ${p.manifest!.version} (${p.source}) — runs sandboxed.`, icon: Puzzle, component: makeCommunityView(p), source: "community" });
      registeredUrl.set(p.id, p.url!);
    }
  }
  for (const v of listViews()) if (v.source === "community" && !keep.has(v.id)) { unregisterView(v.id); registeredUrl.delete(v.id); }
  last = { packages, refused, registered: [] };
  publish();
  return last;
}
