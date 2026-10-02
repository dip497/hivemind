/** A field of a JSON record, as a manifest names it: `a.b.c` through plain objects. A missing
 *  link is undefined, never a throw. */
export function valueAt(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}
