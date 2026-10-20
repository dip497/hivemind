/**
 * Widgets in the app: listed for every window, added from a folder the person picks (copied in as
 * a package, so moving the original breaks nothing) and removed with their package; every window
 * is told, so none needs a restart. The format is core's (`@hivemind/core/widgets`), installing
 * is the package store's (`@hivemind/core/package-install`).
 */
import { dialog } from "electron";
import { listWidgets } from "@hivemind/core/widgets";
import { installPackage, removePlugin } from "@hivemind/core/package-install";
import { handle } from "./app-ipc.js";
import { appWindowOf, broadcast } from "./windows.js";

export { widgetAsset } from "@hivemind/core/widgets";

export const widgetsChanged = (): void => {
  broadcast("widgets:changed");
};

export function installWidgetIpc(): void {
  handle("widgets:list", () => listWidgets());
  handle("widgets:install", async (e) => {
    const win = appWindowOf(e.sender);
    const picked = await (win ? dialog.showOpenDialog(win, { properties: ["openDirectory"], title: "Add a widget" }) : dialog.showOpenDialog({ properties: ["openDirectory"], title: "Add a widget" }));
    const from = picked.filePaths[0];
    if (picked.canceled || !from) return null;
    const { record } = await installPackage(from);
    widgetsChanged();
    return { id: record.id, name: record.name };
  }, { local: true });
  handle("widgets:remove", async (_e, id: unknown) => {
    if (typeof id !== "string") throw new Error("not a widget");
    await removePlugin("widget", id);
    widgetsChanged();
  });
}
