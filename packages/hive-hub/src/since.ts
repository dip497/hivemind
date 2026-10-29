/** The Hivemind release that first accepts each manifest field or member kind. An older app
 *  refuses a whole manifest that holds a field it does not know (`validateViewManifest` refuses
 *  unknown fields; a package manifest is a strict object), so a hub lists a plugin that uses one
 *  with the highest of these as its `minAppVersion`, and the app says "needs Hivemind X or newer"
 *  before it downloads anything.
 *
 *  One entry per field. A field ships in the release after the last one out: when a release goes
 *  out before an entry's, move the entry to the next one. */
import { appMeetsMinVersion } from "@hivemind/agents";

export const SINCE = {
  /** A view's `widgets` edge, where the app docks the person's widgets beside it. */
  "view.widgets": "2026.10.6",
  /** A view's own colours (view protocol 1.16). */
  "view.tokens": "2026.10.6",
  /** A view that fetches its own files (`"files": true`, view protocol 1.17, feature `ownFiles`). */
  "view.files": "2026.10.6",
  /** A package's `themes` member. */
  "package.themes": "2026.10.6",
  /** A package's `wallpapers` member (live wallpaper protocol 1), and its `startup.wallpaper`. */
  "package.wallpapers": "2026.10.8",
} as const satisfies Record<string, string>;

export type SinceKey = keyof typeof SINCE;
/** What a manifest is: the part of a `SINCE` key before its dot. */
export type Kind = "view" | "widget" | "package";

/** The fields of `raw` that one of `kind`'s entries names. */
const used = (kind: Kind, raw: unknown): SinceKey[] => {
  if (!raw || typeof raw !== "object") return [];
  return (Object.keys(SINCE) as SinceKey[]).filter((k) => {
    const [of, field] = k.split(".") as [string, string];
    if (of !== kind) return false;
    // Present at all, even as an empty list: an app that does not know the field refuses its name.
    return (raw as Record<string, unknown>)[field] !== undefined;
  });
};

/** The later of two versions, either of which may be absent. */
export const laterOf = (a: string | null, b: string | null): string | null =>
  !a ? b : !b ? a : appMeetsMinVersion(a, b) ? a : b;

/** The oldest app that accepts this view's, widget's or package's manifest as written: the highest entry
 *  of `SINCE` it uses, or null when it uses none. */
export function sinceOf(kind: Kind, raw: unknown): string | null {
  return used(kind, raw).reduce<string | null>((v, k) => laterOf(v, SINCE[k]), null);
}
