/**
 * Widget packages on this machine: `<config>/hivemind/widgets/<id>/`, beside the views, each a
 * `widget.json` ({ id?, name, version?, description?, icon?, options?, chrome?, permissions?, placement?, size?, draw? }),
 * the `widget.js` a window runs in a worker, and the images it draws. A folder that cannot be read
 * is skipped. One from HiveHub says its `@owner/name` id in its widget.json and lives in
 * `owner--name`. The app and the CLI read, add and remove them here.
 */
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseSettingFields } from "@hivemind/view-sdk/settings";
import { VIEW_PERMISSIONS } from "@hivemind/view-sdk/protocol";
import { parseCategory } from "@hivemind/view-sdk/category";
import { BUILTIN_WIDGETS, isWidgetId, widgetFolder, type WidgetPackage } from "./widget-format.js";

export function userWidgetsDir(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  return path.join(base, "hivemind", "widgets");
}

/** The package in `dir`, read and checked, or why it is not one. Its id is the `@owner/name` its
 *  widget.json says when it lives in that id's folder, else its folder's name. */
export async function readWidget(dir: string, given?: string): Promise<WidgetPackage> {
  let meta: { id?: unknown; name?: unknown; version?: unknown; description?: unknown; icon?: unknown; category?: unknown; options?: unknown; chrome?: unknown; permissions?: unknown; placement?: unknown; size?: unknown; draw?: unknown };
  try { meta = JSON.parse(await readFile(path.join(dir, "widget.json"), "utf8")) as typeof meta; } catch { throw new Error("no readable widget.json in that folder"); }
  let code = "";
  try { code = await readFile(path.join(dir, "widget.js"), "utf8"); } catch {
    // A widget drawn from its `draw` alone needs no code.
    if (meta.draw === undefined) throw new Error("no widget.js in that folder, and no draw in its widget.json");
  }
  const scoped = typeof meta.id === "string" && meta.id.startsWith("@") && isWidgetId(meta.id) ? meta.id : null;
  const id = given ?? (scoped && widgetFolder(scoped) === path.basename(dir) ? scoped : path.basename(dir));
  const assets = await imagesIn(dir);
  const cat = parseCategory(meta.category);
  if ("error" in cat) throw new Error(cat.error);
  return {
    category: cat.category,
    id, name: typeof meta.name === "string" && meta.name.trim() ? meta.name.trim().slice(0, 60) : id,
    options: parseSettingFields(meta.options), chrome: meta.chrome === "none" ? "none" : "card",
    permissions: Array.isArray(meta.permissions) ? [...new Set(meta.permissions.filter((p): p is string => (VIEW_PERMISSIONS as readonly unknown[]).includes(p)))] : [],
    assets, code,
    placement: meta.placement === "board" ? "board" : "screen", size: sizeOf(meta.size),
    ...(meta.draw !== undefined ? { draw: meta.draw } : {}),
    ...(typeof meta.description === "string" ? { description: meta.description.slice(0, 200) } : {}),
    ...(typeof meta.version === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(meta.version) ? { version: meta.version } : {}),
    ...(typeof meta.icon === "string" && Object.hasOwn(assets, meta.icon) ? { icon: assets[meta.icon]! } : {}),
    dir,
  };
}

/** A widget's first size on the board, as its widget.json gives it, kept within reason. */
function sizeOf(raw: unknown): { w: number; h: number } {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as { w?: unknown; h?: unknown };
  const n = (v: unknown, d: number) => (typeof v === "number" && v >= 60 && v <= 1600 ? v : d);
  return { w: n(r.w, 220), h: n(r.h, 160) };
}

const IMAGE = { ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml" } as const;
/** The most one widget image may take, and all of a widget's together. */
const IMAGE_BYTES = 1_000_000;
const IMAGES_BYTES = 4_000_000;

/** The images in a widget's folder (not below it), as data URLs by file name. Too big ones are left out. */
async function imagesIn(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let total = 0;
  for (const name of (await readdir(dir).catch(() => [] as string[])).sort()) {
    const type = IMAGE[path.extname(name).toLowerCase() as keyof typeof IMAGE];
    if (!type) continue;
    const size = (await stat(path.join(dir, name)).catch(() => null))?.size ?? Infinity;
    if (size > IMAGE_BYTES || total + size > IMAGES_BYTES) continue;
    total += size;
    out[name] = `data:${type};base64,${(await readFile(path.join(dir, name))).toString("base64")}`;
  }
  return out;
}

/** An image of the installed widget `widget`, as a data URL, or null. */
export async function widgetAsset(widget: string, name: string): Promise<string | null> {
  if (!isWidgetId(widget) || name.includes("/") || name.includes("\\") || name.startsWith(".")) return null;
  try { return (await readWidget(path.join(userWidgetsDir(), widgetFolder(widget)), widget)).assets[name] ?? null; } catch { return null; }
}

export async function listWidgets(dir = userWidgetsDir()): Promise<WidgetPackage[]> {
  const folders = (await readdir(dir).catch(() => [] as string[])).filter((f) => !f.startsWith("."));
  const found = (await Promise.all(folders.sort().map((f) => readWidget(path.join(dir, f)).catch(() => null))))
    .filter((w): w is WidgetPackage => w !== null);
  const mine = new Set(found.map((w) => w.id));
  return [...BUILTIN_WIDGETS.filter((b) => !mine.has(b.id)), ...found];
}

/**
 * Copy the widget in `src` into the widgets folder, replacing one with the same id, and return it.
 * Its id is `id` (a HiveHub listing, which its widget.json must name too), else the `@owner/name`
 * its widget.json says, else its folder's name made safe. It is checked before anything is
 * replaced, and copied whole before it takes the old one's place.
 */
export async function installWidget(src: string, id?: string, dir = userWidgetsDir()): Promise<WidgetPackage> {
  const read = await readWidget(src, id ?? "candidate");
  const meta = JSON.parse(await readFile(path.join(src, "widget.json"), "utf8")) as { id?: unknown };
  if (id && meta.id !== id) throw new Error(`its widget.json says it is ${JSON.stringify(meta.id ?? null)}, not ${id}`);
  const want = id ?? (typeof meta.id === "string" && meta.id.startsWith("@") && isWidgetId(meta.id)
    ? meta.id : path.basename(path.resolve(src)).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 60) || "widget");
  if (!isWidgetId(want)) throw new Error(`${want} is not a widget id`);
  await mkdir(dir, { recursive: true });
  const staging = await mkdtemp(path.join(dir, ".install-"));
  const dest = path.join(dir, widgetFolder(want));
  try {
    await cp(src, path.join(staging, "next"), { recursive: true });
    await rm(dest, { recursive: true, force: true });
    await rename(path.join(staging, "next"), dest);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return { ...read, id: want, dir: dest };
}

/** Remove an installed widget. A built-in cannot be; one installed in its place can, which
 *  brings the built-in back. */
export async function removeWidget(id: string, dir = userWidgetsDir()): Promise<void> {
  if (!isWidgetId(id)) throw new Error(`${id} is not a widget id`);
  const at = path.join(dir, widgetFolder(id));
  if (!(await stat(at).catch(() => null))) {
    throw new Error(BUILTIN_WIDGETS.some((b) => b.id === id) ? "it comes with the app" : `no widget ${id} is installed`);
  }
  await rm(at, { recursive: true, force: true });
}
