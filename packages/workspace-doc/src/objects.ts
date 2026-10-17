/**
 * Board objects in a workspace document (docs/design/multiplayer-2026-09-28.md §4.2 G, §8):
 * sticky notes, checklists, text labels and arrows, in `objects` by id. A writer sends the objects
 * it changed, each with the one it changed (`BoardEdit`); `editObjects` writes only those, each
 * merged with what others changed in it since, so an edit costs what it changed whatever the
 * board's size. A field is set only when it changed. Text is a Loro text updated by a diff, so two people typing in
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
import { rebaseObject, sameJson } from "./rebase.js";
import { OBJECTS, stampSchema } from "./schema.js";
import { BOARD_OBJECT_KINDS, SIDES, WIDGET_FIELD_BYTES, type BoardEdit, type BoardObject, type ChecklistItem } from "./shapes.js";

const TEXT = "text";
const LABEL = "label";
const ITEMS = "items";
const ITEM_ORDER = "itemOrder";
/** Keys of a record that hold containers this module writes itself. */
const CONTAINERS: ReadonlySet<string> = new Set([TEXT, LABEL, ITEMS, ITEM_ORDER]);
const ITEM_CONTAINERS: ReadonlySet<string> = new Set([TEXT]);

/**
 * Write `edit` into `doc`: each object it changed, merged with what others changed in it since the
 * one it was made from, or taken away. An object without what its kind needs, or under an id that
 * is not its own, is dropped; what is not an edit is refused. `current` holds the objects as `doc`
 * has them, for those the caller has read. The objects as written (null: not there), by id.
 */
export function editObjects(doc: LoroDoc, edit: unknown, current: Readonly<Record<string, BoardObject | null>> = {}): Record<string, BoardObject | null> {
  const { objects: changed, base } = checkedEdit(edit);
  stampSchema(doc);
  const objects = doc.getMap(OBJECTS);
  const written: Record<string, BoardObject | null> = {};
  for (const [id, mine] of Object.entries(changed)) {
    const now = id in current ? current[id]! : readObject(doc, id);
    const object = id in base ? rebaseObject(base[id]!, mine, now) : mine;
    written[id] = object;
    // Writing every object made each edit cost the whole board.
    if (sameJson(now ?? undefined, object ?? undefined)) continue;
    if (object === null) {
      objects.delete(id);
      continue;
    }
    const record = objects.get(id);
    writeObject(isMap(record) ? record : objects.setContainer(id, newMap(objects)), object);
  }
  return written;
}

/** `value` as an edit: its objects that have what their kind needs, each under its own id, and the
 *  base of each of those that has one. What is not an edit is refused (a TypeError). */
export function checkedEdit(value: unknown): Required<BoardEdit> {
  if (!isObject(value) || !isObject(value.objects) || (value.base !== undefined && !isObject(value.base))) throw new TypeError("workspace doc: a board edit is { objects, base? }");
  const own = (id: string, raw: unknown): BoardObject | null | undefined => {
    if (raw === null) return null;
    const object = toBoardObject(raw);
    return object?.id === id ? object : undefined;
  };
  const objects: Record<string, BoardObject | null> = {};
  for (const [id, raw] of Object.entries(value.objects)) {
    const object = own(id, raw);
    if (object !== undefined) objects[id] = object;
  }
  const base: Record<string, BoardObject | null> = {};
  for (const [id, raw] of Object.entries((value.base ?? {}) as Fields)) {
    const object = own(id, raw);
    if (object !== undefined && id in objects) base[id] = object;
  }
  return { objects, base };
}

/** The board in `doc`, in id order. A record a merge left without what its kind needs is skipped. */
export function readObjects(doc: LoroDoc): BoardObject[] {
  const records = doc.getMap(OBJECTS).toJSON() as Fields;
  const board: BoardObject[] = [];
  for (const id of Object.keys(records).sort()) {
    const object = objectOf(id, records[id]);
    if (object !== null) board.push(object);
  }
  return board;
}

/** The objects of `doc` with these ids, by id (null: not there). */
export function readObjectsWithIds(doc: LoroDoc, ids: readonly string[]): Record<string, BoardObject | null> {
  return Object.fromEntries(ids.map((id) => [id, readObject(doc, id)]));
}

function readObject(doc: LoroDoc, id: string): BoardObject | null {
  const record = doc.getMap(OBJECTS).get(id);
  return isMap(record) ? objectOf(id, record.toJSON()) : null;
}

function objectOf(id: string, record: unknown): BoardObject | null {
  if (!isObject(record)) return null;
  const { [ITEMS]: items, [ITEM_ORDER]: order, ...fields } = record;
  return toBoardObject(isObject(items) ? { ...fields, id, items: readItems(items, order) } : { ...fields, id });
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
function toBoardObject(raw: unknown): BoardObject | null {
  const x = asWidget(raw);
  if (!isObject(x) || typeof x.id !== "string" || x.id.length === 0) return null;
  if (!(BOARD_OBJECT_KINDS as readonly unknown[]).includes(x.kind)) return null;
  if ((x.frame !== undefined && typeof x.frame !== "string") || (x.z !== undefined && !isNumber(x.z))) return null;
  if (x.color !== undefined && typeof x.color !== "string") return null;
  const { text, label, items, [ITEM_ORDER]: _order, ...fields } = x;
  if (x.kind === "arrow") {
    return isArrowEnd(x.from) && isArrowEnd(x.to) && typeof label === "string" ? ({ ...fields, label } as BoardObject) : null;
  }
  if (x.kind === "widget") {
    if (typeof x.widget !== "string" || x.widget.length === 0) return null;
    if (x.placement !== undefined && x.placement !== "board" && x.placement !== "screen") return null;
    // On the board it has a box, as a note does.
    if (x.placement === "board" && ![x.x, x.y, x.w, x.h].every(isNumber)) return null;
    if (text !== undefined && typeof text !== "string") return null;
    // Too big a state is dropped, not the widget.
    if (fields.state !== undefined && !fits(fields.state)) delete fields.state;
    if (fields.options !== undefined && (!isObject(fields.options) || !fits(fields.options))) delete fields.options;
    const lines = Array.isArray(items)
      ? firstOfEachId(items, (item) => typeof item.text === "string" && typeof item.done === "boolean").map(({ id, text: line, done }) => ({ id, text: line, done }))
      : undefined;
    return { ...fields, ...(text !== undefined ? { text } : {}), ...(lines ? { items: lines } : {}) } as unknown as BoardObject;
  }
  if (![x.x, x.y, x.w, x.h].every(isNumber) || typeof text !== "string") return null;
  if (x.kind !== "checklist") return { ...fields, text } as BoardObject;
  if (!Array.isArray(items)) return null;
  const kept = firstOfEachId(items, (item) => typeof item.text === "string" && typeof item.done === "boolean");
  return { ...fields, text, items: kept.map(({ id, text: line, done }) => ({ id, text: line, done })) } as BoardObject;
}

/**
 * A note, a checklist or a text label, as the widget it is now: the app's built-in `note`,
 * `checklist` or `text` widget on the board, with the same id (so arrows still meet it), box,
 * frame, writing and lines; a note's colour is its widget's colour option. Anything else as given.
 */
function asWidget(x: unknown): unknown {
  if (!isObject(x) || (x.kind !== "note" && x.kind !== "checklist" && x.kind !== "text")) return x;
  const { kind, color, ...rest } = x;
  return {
    ...rest, kind: "widget", widget: kind, placement: "board",
    ...(kind === "note" ? { options: { color: typeof color === "string" ? color : "yellow" } } : {}),
  };
}

function fits(value: unknown): boolean {
  try { return JSON.stringify(value).length <= WIDGET_FIELD_BYTES; } catch { return false; }
}

function isArrowEnd(x: unknown): boolean {
  return isObject(x) && typeof x.id === "string" && x.id.length > 0 && (SIDES as readonly unknown[]).includes(x.side);
}

function isNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}
