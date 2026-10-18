/**
 * What the app's terminal daemon runs from, so that it outlives the app. An AppImage started
 * directly runs from a mount that goes when the app quits, and whatever runs from it dies then
 * (SIGBUS); its daemon runs from a copy of the AppImage extracted beside the user data instead.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

/** `[runtime, script]` for the daemon: as given, or their places in the extracted copy of
 *  `appImage` when they are inside its `mount`. One copy per `version` under `dir`. */
export async function lastingDaemon(o: { runtime: string; script: string; appImage?: string; mount?: string; dir: string; version: string }): Promise<[string, string]> {
  const { appImage, mount } = o;
  if (!appImage || !mount || !o.runtime.startsWith(mount + path.sep)) return [o.runtime, o.script];
  const home = path.join(o.dir, o.version);
  const root = path.join(home, "squashfs-root");
  if (!fs.existsSync(path.join(home, "extracted"))) {
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(home, { recursive: true });
    await new Promise<void>((resolve, reject) => execFile(appImage, ["--appimage-extract"], { cwd: home, maxBuffer: 64 * 1024 * 1024 }, (e) => (e ? reject(e) : resolve())));
    fs.writeFileSync(path.join(home, "extracted"), "");
  }
  removeUnused(o.dir, home);
  return [path.join(root, path.relative(mount, o.runtime)), path.join(root, path.relative(mount, o.script))];
}

/** Every copy under `dir` but `keep` that no process runs from. */
function removeUnused(dir: string, keep: string): void {
  const running: string[] = [];
  for (const pid of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try { running.push(fs.readlinkSync(`/proc/${pid}/exe`)); } catch { /* gone, or not ours */ }
  }
  for (const name of fs.readdirSync(dir)) {
    const copy = path.join(dir, name);
    if (copy === keep || running.some((exe) => exe.startsWith(copy + path.sep))) continue;
    fs.rmSync(copy, { recursive: true, force: true });
  }
}
