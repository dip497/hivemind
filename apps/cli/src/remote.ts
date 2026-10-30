/** `--machine` routing and the `machine add` probe, through the system `ssh` so the user's ssh config and keys apply. */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  HiveError, PUBLISHED_PLATFORMS, WINDOWS_PROBE, hiveThere, installCopyCommand, installFetchCommand, isWindowsPlatform, localPlatform, parseProbe, personFolder, probeScript,
  readMachines, releaseAssetUrl as coreReleaseAssetUrl, resolveMachine, sshDestination, type Machine, type ProbeResult,
} from "@hivemind/core";
import { appData } from "@hivemind/core/app-data";
import { machineKeys } from "@hivemind/workspace-host/keyring";
import pkg from "../package.json" with { type: "json" };

export { parseProbe, platformOf, shq } from "@hivemind/core";
export type { ProbeResult } from "@hivemind/core";

/** Background commands never prompt: a host-key or auth problem is for the user to fix with a plain `ssh` once. */
function sshOpts(tty: boolean): string[] {
  const o = ["-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4"];
  return tty ? ["-t", ...o] : ["-T", "-o", "BatchMode=yes", ...o];
}

export function sshArgv(target: string, remoteCommand: string, tty: boolean): string[] {
  return [...sshOpts(tty), ...sshDestination(target), remoteCommand];
}

export async function loadMachine(ref: string): Promise<Machine> {
  const m = resolveMachine(await readMachines(), ref);
  if (!m.enabled) throw new HiveError("machine_disabled", `machine '${m.label}' is disabled — \`hive machine enable ${m.id}\``);
  return m;
}

/** The folder on machines that this person's terminals run in: the same one their app uses. */
function person(): string {
  return personFolder(machineKeys(path.join(appData(), "identity")).personId);
}

/** Runs this version's `hive` there, as this person's, and exits with its status; puts it there first when it is not. */
export function execOnMachine(m: Machine, args: string[], tty: boolean): Promise<never> {
  if (!m.installHive) {
    throw new HiveError("machine_without_hive", `${m.label} runs its terminals over plain ssh, with no hive there — \`hive machine install-hive ${m.id}\` puts it there`);
  }
  ensureHive(m.target);
  const cmd = hiveThere(pkg.version, person(), args);
  return new Promise(() => {
    const child = spawn("ssh", sshArgv(m.target, cmd, tty), { stdio: "inherit" });
    child.on("error", (e) => { process.stderr.write(`ssh failed: ${e.message}\n`); process.exit(3); });
    // 255 = ssh could not connect or authenticate.
    child.on("exit", (code, signal) => process.exit(code === 255 ? 3 : (code ?? (signal ? 1 : 0))));
  });
}

function probeWith(target: string, command: string): ProbeResult {
  const r = spawnSync("ssh", sshArgv(target, command, false), { encoding: "utf8", timeout: 30_000 });
  if (r.error) throw new HiveError("machine_unreachable", `ssh failed: ${r.error.message}`);
  if (r.status === 255) {
    throw new HiveError("machine_unreachable", `ssh ${target} failed: ${(r.stderr || "").trim().split("\n").pop() || "connection refused"} — check that plain \`ssh ${target}\` works (host key, keys/agent) first`);
  }
  return parseProbe(r.stdout);
}

/** What `target` is: asked as a POSIX shell, then, when none answers (Windows' cmd or
 *  PowerShell), as Windows. */
export function probe(target: string): ProbeResult {
  try {
    return probeWith(target, probeScript(pkg.version));
  } catch (e) {
    if (!(e instanceof HiveError) || e.code !== "machine_probe_failed") throw e;
    return probeWith(target, WINDOWS_PROBE);
  }
}

/** The compiled binary's path; `null` when running from source. */
export function compiledSelf(): string | null {
  const main = (globalThis as { Bun?: { main?: string } }).Bun?.main ?? "";
  return main.startsWith("/$bunfs/") || main.startsWith("B:/~BUN/") ? process.execPath : null;
}

export { PUBLISHED_PLATFORMS } from "@hivemind/core";

export function releaseAssetUrl(platform: string, version = pkg.version): string {
  return coreReleaseAssetUrl(platform, version, process.env.HIVEMIND_REPO || undefined);
}

/** `target` with this version's `hive` in place: this binary copied there when the platforms
 *  match, else the same version's release downloaded there. `put`: it was not there before. */
export function ensureHive(target: string): ProbeResult & { put?: true } {
  const found = probe(target);
  if (found.daemon) return found;
  if (isWindowsPlatform(found.platform)) throw new HiveError("machine_install_unavailable", "hive is not put on Windows machines yet: their terminals run over plain ssh");
  const self = compiledSelf();
  const copy = self !== null && localPlatform() === found.platform;
  if (!copy && !PUBLISHED_PLATFORMS.includes(found.platform)) {
    throw new HiveError("machine_install_unavailable", `no hive release is published for ${found.platform} — build it there from source (install.sh --dev)`);
  }
  const url = releaseAssetUrl(found.platform);
  const bin = copy ? fs.readFileSync(self!) : null;
  const cmd = bin ? installCopyCommand(pkg.version, bin.length) : installFetchCommand(pkg.version, url);
  const r = spawnSync("ssh", sshArgv(target, cmd, false), { input: bin ?? "", encoding: "utf8", timeout: 300_000, maxBuffer: 1 << 20 });
  if (r.status !== 0) {
    const why = (r.stderr || "").trim() || `exit ${r.status}`;
    throw new HiveError("machine_install_failed", copy ? `copying hive to ${target} failed: ${why}` : `${target} could not download ${url}: ${why}`);
  }
  const again = probe(target);
  if (!again.daemon) throw new HiveError("machine_install_failed", `put hive ${pkg.version} on ${target}, but it cannot run terminal sessions on ${again.platform}`);
  return { ...again, put: true };
}
