/**
 * Widgets in the app: listed for every window, added from a folder the person picks (copied in,
 * so moving the original breaks nothing) and removed; every window is told, so none needs a
 * restart. The package format and the folder are core's (`@hivemind/core/widgets`).
 */
import { dialog } from "electron";
import { installWidget, listWidgets, removeWidget } from "@hivemind/core/widgets";
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
    const pkg = await installWidget(from);
    widgetsChanged();
    return { id: pkg.id, name: pkg.name };
  }, { local: true });
  handle("widgets:remove", async (_e, id: unknown) => {
    if (typeof id !== "string") throw new Error("not a widget");
    await removeWidget(id);
    widgetsChanged();
  });
}
