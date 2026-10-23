/**
 * Themes from the app: the ones installed packages hold, applying one and going back to the look
 * before it. Every change goes through `@hivemind/core/theme-apply`, as `hive theme` does, on the
 * settings.json main owns, and every window hears it in the settings broadcast.
 */
import { applyTheme, listInstalledThemes, revertTheme, themeStatus } from "@hivemind/core/theme-apply";
import { handle, handleEffect } from "./app-ipc.js";
import { getSettings, reloadSettings, settingsFile } from "./settings-store.js";
import type { ThemesInfo } from "../shared/ipc.js";

export function installThemesIpc(): void {
  handle("themes:list", async (): Promise<ThemesInfo> => {
    const { themes } = await listInstalledThemes();
    return {
      themes: themes.map((t) => ({ id: t.id, name: t.name, mode: t.mode, swatches: t.swatches, package: t.package })),
      status: themeStatus(getSettings().appearanceExtra.theme, themes),
    };
  });
  handleEffect("themes:apply", (id) => ({ target: typeof id === "string" ? id : undefined }), async (_e, id: unknown) => {
    const t = (await listInstalledThemes()).themes.find((x) => x.id === id);
    if (!t) throw new Error(`no installed theme ${String(id)}`);
    await applyTheme(t, settingsFile());
    await reloadSettings();
  });
  handleEffect("themes:revert", () => ({}), async () => {
    await revertTheme(settingsFile());
    await reloadSettings();
  });
}
