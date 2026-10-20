// Plugins are installed as packages (@hivemind/core/package-install): a spec that needs one in a
// profile installs its folder there the way a person does, with `hive plugins install`.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../cli/src/index.ts");

/** Install the plugin folder `dir` into the profile whose config folder is `configHome`. No app
 *  is asked to load it: one that runs picks it up when it lists its plugins again. */
export function installPlugin(configHome: string, dir: string): void {
  const env = { ...process.env, XDG_CONFIG_HOME: configHome, HIVE_HCP_SOCK: path.join(configHome, "no-app.sock"), HIVE_DRIVE_SOCK: path.join(configHome, "no-drive.sock") };
  delete env.HIVE_SETTINGS;
  const r = spawnSync("bun", [CLI, "plugins", "install", dir, "--json"], { encoding: "utf8", env });
  if (r.status !== 0) throw new Error(`hive plugins install ${dir} → exit ${r.status}\n${r.stdout}\n${r.stderr}`);
}

/** A file of the package `id` installed in that profile, as the version in use holds it; null
 *  when no such package is installed or the file is not in it. */
export function installedFile(configHome: string, id: string, file = ""): string | null {
  const root = path.join(configHome, "hivemind", "packages");
  let records: Array<{ id: string; version: string; digest: string }>;
  try { records = JSON.parse(fs.readFileSync(path.join(root, "installed.json"), "utf8")).packages; } catch { return null; }
  const r = records.find((x) => x.id === id);
  if (!r) return null;
  const at = path.join(root, "store", id.replace(/^@/, "").replace("/", "--"), `${r.version}-${r.digest.slice(0, 12)}`, file);
  return fs.existsSync(at) ? at : null;
}
