export type Platform = NodeJS.Platform;

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
