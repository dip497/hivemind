/** Which release an installed app is, by the folder it runs from. */

/** The release this app runs, as the folder it runs from names it: `versions/<tag>/` (Linux) or
 *  `app-<version>` (Windows), each version a folder of its own; else this build's version. */
export function runningRelease(execPath: string, current: string): string {
  const parts = execPath.split(/[\\/]/);
  const at = parts.lastIndexOf("versions");
  if (at >= 0 && parts[at + 1]) return parts[at + 1]!;
  const win = parts.find((p) => p.startsWith("app-"))?.slice("app-".length);
  if (win) return /^\d/.test(win) ? `v${win}` : win;
  return `v${current}`;
}

/** The folder install.ps1 unpacks release `tag` into. */
export function windowsAppFolder(tag: string): string {
  return `app-${tag.replace(/^v/, "")}`;
}
