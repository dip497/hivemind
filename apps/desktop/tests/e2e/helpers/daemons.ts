// The terminal daemons a test's profiles started, stopped by their pid: each serves a socket inside
// its profile, so `under` (a test's own folder, or the temp dir for the whole suite) names them and
// never the daemon of the app someone is using, whose socket is in their home.
import fs from "node:fs";
import path from "node:path";

/** Stop the daemons serving a socket under `under`. The apps that used them close first: an app
 *  that finds its daemon gone starts another. */
export function stopDaemons(under: string): void {
  const root = path.resolve(under) + path.sep;
  for (const pid of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    let argv: string[];
    try { argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"); } catch { continue; }
    // The app's (built) or the dev bridge's (from source).
    if (!argv.some((a) => /pty-daemon\.(js|ts)$/.test(a)) || !argv.some((a) => a.startsWith(root))) continue;
    try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ }
  }
}
