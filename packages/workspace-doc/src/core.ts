/**
 * The core layout in a workspace document (docs/design/multiplayer-2026-09-28.md §8): frames as
 * a tree, tiles as a map of records, their order as a movable list. `writeCore` turns a whole
 * layout, as the window saves it, into the edits that make the document hold it, so a write
 * records only what changed and edits from two writers merge; given the layout the writer
 * started from, it writes only what the writer changed (rebase.ts). `readCore` builds it back;
 * `writeTileName` names one tile and `removeTile` takes one out.
 */
import type { LoroDoc, LoroMap, LoroTree, LoroTreeNode, TreeID } from "loro-crdt";
import { isMap, writeFields } from "./fields.js";
import { firstOfEachId, isObject, type Fields } from "./input.js";
import { readOrder, writeOrder } from "./order.js";
import { rebaseCore } from "./rebase.js";
import { FRAMES, META, ORDER, TILES, stampSchema } from "./schema.js";
import type { CoreLayout, FrameRecord, TileRecord } from "./shapes.js";

/** Tile fields the document fills from the layout's per-tile maps (see TileRecord). */
const PER_TILE = ["frame", "name", "tabs"] as const;

type Layout = Required<CoreLayout>;

const NO_LAYOUT: Layout = { frames: [], tiles: [], tileNames: {}, editorTabs: {}, frameOf: {} };

/**
 * Make `doc` hold the core layout `value`. Entries without an id (or a tile without a kind) are
 * dropped, and a repeated id keeps its first entry, as the window's own loader does. A layout
 * that is not an object, or a tile that sets a per-tile field itself, is refused.
 *
 * Given `base`, the layout `value` was made from (null: none was read), only what changed from
 * it is written, and the rest stays as `doc` has it now: a write from an older reading never
 * reverts an edit made since.
 */
export function writeCore(doc: LoroDoc, value: unknown, base?: unknown): void {
  const next = toLayout(value);
  const layout = base === undefined ? next : rebaseCore(base === null ? NO_LAYOUT : toLayout(base), next, (readCore(doc) as Layout | null) ?? NO_LAYOUT);
  stampSchema(doc);
  writeFrames(doc.getTree(FRAMES), layout.frames);
  writeTiles(doc.getMap(TILES), layout);
  writeOrder(doc.getMovableList(ORDER), layout.tiles.map((t) => t.id));
  const meta = doc.getMap(META);
  if (meta.get("core") !== true) meta.set("core", true);
}

/** Take the tile `tileId` out of the layout, with its name, tabs and frame. What it was, or null
 *  when `doc` has no such tile. */
export function removeTile(doc: LoroDoc, tileId: string): TileRecord | null {
  if (typeof tileId !== "string") throw new TypeError("workspace doc: a tile's id is a string");
  const tiles = doc.getMap(TILES);
  const record = tiles.get(tileId);
  if (!isMap(record)) return null;
  const { frame: _frame, name: _name, tabs: _tabs, ...fields } = record.toJSON() as Fields;
  tiles.delete(tileId);
  // A merge can leave an id listed twice.
  const order = doc.getMovableList(ORDER);
  const listed = order.toArray();
  for (let at = listed.length - 1; at >= 0; at--) if (listed[at] === tileId) order.delete(at, 1);
  return { ...fields, id: tileId } as unknown as TileRecord;
}

/** Name the tile `tileId`, or take its name away with "". False when `doc` has no such tile. */
export function writeTileName(doc: LoroDoc, tileId: string, name: string): boolean {
  if (typeof tileId !== "string" || typeof name !== "string") throw new TypeError("workspace doc: a tile's id and name are strings");
  const record = doc.getMap(TILES).get(tileId);
  if (!isMap(record)) return false;
  if (name) record.set("name", name);
  else record.delete("name");
  return true;
}

/** Has a core layout ever been written to `doc`? */
export function hasCore(doc: LoroDoc): boolean {
  return doc.getMap(META).get("core") === true;
}

/** The core layout in `doc`, or null when none was ever written. */
export function readCore(doc: LoroDoc): CoreLayout | null {
  if (!hasCore(doc)) return null;
  const tiles = doc.getMap(TILES).toJSON() as Fields;
  const layout: Layout = { frames: readFrames(doc.getTree(FRAMES)), tiles: [], tileNames: {}, editorTabs: {}, frameOf: {} };
  for (const id of readOrder(doc.getMovableList(ORDER).toArray(), Object.keys(tiles))) {
    const record = tiles[id];
    if (!isObject(record)) continue;
    const { frame, name, tabs, ...fields } = record;
    layout.tiles.push({ ...fields, id } as unknown as TileRecord);
    if (typeof frame === "string") layout.frameOf[id] = frame;
    if (typeof name === "string") layout.tileNames[id] = name;
    if (Array.isArray(tabs)) layout.editorTabs[id] = tabs as string[];
  }
  return layout;
}

// ── frames ──────────────────────────────────────────────────────────────────

function writeFrames(tree: LoroTree, frames: FrameRecord[]): void {
  const nodes = frameNodes(tree);
  const parent = parentsOf(frames);
  const children = new Map<string | undefined, FrameRecord[]>();
  for (const frame of frames) {
    const p = parent.get(frame.id);
    children.set(p, [...(children.get(p) ?? []), frame]);
  }
  // Parents are placed before their children, each at its index among its siblings, so a node
  // is only ever moved under a parent already in its final place, never under its own subtree.
  const place = (p: string | undefined): void => {
    (children.get(p) ?? []).forEach((frame, index) => {
      const parentNode = p === undefined ? undefined : nodes.get(p);
      let id = nodes.get(frame.id);
      if (id === undefined) {
        id = tree.createNode(parentNode, index).id;
        nodes.set(frame.id, id);
      } else {
        const node = tree.getNodeByID(id)!;
        if (node.parent()?.id !== parentNode || node.index() !== index) tree.move(id, parentNode, index);
      }
      const { parentFrameId: _nested, ...fields } = frame as FrameRecord & Fields;
      writeFields(tree.getNodeByID(id)!.data, fields);
      place(frame.id);
    });
  };
  place(undefined);
  // Frames the layout no longer has go last, once every frame that stays is in place: removing
  // a node removes whatever is still under it.
  const kept = new Set(frames.map((f) => f.id));
  for (const [frameId, id] of nodes) {
    if (!kept.has(frameId) && !tree.isNodeDeleted(id)) tree.delete(id);
  }
}

/** Frame id → its node, the first in reading order when a merge left two. */
function frameNodes(tree: LoroTree): Map<string, TreeID> {
  const nodes = new Map<string, TreeID>();
  const visit = (node: LoroTreeNode): void => {
    const id = node.data.get("id");
    if (typeof id === "string" && !nodes.has(id)) nodes.set(id, node.id);
    for (const child of node.children() ?? []) visit(child);
  };
  for (const root of tree.roots()) visit(root);
  return nodes;
}

/**
 * Each frame's parent, or undefined for the top level. A parent the layout does not have, or
 * one that would close a cycle, puts the frame at the top level.
 */
function parentsOf(frames: FrameRecord[]): Map<string, string | undefined> {
  const declared = new Map(frames.map((f) => [f.id, f.parentFrameId]));
  const parent = new Map<string, string | undefined>();
  for (const frame of frames) {
    let p = declared.get(frame.id);
    if (p !== undefined && !declared.has(p)) p = undefined;
    for (let q = p, steps = 0; q !== undefined && steps <= frames.length; steps++) {
      if (q === frame.id) { p = undefined; break; }
      q = parent.has(q) ? parent.get(q) : declared.get(q);
    }
    parent.set(frame.id, p);
  }
  return parent;
}

function readFrames(tree: LoroTree): FrameRecord[] {
  const frames: FrameRecord[] = [];
  const seen = new Set<string>();
  const visit = (node: LoroTreeNode, parent: string | undefined): void => {
    const fields = node.data.toJSON() as Fields;
    if (typeof fields.id !== "string" || seen.has(fields.id)) return;
    seen.add(fields.id);
    frames.push((parent === undefined ? fields : { ...fields, parentFrameId: parent }) as unknown as FrameRecord);
    for (const child of node.children() ?? []) visit(child, fields.id);
  };
  for (const root of tree.roots()) visit(root, undefined);
  return frames;
}

// ── tiles ───────────────────────────────────────────────────────────────────

function writeTiles(tiles: LoroMap, layout: Layout): void {
  const open = new Set<string>();
  for (const tile of layout.tiles) {
    open.add(tile.id);
    const { id: _key, ...fields } = tile as TileRecord & Fields;
    if (tiles.get(tile.id) !== undefined && !isMap(tiles.get(tile.id))) tiles.delete(tile.id);
    writeFields(tiles.ensureMergeableMap(tile.id), {
      ...fields,
      frame: layout.frameOf[tile.id],
      name: layout.tileNames[tile.id],
      tabs: layout.editorTabs[tile.id],
    });
  }
  for (const id of tiles.keys()) if (!open.has(id)) tiles.delete(id);
}

// ── input ───────────────────────────────────────────────────────────────────

function toLayout(value: unknown): Layout {
  if (!isObject(value)) throw new TypeError("workspace doc: a core layout is an object");
  const frames = firstOfEachId(value.frames, () => true) as unknown as FrameRecord[];
  const tiles = firstOfEachId(value.tiles, (t) => typeof t.kind === "string") as unknown as TileRecord[];
  for (const tile of tiles) {
    for (const field of PER_TILE) {
      if (field in tile) throw new TypeError(`workspace doc: a tile may not set "${field}" itself; the layout's per-tile maps fill it`);
    }
  }
  return {
    frames,
    tiles,
    tileNames: entries(value.tileNames, (v): v is string => typeof v === "string"),
    editorTabs: entries(value.editorTabs, (v): v is string[] => Array.isArray(v) && v.every((f) => typeof f === "string")),
    frameOf: entries(value.frameOf, (v): v is string => typeof v === "string"),
  };
}

function entries<T>(map: unknown, valid: (v: unknown) => v is T): Record<string, T> {
  if (!isObject(map)) return {};
  return Object.fromEntries(Object.entries(map).filter((entry): entry is [string, T] => valid(entry[1])));
}
