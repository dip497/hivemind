/**
 * Tool plugins' services in the app (`@hivemind/host/services`): run while the app serves the
 * drive socket, kept to the plugins switched on and the workspaces picked for each, and shown on
 * the Plugins page with the end of their logs.
 */
import path from "node:path";
import { app } from "electron";
import type { Grants } from "@hivemind/host/grants";
import { Services, wantedServices } from "@hivemind/host/services";
import { handle } from "./app-ipc.js";
import { getSettings, onSettingsChange } from "./settings-store.js";
import { listTools, onToolsChanged, safeMode } from "./tool-packages.js";
import { broadcast } from "./windows.js";

let services: Services | null = null;
let syncing: Promise<void> = Promise.resolve();

/** Run what should run now, one sync after another. */
function sync(): void {
  const s = services;
  if (!s) return;
  syncing = syncing.then(async () => s.sync(wantedServices(await listTools(), getSettings().plugins.state, safeMode())))
    .catch((e: unknown) => console.warn(`[services] ${(e as Error).message}`));
}

/** Once the drive socket is this app's: another app or host on the machine runs them otherwise. */
export function startServices(o: { driveSock: string; grants: Grants; serving: Promise<boolean> }): void {
  void o.serving.then((mine) => {
    if (!mine) return;
    services = new Services({
      driveSock: o.driveSock,
      grants: o.grants,
      logDir: path.join(app.getPath("userData"), "services"),
      onChange: () => broadcast("services:changed"),
    });
    onSettingsChange(sync);
    onToolsChanged(sync);
    sync();
  });
}

/** Stop them as the app quits. */
export function stopServices(): void {
  void services?.stop();
  services = null;
}

export function installServicesIpc(): void {
  handle("services:list", () => services?.states() ?? []);
  handle("services:log", (_e, plugin: unknown) => (typeof plugin === "string" && services ? services.log(plugin) : ""));
}
