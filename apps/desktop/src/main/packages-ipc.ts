/**
 * Packages from the app: the installed ones, switching one whole, putting back the version before,
 * and adding one from a folder after the same review `hive plugins install --dry-run` prints. Every
 * change goes through `@hivemind/core/package-install`, as the CLI's do, and every window is told.
 */
import { app, dialog } from "electron";
import { installPackage, rollbackPackage, switchPackage, type InstalledPackage } from "@hivemind/core/package-install";
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

/** A dry run's result as the app reviews it, with whether the version it replaces is on now. */
export async function packageReview(r: InstalledPackage, token: string): Promise<PackageReview> {
  const named = new Map(r.members.map((m) => [`${m.kind}:${m.id}`, m.name]));
  const now = (await readInstalledPackages()).find((x) => x.id === r.record.id);
  return {
    token, id: r.record.id, name: r.record.name, version: r.record.version, on: r.record.on,
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

  // The folder last reviewed, and what its files were then: installed only if they still are.
  let pending: { token: string; dir: string; id: string; digest: string } | null = null;
  handle("plugins:review-folder", async (e) => {
    pending = null;
    const win = appWindowOf(e.sender);
    const opts = { title: "Add from a folder", buttonLabel: "Review", defaultPath: dialogStart("package", app.getPath("home")), properties: ["openDirectory" as const] };
    const picked = await (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts));
    const dir = picked.filePaths[0];
    if (picked.canceled || !dir) return null;
    rememberPick("package", dir);
    const r = await installPackage(dir, { dryRun: true });
    pending = { token: newNonce(), dir, id: r.record.id, digest: r.record.digest };
    return await packageReview(r, pending.token);
  }, { local: true });
  handleEffect("plugins:install-folder", (token) => ({ target: pending && pending.token === token ? pending.id : undefined }), async (_e, token: unknown) => {
    if (!pending || pending.token !== token) throw new Error("Choose the folder again to review it.");
    const { dir, id, digest } = pending;
    pending = null;
    if ((await installPackage(dir, { id, dryRun: true })).record.digest !== digest) throw new Error("Its files changed after the review. Choose the folder again.");
    await installPackage(dir, { id });
    await changed();
  }, { local: true });
}
