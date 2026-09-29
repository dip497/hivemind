/** Checking what comes from outside, a record at a time. */

export type Fields = Record<string, unknown>;

export function isObject(x: unknown): x is Fields {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** The list's records with a non-empty string id that pass `keep`, the first of each id. */
export function firstOfEachId(list: unknown, keep: (record: Fields) => boolean): Fields[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  return list.filter((r): r is Fields => {
    if (!isObject(r) || typeof r.id !== "string" || r.id.length === 0 || seen.has(r.id) || !keep(r)) return false;
    seen.add(r.id);
    return true;
  });
}
