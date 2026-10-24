/**
 * "Open Archipelago?" for a package whose manifest opens with a view (`startup.view`), offered once,
 * wherever it was installed from: `hive plugins install` while the app runs or before it started,
 * or an update that opens with another view. Settings offers it itself right after its own install,
 * and records that here, so it is never asked twice.
 *
 * The one owner of the question "which start views has the person not been offered yet". A window
 * asks after it loads its views, saying which it has (a view that does not load is not offered) and
 * which it shows (one the person is already on is not offered, only recorded). What was offered is
 * kept per package, with its version and view, in a file of its own beside the app's data, so a
 * relaunch does not offer it again. An update is offered again only when it opens with another
 * view: the same view, newer, was already the person's to take or leave.
 *
 * Nothing switches the view here. The window shows the offer, and only the person's Open does.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { PACKAGE_MANIFEST } from "@hivemind/hub";
import { parsePackageManifest } from "@hivemind/core/packages";
import { readInstalledPackages, versionFolder, type PackageRecord } from "@hivemind/core/installed-packages";

/** A start view to offer: the package, by id and name, and the view it opens with. */
export interface StartViewOffer { package: string; name: string; view: string }

/** What a window has: the views it loaded, and the one it shows. */
export interface WindowViews { registered: readonly string[]; showing: string | null }

/** Offered, per package id: the version it was offered at and its view. */
type Offered = Record<string, { version: string; view: string }>;

export class StartViewOffers {
  /** A version's start view (or none), by its digest: an installed version's files never change. */
  private readonly startViews = new Map<string, string | null>();
  private offered: Offered | null = null;
  /** One ask at a time, so two windows asking together cannot both be offered the same view. */
  private queue: Promise<unknown> = Promise.resolve();

  /** `file`: where what was offered is kept. */
  constructor(private readonly file: string) {}

  /** The start views to offer this window now, each recorded as offered. */
  next(window: WindowViews): Promise<StartViewOffer[]> {
    return this.serial(async () => {
      const offered = await this.load();
      const out: StartViewOffer[] = [];
      let changed = false;
      for (const r of await readInstalledPackages()) {
        // Off, its views do not load: it is offered once it is on.
        if (!r.on) continue;
        const view = await this.startViewOf(r);
        if (!view || offered[r.id]?.view === view || !window.registered.includes(view)) continue;
        offered[r.id] = { version: r.version, view };
        changed = true;
        // Already there: nothing to offer, and nothing to ask later.
        if (window.showing !== view) out.push({ package: r.id, name: r.name, view });
      }
      if (changed) await this.save(offered);
      return out;
    });
  }

  /** Settings offered package `id`'s start view itself, right after installing it. */
  offeredInSettings(id: string, version: string, view: string): Promise<void> {
    return this.serial(async () => {
      const offered = await this.load();
      if (offered[id]?.view === view && offered[id]?.version === version) return;
      offered[id] = { version, view };
      await this.save(offered);
    });
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  private async startViewOf(r: PackageRecord): Promise<string | null> {
    const known = this.startViews.get(r.digest);
    if (known !== undefined) return known;
    // A plugin installed on its own has no package manifest, and opens with no view.
    const raw = await readFile(path.join(versionFolder(r.id, r), PACKAGE_MANIFEST), "utf8").catch(() => null);
    let view: string | null = null;
    try { view = raw === null ? null : parsePackageManifest(JSON.parse(raw)).startup?.view ?? null; }
    catch { view = null; }
    this.startViews.set(r.digest, view);
    return view;
  }

  private async load(): Promise<Offered> {
    if (this.offered) return this.offered;
    const raw = await readFile(this.file, "utf8").catch(() => null);
    let read: Offered = {};
    try {
      const v = raw === null ? null : JSON.parse(raw) as { offered?: unknown };
      if (v && typeof v.offered === "object" && v.offered) read = v.offered as Offered;
    } catch { /* unreadable: start again; at worst a view is offered once more */ }
    return (this.offered = read);
  }

  private async save(offered: Offered): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ v: 1, offered }, null, 2)}\n`);
    await rename(tmp, this.file);
  }
}
