/** `--machine` routing and the `machine add` probe, through the system `ssh` so the user's ssh config and keys apply. */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { HiveError, PROBE, PUBLISHED_PLATFORMS, installCopyCommand, installFetchCommand, localPlatform, parseProbe, readMachines, releaseAssetUrl as coreReleaseAssetUrl, resolveMachine, shq, sshDestination, type Machine, type ProbeResult } from "@hivemind/core";
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
  if (!m.hivePath) throw new HiveError("machine_no_hive", `machine '${m.label}' has no hive path recorded — \`hive machine check ${m.id}\``);
  return m;
}

/** Runs the remote `hive` by its recorded absolute path and exits with its status. */
export function execOnMachine(m: Machine, args: string[], tty: boolean): Promise<never> {
  const cmd = [m.hivePath!, ...args].map(shq).join(" ");
  return new Promise(() => {
    const child = spawn("ssh", sshArgv(m.target, cmd, tty), { stdio: "inherit" });
    child.on("error", (e) => { process.stderr.write(`ssh failed: ${e.message}\n`); process.exit(3); });
    // 255 = ssh could not connect or authenticate.
    child.on("exit", (code, signal) => process.exit(code === 255 ? 3 : (code ?? (signal ? 1 : 0))));
  });
}

export function probe(target: string): ProbeResult {
  const r = spawnSync("ssh", sshArgv(target, PROBE, false), { encoding: "utf8", timeout: 30_000 });
  if (r.error) throw new HiveError("machine_unreachable", `ssh failed: ${r.error.message}`);
  if (r.status === 255) {
    throw new HiveError("machine_unreachable", `ssh ${target} failed: ${(r.stderr || "").trim().split("\n").pop() || "connection refused"} — check that plain \`ssh ${target}\` works (host key, keys/agent) first`);
  }
  return parseProbe(r.stdout);
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

/** Copies this binary when the platforms match; otherwise the remote downloads the release asset of this same version. */
export function installSelf(target: string, remotePlatform: string): string {
  const self = compiledSelf();
  const copy = self !== null && localPlatform() === remotePlatform;
  if (!copy && !PUBLISHED_PLATFORMS.includes(remotePlatform)) {
    throw new HiveError("machine_install_unavailable", `no hive release is published for ${remotePlatform} — build it there from source (install.sh --dev), then rerun`);
  }
  const url = releaseAssetUrl(remotePlatform);
  const bin = copy ? fs.readFileSync(self!) : null;
  const cmd = bin ? installCopyCommand(bin.length) : installFetchCommand(url);
  const r = spawnSync("ssh", sshArgv(target, cmd, false), { input: bin ?? "", encoding: "utf8", timeout: 300_000, maxBuffer: 1 << 20 });
  if (r.status !== 0) {
    const why = (r.stderr || "").trim() || `exit ${r.status}`;
    throw new HiveError("machine_install_failed", copy ? `copying hive to ${target} failed: ${why}` : `${target} could not download ${url}: ${why}`);
  }
  return r.stdout.trim().split("\n").pop()!;
}
