/**
 * "Open Archipelago?" for a package whose manifest opens with a view (`startup.view`), and "Use
 * Bees as your background?" for one that offers a live wallpaper (`startup.wallpaper`), offered
 * once, wherever it was installed from: `hive plugins install` while the app runs or before it
 * started, or an update that opens with another. Settings offers them itself right after its own
 * install, and records that here, so they are never asked twice.
 *
 * The one owner of the question "which start views and wallpapers has the person not been offered
 * yet". A window asks after it loads its views, saying which it has (a view that does not load is
 * not offered), which it shows and which background it draws (one the person already has is not
 * offered, only recorded). What was offered is kept per package, every view and wallpaper it was
 * offered for, in a file of its own beside the app's data, so a relaunch does not offer it again.
 * An update, or a rollback, is offered only when it opens with one not offered before: one already
 * offered was the person's to take or leave.
 *
 * Keeping the record is best effort: a disk that refuses it (full, read-only) costs at most an
 * offer made again after a relaunch, never an install or an offer this session.
 *
 * Nothing switches the view here. The window shows the offer, and only the person's Open does.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PACKAGE_MANIFEST } from "@hivemind/hub";
import { parsePackageManifest } from "@hivemind/core/packages";
import { readInstalledPackages, versionFolder, type PackageRecord } from "@hivemind/core/installed-packages";

/** What to offer of a package, by id and name: the view it opens with, the live wallpaper it
 *  offers as the background, or both. */
export interface StartViewOffer { package: string; name: string; view: string | null; wallpaper: string | null }

/** What a window has: the views it loaded, the one it shows, and the background it draws
 *  (`appearance.wallpaper.kind`). */
export interface WindowViews { registered: readonly string[]; showing: string | null; background?: string }

/** What a package opens with: its manifest's `startup`. */
interface StartOf { view: string | null; wallpaper: string | null }

/** Offered, per package id: every view and live wallpaper it was offered for, and the version last
 *  offered. */
type Offered = Record<string, { version: string; views: string[]; wallpapers: string[] }>;

const offer = (offered: Offered, id: string, version: string, what: Partial<StartOf>): void => {
  const was = offered[id];
  const add = (list: string[] | undefined, x: string | null | undefined) => [...(list ?? []).filter((v) => v !== x), ...(x ? [x] : [])];
  offered[id] = { version, views: add(was?.views, what.view), wallpapers: add(was?.wallpapers, what.wallpaper) };
};

export class StartViewOffers {
  /** A version's start view and wallpaper (or none), by its digest: an installed version's files never change. */
  private readonly starts = new Map<string, StartOf>();
  private offered: Offered | null = null;
  /** One ask at a time, so two windows asking together cannot both be offered the same view. */
  private queue: Promise<unknown> = Promise.resolve();

  /** `file`: where what was offered is kept. */
  constructor(private readonly file: string) {}

  /** The start views and wallpapers to offer this window now, each recorded as offered. */
  next(window: WindowViews): Promise<StartViewOffer[]> {
    return this.serial(async () => {
      const offered = await this.load();
      const out: StartViewOffer[] = [];
      let changed = false;
      for (const r of await readInstalledPackages()) {
        // Off, its views and wallpapers do not load: it is offered once it is on.
        if (!r.on) continue;
        const start = await this.startOf(r);
        const view = start.view && !offered[r.id]?.views.includes(start.view) && window.registered.includes(start.view) ? start.view : null;
        const wallpaper = start.wallpaper && !offered[r.id]?.wallpapers.includes(start.wallpaper) ? start.wallpaper : null;
        if (!view && !wallpaper) continue;
        offer(offered, r.id, r.version, { view, wallpaper });
        changed = true;
        // Already there: nothing to offer, and nothing to ask later.
        const offers = { view: view !== window.showing ? view : null, wallpaper: wallpaper !== window.background ? wallpaper : null };
        if (offers.view || offers.wallpaper) out.push({ package: r.id, name: r.name, ...offers });
      }
      if (changed) await this.save(offered);
      return out;
    });
  }

  /** Settings offered package `id`'s start view and wallpaper itself, right after installing it. */
  offeredInSettings(id: string, version: string, start: Partial<StartOf>): Promise<void> {
    return this.serial(async () => {
      const offered = await this.load();
      const was = offered[id];
      if (was?.version === version && (!start.view || was.views.includes(start.view)) && (!start.wallpaper || was.wallpapers.includes(start.wallpaper))) return;
      offer(offered, id, version, start);
      await this.save(offered);
    });
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  private async startOf(r: PackageRecord): Promise<StartOf> {
    const known = this.starts.get(r.digest);
    if (known !== undefined) return known;
    // A plugin installed on its own has no package manifest, and opens with nothing.
    const raw = await readFile(path.join(versionFolder(r.id, r), PACKAGE_MANIFEST), "utf8").catch(() => null);
    let start: StartOf = { view: null, wallpaper: null };
    try {
      const s = raw === null ? undefined : parsePackageManifest(JSON.parse(raw)).startup;
      start = { view: s?.view ?? null, wallpaper: s?.wallpaper ?? null };
    } catch { /* opens with nothing */ }
    this.starts.set(r.digest, start);
    return start;
  }

  private async load(): Promise<Offered> {
    if (this.offered) return this.offered;
    const raw = await readFile(this.file, "utf8").catch(() => null);
    let read: Offered = {};
    try {
      const v = raw === null ? null : JSON.parse(raw) as { offered?: unknown };
      const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
      if (v && typeof v.offered === "object" && v.offered) {
        // `wallpapers` is newer than the file: a record without it offered none.
        for (const [id, o] of Object.entries(v.offered as Record<string, { version?: unknown; views?: unknown; wallpapers?: unknown }>)) {
          if (typeof o?.version === "string" && Array.isArray(o.views)) read[id] = { version: o.version, views: strings(o.views), wallpapers: strings(o.wallpapers) };
        }
      }
    } catch { /* unreadable: start again; at worst a view is offered once more */ }
    return (this.offered = read);
  }

  /** What is kept in memory is what was offered this session, saved or not. */
  private async save(offered: Offered): Promise<void> {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(tmp, `${JSON.stringify({ v: 1, offered }, null, 2)}\n`);
      await rename(tmp, this.file);
    } catch (e) {
      console.warn(`[start-view] could not keep what was offered in ${this.file}; a relaunch may offer it again:`, e);
      await rm(tmp, { force: true }).catch(() => {});
    }
  }
}
