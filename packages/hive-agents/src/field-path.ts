/** A field of a JSON record, as a manifest names it: `a.b.c` through plain objects, by their own
 *  fields only. A missing link is undefined, never a throw. */
export function valueAt(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (typeof cur !== "object" || cur === null || !Object.hasOwn(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Sets the field `path` names in `obj`, making the plain objects on the way. Every field it writes
 *  is the record's own, whatever its name, so a path never reaches what all objects share. */
export function setValueAt(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let cur = obj;
  for (const key of keys.slice(0, -1)) {
    const next = Object.hasOwn(cur, key) ? cur[key] : undefined;
    if (typeof next === "object" && next !== null) cur = next as Record<string, unknown>;
    else cur = own(cur, key, {}) as Record<string, unknown>;
  }
  own(cur, keys.at(-1)!, value);
}

function own(obj: Record<string, unknown>, key: string, value: unknown): unknown {
  Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
  return value;
}
