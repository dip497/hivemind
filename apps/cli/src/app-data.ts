/**
 * The sockets the app serves, which `hive` reaches, and where hive-net is. Where the app keeps its
 * data is `@hivemind/core/app-data`'s.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ipcPath } from "@hivemind/core";
import { appData, envGet, type Where } from "@hivemind/core/app-data";

/** A socket the app serves, by its name: `override` in the env names another. A named pipe on
 *  Windows. */
export function appSocket(name: string, override: string, where: Where = {}): string {
  const { platform = process.platform, env = process.env } = where;
  return envGet(env, override) || ipcPath(appData({ platform, env }), name, platform);
}

/** hive-net: named by HIVEMIND_HIVE_NET, else where the installers put it, else on PATH. */
export function hiveNetBin(): string | null {
  const exe = process.platform === "win32" ? "hive-net.exe" : "hive-net";
  const candidates = [
    process.env.HIVEMIND_HIVE_NET,
    path.join(os.homedir(), ".hivemind-app", exe),
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, exe)),
  ];
  return candidates.find((c): c is string => !!c && fs.existsSync(c)) ?? null;
}
