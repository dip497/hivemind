/**
 * Where the app keeps this machine's data (its token, keys, workspaces and every socket it
 * serves), as Electron names it on each platform: what the `hive` CLI and the API SDK both find.
 */
import os from "node:os";
import path from "node:path";

/** Which machine's paths: this one's unless a caller says another. */
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

/** The app's data folder (`HIVEMIND_APP_DATA` names another). */
export function appData({ platform = process.platform, env = process.env }: Where = {}): string {
  const named = envGet(env, "HIVEMIND_APP_DATA");
  if (named) return named;
  if (platform === "win32") return win32UserDataDir(env) ?? path.join(os.homedir(), "AppData", "Roaming", "hivemind");
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "hivemind");
  return path.join(configDir(env), "hivemind");
}
