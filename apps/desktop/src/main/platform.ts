/**
 * The POSIX assumptions this codebase grew up with, in one place.
 *
 * Every helper here is a pure function of (platform, inputs) so the Windows
 * behaviour is unit-testable on Linux — which matters, because nobody on the
 * project has a Windows box yet. Pass `platform` explicitly in tests; it
 * defaults to the running one.
 */
import crypto from "node:crypto";
import path from "node:path";

export type Platform = NodeJS.Platform;

/**
 * Address for a local IPC endpoint.
 *
 * POSIX: a unix socket file inside userData, as before.
 *
 * Windows: there is no filesystem socket. Node's net API speaks named pipes
 * through the same connect()/createServer() calls, but the address must look
 * like `\\.\pipe\<name>` — a path under userData just yields ENOENT/EACCES.
 * The name must be IDENTICAL in every process that reaches this endpoint: the
 * pty daemon is spawned detached and re-derives it, and the hcp address is
 * handed to agent CLIs through HIVE_HCP_SOCK. So it's derived from the
 * userData dir (hashed — the raw path contains `\`, spaces and a drive letter,
 * none of which belong in a pipe name), which keeps it unique per install and
 * per user while staying stable across processes.
 */
export function ipcPath(userDataDir: string, name: string, platform: Platform = process.platform): string {
  if (platform !== "win32") return path.join(userDataDir, name);
  const key = crypto.createHash("sha256").update(path.resolve(userDataDir)).digest("hex").slice(0, 12);
  return `\\\\.\\pipe\\hivemind-${key}-${name.replace(/\.sock$/, "")}`;
}

/**
 * The interactive shell a fresh terminal tile starts with.
 *
 * `powershell.exe` rather than pwsh: Windows PowerShell 5.1 ships with every
 * supported Windows, PowerShell 7 does not, and a missing shell is a dead tile.
 * -NoLogo suppresses the startup banner (the closest thing to bash's -i having
 * no preamble); the profile is deliberately LOADED, matching `-il` on POSIX, so
 * the user's aliases and PATH edits are present.
 */
export function defaultShellFor(platform: Platform = process.platform): { cmd: string; args: string[] } {
  if (platform === "win32") return { cmd: "powershell.exe", args: ["-NoLogo"] };
  return { cmd: "/bin/bash", args: ["-il"] };
}

/**
 * Repair a spawn spec that names a shell from a different OS.
 *
 * The shell is persisted into canvas.json when a tile is created, so a canvas
 * written on Linux and opened on Windows (synced profile, restored backup,
 * shared workspace) carries `/bin/bash`, which can only ENOENT. A POSIX
 * absolute path is never valid on Windows, so treat it as "no shell chosen"
 * and fall back to this platform's default rather than failing the tile.
 * Anything else — a bare name resolved via PATH, a Windows path — is left
 * alone; the user may genuinely have asked for it.
 */
export function repairShellSpec(
  spec: { cmd: string; args?: string[] },
  platform: Platform = process.platform,
): { cmd: string; args?: string[] } {
  if (platform !== "win32" || !spec.cmd.startsWith("/")) return spec;
  const fallback = defaultShellFor(platform);
  return { cmd: fallback.cmd, args: fallback.args };
}

/**
 * Where an installed `hive` CLI might live, most-likely first.
 *
 * Mirrors what the installers actually do: install.sh symlinks into
 * ~/.local/bin, install.ps1 writes %LOCALAPPDATA%\hivemind\bin. Callers still
 * fall back to a bare PATH lookup when none of these exist.
 */
export function hiveBinCandidates(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: Platform = process.platform,
): string[] {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return [path.join(local, "hivemind", "bin", "hive.exe"), path.join(home, ".hivemind-app", "hive.exe")];
  }
  return [path.join(home, ".local", "bin", "hive"), path.join(home, ".hivemind-app", "hive")];
}

/**
 * Argv that re-runs the official installer for this platform.
 *
 * The in-app updater and `hive upgrade` both shell out to the installer rather
 * than reimplementing download/extract/swap. There is no bash on a stock
 * Windows, so that path uses PowerShell and install.ps1.
 */
export function upgradeCommand(
  repo: string,
  platform: Platform = process.platform,
): { file: string; args: string[] } {
  if (platform === "win32") {
    const url = `https://raw.githubusercontent.com/${repo}/main/install.ps1`;
    return { file: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `irm ${url} | iex`] };
  }
  const url = `https://raw.githubusercontent.com/${repo}/main/install.sh`;
  return { file: "bash", args: ["-c", `curl -fsSL ${url} | bash`] };
}
