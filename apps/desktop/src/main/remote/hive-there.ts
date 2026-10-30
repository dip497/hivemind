/**
 * This app's `hive` on an ssh machine: the copy of its own version there, put in place the first
 * time it is needed, and the person whose folder its terminals run in. Nobody installs or updates
 * it by hand, and an app of another version, or another person on the same login, never touches it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { app } from "electron";
import { PUBLISHED_PLATFORMS, installCopyCommand, installFetchCommand, isWindowsPlatform, localPlatform, personFolder, releaseAssetUrl, type ProbeResult } from "@hivemind/core";
import type { RemoteTarget } from "@hivemind/core/remote-uri";
import { remoteConns } from "@hivemind/host/remote/conn";
import { probeMachine, type SshPaths } from "@hivemind/host/remote/ssh";
import { machineIdentity } from "../identity.js";

const run = promisify(execFile);

/** The version of `hive` this app runs on machines: its own. */
export const hiveVersion = (): string => app.getVersion();

/** The folder on a machine that this person's terminals run in. */
export const hivePerson = (): string => personFolder(machineIdentity().personId);

/** What `t` is, and whether this app's `hive` is in place there. */
export function probeHive(t: RemoteTarget, paths: SshPaths): Promise<ProbeResult> {
  return probeMachine(t, remoteConns.resolveAuthFor(t.hostId), paths, hiveVersion());
}

export const NO_HIVE_ON_WINDOWS = "hive is not put on Windows machines yet: their terminals run over plain ssh";

/** `t` with this app's `hive` in place: copied or downloaded there when it is not (`put`). `missing`
 *  says why it could not be put there; a failure to reach `t` at all is thrown. */
export async function ensureHive(t: RemoteTarget, paths: SshPaths, putting?: () => void): Promise<{ found: ProbeResult; put?: true; missing?: string }> {
  const found = await probeHive(t, paths);
  if (found.daemon) return { found };
  if (isWindowsPlatform(found.platform)) return { found, missing: NO_HIVE_ON_WINDOWS };
  putting?.();
  try {
    await installHive(t, found.platform);
  } catch (e) {
    return { found, missing: e instanceof Error ? e.message : String(e) };
  }
  const again = await probeHive(t, paths);
  return again.daemon ? { found: again, put: true } : { found: again, missing: `hive ${hiveVersion()} was put there but cannot run terminal sessions on ${again.platform}` };
}

function isNativeBinary(file: string): boolean {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size < 10 * 1024 * 1024) return false;
    const head = Buffer.alloc(4);
    const fd = fs.openSync(file, "r");
    try { fs.readSync(fd, head, 0, 4, 0); } finally { fs.closeSync(fd); }
    return head.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || head.readUInt32LE(0) === 0xfeedfacf;
  } catch {
    return false;
  }
}

/** A compiled `hive` here of this app's version that runs the daemon; copying it needs no network there. */
async function localHiveBinary(): Promise<string | null> {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const cands = [process.env.HIVE_BIN, ...dirs.map((d) => path.join(d, "hive")), path.join(os.homedir(), ".local/bin/hive"), path.join(os.homedir(), ".hivemind-app/hive")];
  for (const c of new Set(cands)) {
    if (!c) continue;
    let real: string;
    try { real = fs.realpathSync(c); } catch { continue; }
    if (!isNativeBinary(real)) continue;
    try {
      if ((await run(real, ["--version"], { timeout: 10_000 })).stdout.trim() !== hiveVersion()) continue;
      const help = await run(real, ["daemon", "--help"], { timeout: 10_000 });
      if (`${help.stdout}${help.stderr}`.includes("bridge")) return real;
    } catch { /* not a working hive */ }
  }
  return null;
}

async function installHive(t: RemoteTarget, platform: string): Promise<void> {
  const version = hiveVersion();
  const bin = localPlatform() === platform ? await localHiveBinary() : null;
  if (!bin && !PUBLISHED_PLATFORMS.includes(platform)) throw new Error(`no hive release is published for ${platform}`);
  const url = releaseAssetUrl(platform, version);
  const body = bin ? fs.readFileSync(bin) : undefined;
  console.log(`[machines] putting hive ${version} on ${t.hostId} from ${bin ?? url}`);
  const r = await remoteConns.exec(t, body ? installCopyCommand(version, body.length) : installFetchCommand(version, url), { input: body, timeoutMs: 300_000 });
  if (r.code === 0) return;
  const why = r.stderr.trim() || `exit ${r.code}`;
  if (body) throw new Error(`copying hive there failed: ${why}`);
  // curl 22 on a release URL: that version was never published for this platform (a build from source).
  if (/\b22\b|404/.test(why)) throw new Error(`no published hive ${version} for ${platform}: run a released build of this app`);
  throw new Error(`downloading ${url} there failed: ${why}`);
}
