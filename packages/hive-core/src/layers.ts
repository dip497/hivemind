/**
 * What a list of a workspace's tiles shows, from the person's choices (`views.layers`): the pinned
 * tiles on top, then the rest the choices let through, grouped and ordered as they say. One owner
 * for every surface that lists tiles (the app's Layers panel, and any other), pure and tested here.
 */
import type { LayersPrefs } from "./settings-schema.js";

/** A tile's status, as every surface names it. */
export type LayerStatus = "working" | "idle" | "blocked" | "permission" | "question" | "exited" | "plan_review" | "awaiting_approval";

export interface ModelTile {
  id: string;
  kind: string;
  name: string;
  /** Its frame, or null when loose. */
  frameId: string | null;
  /** An agent tile's agent id. */
  agent?: string;
  status: LayerStatus;
  /** Waits on the person: blocked, asking, or a review only they can answer. */
  needsYou: boolean;
  /** When its status last changed (ms), when known. */
  activity: number | null;
  /** The computer it runs on: "local", or a machine's key. */
  machine: string;
}

/** A heading and the tiles under it, for the groupings that are not the workspace's own tree. */
export interface Bucket { key: string; label: string; tiles: ModelTile[] }

export interface LayersView {
  /** Pinned, in the order pinned; shown whatever the View menu says, and nowhere else. */
  pinned: ModelTile[];
  /** Grouped by machine or group: the workspace's own tree, with these tiles per frame (null: none). */
  tree: boolean;
  byFrame: Map<string | null, ModelTile[]>;
  /** Any other grouping: its headings in order (one with no label for "none"). */
  buckets: Bucket[];
  /** The View menu leaves some tiles out: frames left with none are not listed. */
  filtering: boolean;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function midnight(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function passes(t: ModelTile, prefs: LayersPrefs, now: number): boolean {
  if (prefs.machines.length && !prefs.machines.includes(t.machine)) return false;
  const s = prefs.status;
  if (s === "needs-you" && !t.needsYou) return false;
  if (s === "working" && (t.needsYou || t.status !== "working")) return false;
  if (s === "idle" && (t.needsYou || t.status !== "idle")) return false;
  if (s === "exited" && t.status !== "exited") return false;
  if (prefs.activity === "all") return true;
  if (t.activity === null) return false;
  const since = prefs.activity === "hour" ? now - HOUR : prefs.activity === "today" ? midnight(now) : now - 7 * DAY;
  return t.activity >= since;
}

function sorted(tiles: ModelTile[], by: LayersPrefs["sortBy"]): ModelTile[] {
  if (by === "canvas") return tiles;
  if (by === "name") return [...tiles].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return [...tiles].sort((a, b) => (b.activity ?? -1) - (a.activity ?? -1));
}

const STATUS_BUCKETS: Array<[string, string, (t: ModelTile) => boolean]> = [
  ["needs-you", "Needs you", (t) => t.needsYou],
  ["working", "Working", (t) => t.status === "working"],
  ["exited", "Exited", (t) => t.status === "exited"],
  ["idle", "Idle", () => true],
];

function dateBucket(t: ModelTile, now: number): [string, string] {
  const today = midnight(now);
  if (t.activity === null) return ["older", "Older"];
  if (t.activity >= today) return ["today", "Today"];
  if (t.activity >= today - DAY) return ["yesterday", "Yesterday"];
  if (t.activity >= today - 6 * DAY) return ["week", "This week"];
  return ["older", "Older"];
}
const DATE_ORDER = ["today", "yesterday", "week", "older"];

/** `tiles` in canvas order; `pinned` ids in the order they were pinned; `agentLabel` names a tile's
 *  agent or kind for grouping by agent. */
export function layersView(input: {
  tiles: readonly ModelTile[];
  pinned: readonly string[];
  prefs: LayersPrefs;
  now: number;
  agentLabel: (t: ModelTile) => string;
}): LayersView {
  const { prefs, now } = input;
  const byId = new Map(input.tiles.map((t) => [t.id, t]));
  const pinned = input.pinned.map((id) => byId.get(id)).filter((t): t is ModelTile => !!t);
  const pinnedIds = new Set(pinned.map((t) => t.id));
  const rest = sorted(input.tiles.filter((t) => !pinnedIds.has(t.id) && passes(t, prefs, now)), prefs.sortBy);
  const filtering = prefs.status !== "all" || prefs.activity !== "all" || prefs.machines.length > 0;
  const tree = prefs.groupBy === "machine" || prefs.groupBy === "group";
  const byFrame = new Map<string | null, ModelTile[]>();
  const buckets: Bucket[] = [];
  if (tree) {
    for (const t of rest) {
      const list = byFrame.get(t.frameId) ?? [];
      list.push(t);
      byFrame.set(t.frameId, list);
    }
  } else if (prefs.groupBy === "none") {
    if (rest.length) buckets.push({ key: "all", label: "", tiles: rest });
  } else if (prefs.groupBy === "status") {
    const left = new Set(rest);
    for (const [key, label, test] of STATUS_BUCKETS) {
      const tiles = rest.filter((t) => left.has(t) && test(t));
      for (const t of tiles) left.delete(t);
      if (tiles.length) buckets.push({ key, label, tiles });
    }
  } else {
    const groups = new Map<string, Bucket>();
    for (const t of rest) {
      const [key, label] = prefs.groupBy === "date" ? dateBucket(t, now) : (() => { const l = input.agentLabel(t); return [l.toLowerCase(), l] as [string, string]; })();
      const b = groups.get(key) ?? { key, label, tiles: [] };
      b.tiles.push(t);
      groups.set(key, b);
    }
    const order = prefs.groupBy === "date"
      ? [...groups.values()].sort((a, b) => DATE_ORDER.indexOf(a.key) - DATE_ORDER.indexOf(b.key))
      : [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
    buckets.push(...order);
  }
  return { pinned, tree, byFrame, buckets, filtering };
}
