/**
 * Widgets in the app: listed for every window and removed with their package; every window is
 * told, so none needs a restart. Adding one from a folder is `./packages-ipc.ts`. The format is core's (`@hivemind/core/widgets`), installing
 * is the package store's (`@hivemind/core/package-install`).
 */
import { listWidgets } from "@hivemind/core/widgets";
import { removePlugin } from "@hivemind/core/package-install";
import { handle } from "./app-ipc.js";
import { broadcast } from "./windows.js";

export { widgetAsset } from "@hivemind/core/widgets";

export const widgetsChanged = (): void => {
  broadcast("widgets:changed");
};

export function installWidgetIpc(): void {
  handle("widgets:list", () => listWidgets());
  handle("widgets:remove", async (_e, id: unknown) => {
    if (typeof id !== "string") throw new Error("not a widget");
    await removePlugin("widget", id);
    widgetsChanged();
  });
}
