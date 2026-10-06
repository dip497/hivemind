/**
 * Widget packages on this machine: `<userData>/widgets/<id>/`, each a `widget.json` ({ name, w?,
 * h? }) and the `widget.js` the window runs in a worker. A folder that cannot be read is skipped.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { handle } from "./app-ipc.js";
import type { WidgetPackage } from "../shared/ipc.js";

export const widgetsDir = (): string => path.join(app.getPath("userData"), "widgets");

export async function listWidgets(dir = widgetsDir()): Promise<WidgetPackage[]> {
  const ids = await readdir(dir).catch(() => [] as string[]);
  const found = await Promise.all(ids.sort().map(async (id): Promise<WidgetPackage | null> => {
    try {
      const meta = JSON.parse(await readFile(path.join(dir, id, "widget.json"), "utf8")) as { name?: unknown; w?: unknown; h?: unknown };
      const code = await readFile(path.join(dir, id, "widget.js"), "utf8");
      const size = (v: unknown, d: number) => (typeof v === "number" && v >= 60 && v <= 1200 ? v : d);
      return { id, name: typeof meta.name === "string" ? meta.name : id, w: size(meta.w, 220), h: size(meta.h, 140), code };
    } catch { return null; }
  }));
  return found.filter((w): w is WidgetPackage => w !== null);
}

export function installWidgetIpc(): void {
  handle("widgets:list", () => listWidgets());
}
