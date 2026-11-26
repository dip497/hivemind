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
  /** The tile that started it (an agent's `hive ctl spawn`), when one did. */
  parent?: string;
  /** When the person last looked at it (ms); null when it is new to them. */
  seen?: number | null;
  /** Kept out of the list until then (ms), unless it needs the person sooner. */
  snoozedUntil?: number;
  /** An agent put to sleep: its process stopped until it is woken. */
  sleeping?: boolean;
}

/** Done since the person last looked: it changed after they saw it and is not still at work. A tile
 *  they have never seen counts as seen when it first appeared, so nothing opens unread. */
export function isUnread(t: Pick<ModelTile, "activity" | "seen" | "status">): boolean {
  return t.status !== "working" && t.activity !== null && t.seen != null && t.activity > t.seen;
}

/** Snoozed, and still for now: one that needs the person is back early. */
export function isSnoozed(t: Pick<ModelTile, "snoozedUntil" | "needsYou">, now: number): boolean {
  return t.snoozedUntil !== undefined && t.snoozedUntil > now && !t.needsYou;
}

/** The tile that most recently started waiting on the person, or null when none waits. */
export function newestWaiting<T extends Pick<ModelTile, "needsYou" | "activity">>(tiles: readonly T[]): T | null {
  let best: T | null = null;
  for (const t of tiles) if (t.needsYou && (!best || (t.activity ?? -1) > (best.activity ?? -1))) best = t;
  return best;
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
  /** Snoozed, soonest back first: listed apart, and in none of the lists above. */
  snoozed: ModelTile[];
  /** The tiles listed under another, by that tile's id: started by it and in the same list. The
   *  lists above hold only the tiles under no other. */
  kids: Map<string, ModelTile[]>;
  /** How many asleep tiles `hideAsleep` left out. */
  hiddenAsleep: number;
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
  if (s === "unread" && !isUnread(t)) return false;
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
  /** Searched for: only the tiles whose name or agent holds it, pinned ones too. */
  query?: string;
  /** Leave asleep tiles out of every list but Pinned. */
  hideAsleep?: boolean;
  /** What kind of row is listed; all when not given. */
  show?: LayersShow;
}): LayersView {
  const { prefs, now } = input;
  const show = input.show ?? "all";
  const q = input.query?.trim().toLowerCase() ?? "";
  const found = (t: ModelTile) => showsTile(show, t) && (!q || `${t.name} ${input.agentLabel(t)}`.toLowerCase().includes(q));
  const byId = new Map(input.tiles.map((t) => [t.id, t]));
  const snoozedNow = (t: ModelTile) => isSnoozed(t, now);
  const pinned = input.pinned.map((id) => byId.get(id)).filter((t): t is ModelTile => !!t && found(t) && !snoozedNow(t));
  const pinnedIds = new Set(input.pinned);
  let hiddenAsleep = 0;
  const shown = (t: ModelTile) => {
    if (!input.hideAsleep || !t.sleeping) return true;
    hiddenAsleep++;
    return false;
  };
  const rest = sorted(input.tiles.filter((t) => !pinnedIds.has(t.id) && found(t) && !snoozedNow(t) && passes(t, prefs, now) && shown(t)), prefs.sortBy);
  const snoozed = input.tiles.filter((t) => found(t) && snoozedNow(t) && shown(t)).sort((a, b) => a.snoozedUntil! - b.snoozedUntil!);
  const filtering = !!q || show !== "all" || prefs.status !== "all" || prefs.activity !== "all" || prefs.machines.length > 0 || hiddenAsleep > 0;
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
  const kids = new Map<string, ModelTile[]>();
  for (const [key, list] of byFrame) byFrame.set(key, nest(list, kids));
  for (const b of buckets) b.tiles = nest(b.tiles, kids);
  return { pinned, tree, byFrame, buckets, filtering, kids, snoozed, hiddenAsleep };
}

/** What kind of row Layers lists: everything, or only agents, drawings or pages. Chosen for each
 *  workspace, kept in its Layers layout. */
export const LAYERS_SHOW = ["all", "agents", "drawings", "pages"] as const;
export type LayersShow = (typeof LAYERS_SHOW)[number];

function showsTile(show: LayersShow, t: ModelTile): boolean {
  return show === "all" || (show === "agents" && t.agent !== undefined);
}

/** A drawing as Layers lists it: the board objects that share one drawing id, or a frame's shapes
 *  that belong to no drawing. */
export interface DrawingRow {
  /** The drawing id; `shapes:` and the frame's id for a frame's loose shapes. */
  key: string;
  name: string;
  /** Its frame, or null on the bare canvas. */
  frameId: string | null;
  /** The tile of the agent that drew it. */
  by?: string;
  /** One of its objects: what a click on the row goes to. */
  objectId: string;
  /** All it says, lower case: what a search looks in. */
  text: string;
  /** What its second column says: how many shapes, or what it is. Empty when its name says so. */
  detail: string;
  /** It holds a shape, which can be locked (an arrow cannot). */
  lockable: boolean;
  /** Every shape in it is locked. */
  locked: boolean;
}

/** Drawing rows by frame (null: the bare canvas), each frame's in board order. */
export type DrawingsByFrame = ReadonlyMap<string | null, readonly DrawingRow[]>;

/**
 * The drawings and pages a search and the All / Agents / Drawings / Pages choice let through. A
 * page is listed for its own sake when it is in `pages`; it is still listed for what it holds.
 * The tiles' own filters (status, last activity, machines) leave both out under All. Nothing
 * searched, under All or Drawings: `drawings` is the map given, so it can be kept by identity.
 */
export function layersFound(input: {
  drawings: DrawingsByFrame;
  /** The frames that are pages. */
  pages: readonly { id: string; title: string }[];
  prefs: LayersPrefs;
  show?: LayersShow;
  query?: string;
}): { drawings: DrawingsByFrame; pages: ReadonlySet<string> } {
  const show = input.show ?? "all";
  const q = input.query?.trim().toLowerCase() ?? "";
  const { prefs } = input;
  const tilesFiltered = prefs.status !== "all" || prefs.activity !== "all" || prefs.machines.length > 0;
  const open = show === "drawings" || show === "pages" || !tilesFiltered;
  const none: DrawingsByFrame = new Map();
  let drawings = none;
  if (open && (show === "all" || show === "drawings")) {
    if (!q) drawings = input.drawings;
    else {
      const kept = new Map<string | null, DrawingRow[]>();
      for (const [frame, rows] of input.drawings) {
        const hit = rows.filter((r) => r.text.includes(q));
        if (hit.length) kept.set(frame, hit);
      }
      drawings = kept;
    }
  }
  const pages = new Set<string>();
  if (open && (show === "all" || show === "pages")) {
    for (const p of input.pages) if (!q || p.title.toLowerCase().includes(q)) pages.add(p.id);
  }
  return { drawings, pages };
}

/** A part of what a frame holds. `tiles` is its agents and tools together, in canvas order. */
export type FramePart = "tiles" | "agents" | "tools" | "frames" | "pages" | "drawings";
/** One part's rows: under a heading of their own that folds (`grouped`), or straight under the frame. */
export interface FramePartList { part: FramePart; label: string; count: number; grouped: boolean }
/** A part with more rows than this, in a frame that holds something else too, gets a heading. */
export const FEW_ROWS = 3;
const PART_LABELS: Record<FramePart, string> = { tiles: "Tiles", agents: "Agents", tools: "Tools", frames: "Frames", pages: "Pages", drawings: "Drawings" };

/**
 * How a frame's rows read as a folder tree, in this order: agents, tools, frames, pages, drawings,
 * each part with rows once. Drawings fold under one heading once there are two; agents, tools and
 * pages do when they have more than `FEW_ROWS` and the frame holds something else too. Frames are
 * folders already and never get one. While neither agents nor tools have a heading, they are one
 * `tiles` part, so their rows keep the canvas's order.
 */
export function frameParts(counts: Readonly<{ agents: number; tools: number; frames: number; pages: number; drawings: number }>): FramePartList[] {
  const total = counts.agents + counts.tools + counts.frames + counts.pages + counts.drawings;
  const heads = (part: FramePart, n: number): boolean =>
    part === "drawings" ? n > 1 : part !== "frames" && n > FEW_ROWS && total > n;
  const list = (part: FramePart, count: number): FramePartList => ({ part, label: PART_LABELS[part], count, grouped: heads(part, count) });
  const tilesApart = heads("agents", counts.agents) || heads("tools", counts.tools);
  const parts: FramePartList[] = tilesApart
    ? [list("agents", counts.agents), list("tools", counts.tools)]
    : [{ part: "tiles", label: PART_LABELS.tiles, count: counts.agents + counts.tools, grouped: false }];
  parts.push(list("frames", counts.frames), list("pages", counts.pages), list("drawings", counts.drawings));
  return parts.filter((p) => p.count > 0);
}

/** `list` without the tiles whose starter is in it too, which go into `kids` under it, in list
 *  order. A tile whose starters loop back to it stays in the list, so no tile is ever lost. */
function nest(list: ModelTile[], kids: Map<string, ModelTile[]>): ModelTile[] {
  const here = new Map(list.map((t) => [t.id, t]));
  const under = (t: ModelTile): boolean => {
    const seen = new Set([t.id]);
    for (let p = t.parent; p !== undefined && here.has(p); p = here.get(p)!.parent) {
      if (seen.has(p)) return false;
      seen.add(p);
    }
    return t.parent !== undefined && here.has(t.parent);
  };
  const top: ModelTile[] = [];
  for (const t of list) {
    if (!under(t)) { top.push(t); continue; }
    const k = kids.get(t.parent!) ?? [];
    k.push(t);
    kids.set(t.parent!, k);
  }
  return top;
}

/** A past session an agent kept for a folder: what a Recents list shows. */
export interface RecentSession { agent: string; id: string; folder: string; updated?: number; prompt?: string }

/** Each session once, none a tile has open, the search's only, newest first. */
function recentRows(rows: readonly RecentSession[], opts: { open?: ReadonlySet<string>; query?: string; agentLabel?: (agent: string) => string }): RecentSession[] {
  const q = opts.query?.trim().toLowerCase() ?? "";
  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = `${r.agent}:${r.id}`;
    if (seen.has(key) || opts.open?.has(r.id)) return false;
    seen.add(key);
    return !q || `${r.prompt ?? ""} ${opts.agentLabel?.(r.agent) ?? r.agent}`.toLowerCase().includes(q);
  }).sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
}

export type RecentsBy = "agent" | "project" | "date" | "none";
/** A heading of Recents and its newest sessions; `more` are left for "Show more". */
export interface RecentGroup { key: string; label: string; rows: RecentSession[]; more: number }

/** Recents grouped (`by`): by agent and by project the group with the newest session first, by date
 *  Today, Yesterday, This week, Older; "none" one group with no heading. Each shows `limit(key)`. */
export function recentGroups(rows: readonly RecentSession[], opts: {
  by: RecentsBy;
  now: number;
  limit: (key: string) => number;
  open?: ReadonlySet<string>;
  query?: string;
  agentLabel?: (agent: string) => string;
  /** A folder's name as Recents shows it; its last path segment when absent. */
  folderLabel?: (folder: string) => string;
}): RecentGroup[] {
  const kept = recentRows(rows, opts);
  const today = midnight(opts.now);
  const keyOf = (r: RecentSession): [string, string] => {
    if (opts.by === "agent") return [r.agent, opts.agentLabel?.(r.agent) ?? r.agent];
    if (opts.by === "project") return [r.folder, opts.folderLabel?.(r.folder) ?? (r.folder.split(/[\\/]/).filter(Boolean).pop() ?? r.folder)];
    if (opts.by === "date") {
      const at = r.updated ?? 0;
      return at >= today ? ["today", "Today"] : at >= today - DAY ? ["yesterday", "Yesterday"] : at >= today - 6 * DAY ? ["week", "This week"] : ["older", "Older"];
    }
    return ["all", ""];
  };
  const groups = new Map<string, { label: string; all: RecentSession[] }>();
  for (const r of kept) {
    const [key, label] = keyOf(r);
    const g = groups.get(key) ?? { label, all: [] };
    g.all.push(r);
    groups.set(key, g);
  }
  // Rows are newest first, so a group's first session is its newest, and insertion order is newest group first.
  const ordered = [...groups.entries()];
  if (opts.by === "date") ordered.sort(([a], [b]) => DATE_ORDER.indexOf(a) - DATE_ORDER.indexOf(b));
  return ordered.map(([key, g]) => {
    const n = opts.limit(key);
    return { key, label: g.label, rows: g.all.slice(0, n), more: Math.max(0, g.all.length - n) };
  });
}

/** A workspace at a glance, from its tiles' statuses: how many, how many need the person, how many work. */
export function workspaceCounts(statuses: readonly (LayerStatus | null)[]): { tiles: number; needsYou: number; working: number } {
  const waiting = new Set<LayerStatus>(["blocked", "permission", "question", "plan_review", "awaiting_approval"]);
  return {
    tiles: statuses.length,
    needsYou: statuses.filter((s) => s !== null && waiting.has(s)).length,
    working: statuses.filter((s) => s === "working").length,
  };
}
