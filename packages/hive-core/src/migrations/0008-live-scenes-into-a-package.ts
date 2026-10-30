/**
 * Shoal, Koi Pond, Jellyfish and Fireflies were wallpapers built into the app (`shoal`, `koi`,
 * `jellyfish`, `fireflies`). They moved into a package, Live scenes, whose wallpapers are
 * `@dip497/live-scenes/<the same name>`, so they change without a release of the app. A
 * settings.json that names one, as the wallpaper (`appearance.wallpaper.kind`) or as the one a
 * Clean preset put aside (`appearance.lookBefore.wallpaper`), names the package's instead. This
 * build does not know the old names: it would read them as the default wallpaper and write that
 * back on the next save.
 *
 * It installs nothing: until the person gets the package, Settings says the wallpaper is missing and
 * where to get it, and the canvas shows the default. Only those two values change; every other
 * value in the file, a newer build's too, stays. Run again after being cut off, it finds the new
 * names and does nothing.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { settingsPath, withLock } from "../settings.js";
import type { Migration } from "./runner.js";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

const MOVED: Record<string, string> = {
  shoal: "@dip497/live-scenes/shoal",
  koi: "@dip497/live-scenes/koi",
  jellyfish: "@dip497/live-scenes/jellyfish",
  fireflies: "@dip497/live-scenes/fireflies",
};
const moved = (v: unknown): string | null => (typeof v === "string" && Object.hasOwn(MOVED, v) ? MOVED[v]! : null);

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(file, "utf8"));
    return isObj(raw) ? raw : null;
  } catch { return null; }
}

/** The places in a settings.json that name a wallpaper, each with its new name, or none. */
function renames(raw: Record<string, unknown> | null): Array<{ holder: Record<string, unknown>; key: string; to: string }> {
  const a = raw?.appearance;
  if (!isObj(a)) return [];
  const out: Array<{ holder: Record<string, unknown>; key: string; to: string }> = [];
  if (isObj(a.wallpaper)) {
    const to = moved(a.wallpaper.kind);
    if (to) out.push({ holder: a.wallpaper, key: "kind", to });
  }
  if (isObj(a.lookBefore)) {
    const to = moved(a.lookBefore.wallpaper);
    if (to) out.push({ holder: a.lookBefore, key: "wallpaper", to });
  }
  return out;
}

export const m0008: Migration = {
  id: "0008-live-scenes-into-a-package",
  root: "config",
  backsUp: ["settings.json"],
  movesFilesAnOlderAppReads: false,
  async changesHere() {
    return renames(await readJson(settingsPath())).length > 0;
  },
  async run() {
    const file = settingsPath();
    return withLock(file, async () => {
      const raw = await readJson(file);
      const found = renames(raw);
      if (!found.length) return { renamed: [] };
      for (const r of found) r.holder[r.key] = r.to;
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify(raw, null, 2) + "\n", "utf8");
      await rename(tmp, file);
      return { renamed: found.map((r) => r.to) };
    });
  },
};
