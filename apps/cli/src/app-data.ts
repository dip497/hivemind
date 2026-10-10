/**
 * Where the app keeps this machine's data (its keys, workspaces, access lists and network), which
 * `hive network` changes and `hive host` serves from, and where hive-net is.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ipcPath } from "@hivemind/core";

/** Which machine's paths: this one's unless a test says another. */
export interface Where { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv }

/** Case-insensitive env read; on Windows a process.env spread carries `Path`, not `PATH`, and
 *  system variables keep whatever casing the creator used. */
export function envGet(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (name in env) return env[name];
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}

/** Where Electron keeps the packaged app's data on Windows, `%APPDATA%\hivemind`; null when
 *  APPDATA is missing from the env. */
export function win32UserDataDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const roaming = envGet(env, "APPDATA");
  return roaming ? path.join(roaming, "hivemind") : null;
}

/** The app's data folder, as Electron names it on each platform (`HIVEMIND_APP_DATA` names
 *  another): its token and every socket it serves are there. */
export function appData({ platform = process.platform, env = process.env }: Where = {}): string {
  const named = envGet(env, "HIVEMIND_APP_DATA");
  if (named) return named;
  if (platform === "win32") return win32UserDataDir(env) ?? path.join(os.homedir(), "AppData", "Roaming", "hivemind");
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "hivemind");
  return path.join(configDir(env), "hivemind");
}

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
