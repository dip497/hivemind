/**
 * Where a program finds the drive socket and who it is, when it is not told: what the app gives
 * every agent it starts (`HIVE_DRIVE_SOCK`, `HCP_TOKEN`), a grant's token (`HIVE_DRIVE_TOKEN`),
 * else the app's own data folder and the person's token there.
 */
import fs from "node:fs";
import path from "node:path";
import { ipcPath } from "@hivemind/core/ipc";
import { appData, envGet, type Where } from "@hivemind/core/app-data";

export type { Where };

/** Where programs drive this machine: `HIVE_DRIVE_SOCK`, else `drive.sock` in the app's data
 *  folder (a named pipe on Windows). */
export function driveSocketPath(where: Where = {}): string {
  const { platform = process.platform, env = process.env } = where;
  return envGet(env, "HIVE_DRIVE_SOCK") || ipcPath(appData({ platform, env }), "drive.sock", platform);
}

/** Who this is: `HCP_TOKEN`, an agent's own; `HIVE_DRIVE_TOKEN`, a program's grant; else the
 *  install's token, the person at this machine; "" when there is none. */
export function defaultToken(where: Where = {}): string {
  const { env = process.env } = where;
  const given = envGet(env, "HCP_TOKEN") || envGet(env, "HIVE_DRIVE_TOKEN");
  if (given) return given;
  try {
    return fs.readFileSync(path.join(appData(where), "hcp.token"), "utf8").trim();
  } catch {
    return "";
  }
}

/** The workspace a program drives when it names none: `HIVE_WORKSPACE`. */
export function defaultWorkspace(where: Where = {}): string | undefined {
  return envGet(where.env ?? process.env, "HIVE_WORKSPACE") || undefined;
}
