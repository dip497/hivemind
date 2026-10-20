/** A plugin's .svg icon, read from its folder: tools and views draw theirs from the same data URL. */
import { readFile } from "node:fs/promises";
import path from "node:path";

const ICON_MAX = 32 * 1024;

/** The .svg at `file` in `dir` as a data URL, or undefined when it is missing or larger than 32 KiB. */
export async function readSvgIcon(dir: string, file: string): Promise<string | undefined> {
  const svg = await readFile(path.join(dir, file)).catch(() => null);
  return svg && svg.length <= ICON_MAX ? `data:image/svg+xml;base64,${svg.toString("base64")}` : undefined;
}
