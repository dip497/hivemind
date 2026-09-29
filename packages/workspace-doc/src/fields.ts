/**
 * A record's fields in a Loro map. Loro records nothing for a field set to the value it already
 * has, so a write records only what changed, and two writers editing different fields of one
 * record both keep their edit. `depth` levels of nested objects become maps of their own,
 * merging per key (a view's `data.positions` merges per tile); below that a field is stored
 * whole, as JSON would keep it, and the last write wins. Keys in `keep` belong to the caller
 * (a text, a list): they are neither written nor removed here.
 */
import type { LoroMap } from "loro-crdt";

const NONE: ReadonlySet<string> = new Set();

export function writeFields(map: LoroMap, fields: Record<string, unknown>, depth = 0, keep = NONE): void {
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (depth > 0 && isPlainObject(value)) {
      // A mergeable map: two writers creating it at once share one map instead of one
      // overwriting the other. It cannot replace a plain value in place.
      const current = map.get(key);
      if (current !== undefined && !isMap(current)) map.delete(key);
      writeFields(map.ensureMergeableMap(key), value, depth - 1);
    } else {
      map.set(key, asJson(value));
    }
  }
  for (const key of map.keys()) {
    if (fields[key] === undefined && !keep.has(key)) map.delete(key);
  }
}

/**
 * Is `x` a Loro container of this kind? Told by its `kind()`, not `instanceof`: a container made
 * by another copy of loro-crdt (two packages resolving two installs) is one too, and a JSON value
 * never holds a function.
 */
export function isContainer(x: unknown, kind: "Map" | "Text" | "MovableList"): boolean {
  return typeof x === "object" && x !== null && typeof (x as { kind?: unknown }).kind === "function"
    && (x as { kind(): unknown }).kind() === kind;
}

export function isMap(x: unknown): x is LoroMap {
  return isContainer(x, "Map");
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** The value as the layout's JSON always kept it: Loro would store a nested `undefined` as null. */
function asJson(value: unknown): unknown {
  return typeof value === "object" && value !== null ? JSON.parse(JSON.stringify(value)) as unknown : value;
}
