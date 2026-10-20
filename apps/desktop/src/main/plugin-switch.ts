/**
 * Switching a plugin you added on or off from the app. It belongs to a package, and is switched
 * with it (`@hivemind/core/package-install`), the same as `hive plugins enable|disable`; every
 * window is told. A package is switched whole from its row.
 */
import { switchPackage, switchPlugin } from "@hivemind/core/package-install";
import { readInstalledPackages } from "@hivemind/core/installed-packages";
import { handle, handleEffect } from "./app-ipc.js";
import { reloadSettings } from "./settings-store.js";
import { widgetsChanged } from "./widgets.js";
import { toolsChanged } from "./tool-packages.js";

const KINDS = ["view", "widget", "tool"] as const;

export function installPluginSwitchIpc(): void {
  handleEffect("plugins:switch", (kind, id, on) => ({ target: `${kind}:${id}`, detail: on ? "on" : "off" }), async (_e, kind: unknown, id: unknown, on: unknown) => {
    if (!KINDS.includes(kind as (typeof KINDS)[number]) || typeof id !== "string" || typeof on !== "boolean") throw new Error("not a plugin");
    if (!(await switchPlugin(kind as (typeof KINDS)[number], id, on))) throw new Error(`${kind}:${id} was not installed here`);
    await reloadSettings();
    widgetsChanged();
    toolsChanged();
  });
  // Every installed package, for the Plugins page's rows.
  handle("plugins:packages", async () => (await readInstalledPackages()).map((r) => ({
    id: r.id, name: r.name, version: r.version, on: r.on, members: r.members.map((m) => ({ kind: m.kind, id: m.id })),
  })));
  handleEffect("plugins:switch-package", (id, on) => ({ target: typeof id === "string" ? id : undefined, detail: on ? "on" : "off" }), async (_e, id: unknown, on: unknown) => {
    if (typeof id !== "string" || typeof on !== "boolean") throw new Error("not a package");
    await switchPackage(id, on);
    await reloadSettings();
    widgetsChanged();
    toolsChanged();
  });
}
