/**
 * What a write by this build does to settings.json: it applies only what it changed onto the
 * file's own JSON. Normalising (`mergeSettings`) happens on read only, so whatever this build does
 * not read stays as the file has it:
 *
 *   - a key a newer build added, at the top (`appearanceExtra`, `notifications`), in a section or
 *     in any group inside one (`appearance.glass`, `views.layers`, a view's `views.chrome` entry);
 *   - a value this build does not know, such as a newer preset's or accent's id: it reads as the
 *     default here, and stays in the file until someone here sets that very setting;
 *   - the file's format version `v`, which a write never lowers.
 *
 * Two kinds of change are applied, in this order:
 *
 *   1. What differs between the settings as read (`cur`) and as the writer left them (`next`),
 *      both normalised: each value that changed is set, and each key `cur` had and `next` has not
 *      is removed. Only keys this build reads can be removed this way.
 *   2. Each `touched` path, the writer's own words (a `hive config set`, a patch from the app): its
 *      value in `next` is set even when it equals `cur`'s, since `cur` may be a default standing in
 *      for a value this build could not read; undefined removes the key from the file.
 *
 * Setting an object sets each of its values and keeps the file's other keys beside them, so a
 * group written whole (a theme import's `appearance`) keeps what a newer build put in it.
 */
import { SETTINGS_VERSION, getPath, settingsVersionOf, type Settings } from "./settings-schema.js";

/** A path the writer names: its value set (an object onto the file's, keeping keys beside it),
 *  or `{ replace }`: the file's value removed first, so no key a newer build put inside stays. */
export type Touched = string | { replace: string };

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const BANNED = new Set(["__proto__", "constructor", "prototype"]);

type Op = { path: string[]; value: unknown } | { path: string[]; remove: true };

/** The file's JSON once `next` is written over it; `raw` is what the file held (anything; not
 *  changed), `cur` how this build read it. */
export function writtenOnto(raw: unknown, cur: Settings, next: Settings, touched: readonly Touched[] = []): Json {
  // A missing or broken file starts from the settings as read, whole, as every build wrote it.
  const out: Json = clone(isObj(raw) ? raw : (cur as unknown as Json));
  const ops: Op[] = [];
  const { v: _cv, ...curRest } = cur;
  const { v: _nv, ...nextRest } = next;
  diff(curRest, nextRest, [], ops);
  for (const t of touched) {
    const p = typeof t === "string" ? t : t.replace;
    const path = p.split(".").filter(Boolean);
    if (path.length === 0 || path[0] === "v") continue;
    const value = getPath(next, p);
    if (typeof t !== "string") ops.push({ path, remove: true });
    ops.push(value === undefined ? { path, remove: true } : { path, value });
  }
  for (const op of ops) apply(out, op);
  // Never lowered: a newer build's file stays that build's to read.
  out.v = Math.max(settingsVersionOf(raw), SETTINGS_VERSION);
  return out;
}

function diff(a: unknown, b: unknown, at: string[], ops: Op[]): void {
  if (isObj(a) && isObj(b)) {
    for (const k of Object.keys(a)) if (a[k] !== undefined && b[k] === undefined) ops.push({ path: [...at, k], remove: true });
    for (const k of Object.keys(b)) if (b[k] !== undefined) diff(a[k], b[k], [...at, k], ops);
    return;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) ops.push({ path: at, value: b });
}

function apply(root: Json, op: Op): void {
  if (op.path.some((k) => BANNED.has(k))) return;
  let o = root;
  for (const k of op.path.slice(0, -1)) {
    if (!isObj(o[k])) {
      if ("remove" in op) return; // nothing there to remove
      o[k] = {};
    }
    o = o[k] as Json;
  }
  const last = op.path.at(-1)!;
  if ("remove" in op) delete o[last];
  else assign(o, last, op.value);
}

/** Set `value` at `o[k]`; an object is set value by value, keeping the keys `o[k]` has beside them. */
function assign(o: Json, k: string, value: unknown): void {
  if (!isObj(value)) { o[k] = clone(value); return; }
  if (!isObj(o[k])) o[k] = {};
  const into = o[k] as Json;
  for (const [key, v] of Object.entries(value)) if (v !== undefined && !BANNED.has(key)) assign(into, key, v);
}

/** A copy as JSON has it: undefined dropped, nothing shared with the caller's object. */
function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}
