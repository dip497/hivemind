/**
 * Switching a plugin you added on or off from the app. It belongs to a package, and is switched
 * with it (`@hivemind/core/package-install`), the same as `hive plugins enable|disable`; every
 * window is told. A package is switched whole in `./packages-ipc.ts`.
 */
import { switchPlugin } from "@hivemind/core/package-install";
import { handleEffect } from "./app-ipc.js";
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
}
