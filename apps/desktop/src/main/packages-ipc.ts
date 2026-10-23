/**
 * Packages from the app: the installed ones, switching one whole, putting back the version before,
 * and adding one from a folder after the same review `hive plugins install --dry-run` prints. Every
 * change goes through `@hivemind/core/package-install`, as the CLI's do, and every window is told.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { app, dialog, type WebContents } from "electron";
import { checkPackageManifest, PACKAGE_MANIFEST } from "@hivemind/hub";
import { installPackage, reviewedOf, rollbackPackage, switchPackage, type InstalledPackage, type Reviewed } from "@hivemind/core/package-install";
import { readInstalledPackages } from "@hivemind/core/installed-packages";
import { memberKind } from "@hivemind/core/package-kinds";
import { newNonce } from "@hivemind/core/view-files";
import { handle, handleEffect } from "./app-ipc.js";
import { appWindowOf } from "./windows.js";
import { dialogStart, rememberPick } from "./dialog-start";
import { reloadSettings } from "./settings-store.js";
import { widgetsChanged } from "./widgets.js";
import { toolsChanged } from "./tool-packages.js";
import type { PackageReview } from "../shared/ipc.js";

const runsOf = (kind: string) => memberKind(kind)?.runs ?? "in the app";

/** The view a package opens with (its manifest's `startup.view`), named as its member is. */
async function opensWith(dir: string, r: InstalledPackage): Promise<PackageReview["opens"]> {
  const read = await readFile(path.join(dir, PACKAGE_MANIFEST), "utf8").then((t) => checkPackageManifest(JSON.parse(t)), () => null);
  const id = read && "manifest" in read ? read.manifest.startup?.view : undefined;
  const view = r.members.find((m) => m.kind === "view" && m.id === id);
  return view ? { id: view.id, name: view.name } : null;
}

/** A dry run's result as the app reviews it, with whether the version it replaces is on now. `dir`
 *  is the folder reviewed, whose manifest names the view it opens with. */
export async function packageReview(r: InstalledPackage, token: string, dir: string): Promise<PackageReview> {
  const named = new Map(r.members.map((m) => [`${m.kind}:${m.id}`, m.name]));
  const now = (await readInstalledPackages()).find((x) => x.id === r.record.id);
  return {
    token, id: r.record.id, name: r.record.name, version: r.record.version, on: r.record.on, opens: await opensWith(dir, r),
    replaces: r.replaced ? { version: r.replaced.version, on: now?.on ?? false } : null,
    members: r.members.map((m) => ({ kind: m.kind, id: m.id, name: m.name, permissions: m.permissions, runs: runsOf(m.kind) })),
    changes: r.changes.map((c) => ({ ...c, name: named.get(`${c.kind}:${c.id}`) ?? c.id, runs: runsOf(c.kind) })),
  };
}

async function changed(): Promise<void> {
  await reloadSettings();
  widgetsChanged();
  toolsChanged();
}

export function installPackagesIpc(): void {
  handle("plugins:packages", async () => (await readInstalledPackages()).map((r) => ({
    id: r.id, name: r.name, version: r.version, on: r.on,
    members: r.members.map((m) => ({ kind: m.kind, id: m.id, runs: runsOf(m.kind) })),
    previous: r.previous ? { version: r.previous.version, on: r.previous.on } : null,
  })));
  handleEffect("plugins:switch-package", (id, on) => ({ target: typeof id === "string" ? id : undefined, detail: on ? "on" : "off" }), async (_e, id: unknown, on: unknown) => {
    if (typeof id !== "string" || typeof on !== "boolean") throw new Error("not a package");
    await switchPackage(id, on);
    await changed();
  });
  handleEffect("plugins:rollback", (id) => ({ target: typeof id === "string" ? id : undefined }), async (_e, id: unknown) => {
    if (typeof id !== "string") throw new Error("not a package");
    await rollbackPackage(id);
    await changed();
  });

  // The folder last reviewed, by which window, and what the review saw: installed only by that
  // window, and only if its files, the version it replaces and its switch are still as reviewed.
  let pending: { token: string; dir: string; id: string; reviewed: Reviewed; sender: WebContents } | null = null;
  handle("plugins:review-folder", async (e) => {
    pending = null;
    const win = appWindowOf(e.sender);
    const opts = { title: "Add from a folder", buttonLabel: "Review", defaultPath: dialogStart("package", app.getPath("home")), properties: ["openDirectory" as const] };
    const picked = await (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts));
    const dir = picked.filePaths[0];
    if (picked.canceled || !dir) return null;
    rememberPick("package", dir);
    const r = await installPackage(dir, { dryRun: true });
    pending = { token: newNonce(), dir, id: r.record.id, reviewed: reviewedOf(r), sender: e.sender };
    return await packageReview(r, pending.token, dir);
  }, { local: true });
  handleEffect("plugins:install-folder", (token) => ({ target: pending && pending.token === token ? pending.id : undefined }), async (e, token: unknown) => {
    if (!pending || pending.token !== token || pending.sender !== e.sender) throw new Error("Choose the folder again to review it.");
    const { dir, id, reviewed } = pending;
    pending = null;
    await installPackage(dir, { id, reviewed }).catch((err: Error) => {
      throw /after the review/.test(err.message) ? new Error("It changed after the review. Choose the folder again.") : err;
    });
    await changed();
  }, { local: true });
}
