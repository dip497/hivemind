/**
 * Board objects in a workspace document (docs/design/multiplayer-2026-09-28.md §4.2 G, §8):
 * sticky notes, checklists, text labels and arrows, in `objects` by id. The window sends the
 * whole board; `writeObjects` turns it into the edits that make the document hold it. A field
 * is set only when it changed. Text is a Loro text updated by a diff, so two people typing in
 * one note both keep their characters. A checklist keeps each item as a record by id, plus
 * their order, so a reorder is a move and an item's tick and text merge on their own.
 *
 * An object's record, and an item's, is made fresh when it first appears, never as a mergeable
 * container: its id is its creator's own, so nobody else makes it at once, and Loro's redo of a
 * record taken back by undo wrote a mergeable record's text into it a second time.
 */
import type { LoroDoc, LoroMap } from "loro-crdt";
import { isContainer, isMap, writeFields } from "./fields.js";
import { firstOfEachId, isObject, type Fields } from "./input.js";
import { readOrder, writeOrder } from "./order.js";
import { rebaseBoard } from "./rebase.js";
import { OBJECTS, stampSchema } from "./schema.js";
import { BOARD_OBJECT_KINDS, SIDES, type BoardObject, type ChecklistItem } from "./shapes.js";

const TEXT = "text";
const LABEL = "label";
const ITEMS = "items";
const ITEM_ORDER = "itemOrder";
/** Keys of a record that hold containers this module writes itself. */
const CONTAINERS: ReadonlySet<string> = new Set([TEXT, LABEL, ITEMS, ITEM_ORDER]);
const ITEM_CONTAINERS: ReadonlySet<string> = new Set([TEXT]);

/**
 * Make `doc` hold the board `value`. An object or checklist item without what its kind needs is
 * dropped, and a repeated id keeps its first entry; a board that is not a list is refused. Given
 * `base`, the board `value` was made from (null: none was read), only what changed from it is
 * written, object by object and field by field, and the rest stays as `doc` has it now.
 */
export function writeObjects(doc: LoroDoc, value: unknown, base?: unknown): void {
  const next = toBoard(value);
  const board = base === undefined ? next : rebaseBoard(base === null ? [] : toBoard(base), next, readObjects(doc));
  stampSchema(doc);
  const objects = doc.getMap(OBJECTS);
  const kept = new Set<string>();
  for (const object of board) {
    kept.add(object.id);
    const current = objects.get(object.id);
    writeObject(isMap(current) ? current : objects.setContainer(object.id, newMap(objects)), object);
  }
  for (const id of objects.keys()) if (!kept.has(id)) objects.delete(id);
}

/** The board's objects that have what their kind needs, the first of each id. */
function toBoard(value: unknown): BoardObject[] {
  if (!Array.isArray(value)) throw new TypeError("workspace doc: a board is a list of objects");
  const seen = new Set<string>();
  const board: BoardObject[] = [];
  for (const entry of value) {
    const object = toBoardObject(entry);
    if (object === null || seen.has(object.id)) continue;
    seen.add(object.id);
    board.push(object);
  }
  return board;
}

/** The board in `doc`, in id order. A record a merge left without what its kind needs is skipped. */
export function readObjects(doc: LoroDoc): BoardObject[] {
  const records = doc.getMap(OBJECTS).toJSON() as Fields;
  const board: BoardObject[] = [];
  for (const id of Object.keys(records).sort()) {
    const record = records[id];
    if (!isObject(record)) continue;
    const { [ITEMS]: items, [ITEM_ORDER]: order, ...fields } = record;
    const object = toBoardObject(isObject(items) ? { ...fields, id, items: readItems(items, order) } : { ...fields, id });
    if (object !== null) board.push(object);
  }
  return board;
}

function writeObject(record: LoroMap, object: BoardObject): void {
  const { id: _key, text, label, items, ...fields } = object as unknown as Fields & { text?: string; label?: string; items?: ChecklistItem[] };
  writeFields(record, fields, 0, CONTAINERS);
  writeText(record, TEXT, text);
  writeText(record, LABEL, label);
  writeItems(record, items);
}

/** Make `record[key]` a text holding `value`, or remove it when there is none. */
function writeText(record: LoroMap, key: string, value: string | undefined): void {
  const current = record.get(key);
  if (current !== undefined && (value === undefined || !isContainer(current, "Text"))) record.delete(key);
  if (value !== undefined) record.ensureMergeableText(key).update(value);
}

/** Make `record` hold a checklist's `items`: each one's record by id, and their order. */
function writeItems(record: LoroMap, items: ChecklistItem[] | undefined): void {
  if (items === undefined) {
    for (const key of [ITEMS, ITEM_ORDER]) if (record.get(key) !== undefined) record.delete(key);
    return;
  }
  if (record.get(ITEMS) !== undefined && !isMap(record.get(ITEMS))) record.delete(ITEMS);
  if (record.get(ITEM_ORDER) !== undefined && !isContainer(record.get(ITEM_ORDER), "MovableList")) record.delete(ITEM_ORDER);
  const entries = record.ensureMergeableMap(ITEMS);
  for (const item of items) {
    const current = entries.get(item.id);
    const entry = isMap(current) ? current : entries.setContainer(item.id, newMap(entries));
    writeFields(entry, { done: item.done }, 0, ITEM_CONTAINERS);
    writeText(entry, TEXT, item.text);
  }
  const listed = new Set(items.map((item) => item.id));
  for (const id of entries.keys()) if (!listed.has(id)) entries.delete(id);
  writeOrder(record.ensureMergeableMovableList(ITEM_ORDER), items.map((item) => item.id));
}

/**
 * A new map made with the classes of `like`'s own copy of loro-crdt: a container made by another
 * copy (two packages resolving two installs) does not fit into the document.
 */
function newMap(like: LoroMap): LoroMap {
  return new (like.constructor as new () => LoroMap)();
}

/** A checklist's item records in order, as the window lists them; checked by `toBoardObject`. */
function readItems(entries: Fields, order: unknown): unknown[] {
  return readOrder(Array.isArray(order) ? order : [], Object.keys(entries))
    .map((id) => (isObject(entries[id]) ? { ...entries[id], id } : null));
}

// ── input ───────────────────────────────────────────────────────────────────

/**
 * `x` as a board object with the fields its kind needs, or null. Fields the document does not
 * read are kept, so a newer version's additions survive an older one's writes.
 */
function toBoardObject(x: unknown): BoardObject | null {
  if (!isObject(x) || typeof x.id !== "string" || x.id.length === 0) return null;
  if (!(BOARD_OBJECT_KINDS as readonly unknown[]).includes(x.kind)) return null;
  if ((x.frame !== undefined && typeof x.frame !== "string") || (x.z !== undefined && !isNumber(x.z))) return null;
  if (x.color !== undefined && typeof x.color !== "string") return null;
  const { text, label, items, [ITEM_ORDER]: _order, ...fields } = x;
  if (x.kind === "arrow") {
    return isArrowEnd(x.from) && isArrowEnd(x.to) && typeof label === "string" ? ({ ...fields, label } as BoardObject) : null;
  }
  if (![x.x, x.y, x.w, x.h].every(isNumber) || typeof text !== "string") return null;
  if (x.kind !== "checklist") return { ...fields, text } as BoardObject;
  if (!Array.isArray(items)) return null;
  const kept = firstOfEachId(items, (item) => typeof item.text === "string" && typeof item.done === "boolean");
  return { ...fields, text, items: kept.map(({ id, text: line, done }) => ({ id, text: line, done })) } as BoardObject;
}

function isArrowEnd(x: unknown): boolean {
  return isObject(x) && typeof x.id === "string" && x.id.length > 0 && (SIDES as readonly unknown[]).includes(x.side);
}

function isNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}
