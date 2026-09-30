/**
 * Where the app keeps this machine's data (its keys, workspaces, access lists and network), which
 * `hive network` changes and `hive host` serves from, and where hive-net is.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configDir, win32UserDataDir } from "./hcp.js";

/** The app's data folder (`HIVEMIND_APP_DATA` names another). */
export function appData(): string {
  const named = process.env.HIVEMIND_APP_DATA;
  if (named) return named;
  if (process.platform === "win32") return win32UserDataDir() ?? path.join(os.homedir(), "AppData", "Roaming", "hivemind");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "hivemind");
  return path.join(configDir(), "hivemind");
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
