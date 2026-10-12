// The terminal daemons a test's profiles started, stopped by their pid: each serves a socket inside
// its profile, so `under` (a test's own folder) names them and never the daemon of an app someone
// is using, whose socket may be anywhere, the temp dir too.
import fs from "node:fs";
import path from "node:path";

/** Every terminal daemon here, its pid and its argv: the app's (built) or the dev bridge's (from source). */
function* daemons(): Generator<{ pid: number; argv: string[] }> {
  for (const pid of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    let argv: string[];
    try { argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"); } catch { continue; }
    if (argv.some((a) => /pty-daemon\.(js|ts)$/.test(a))) yield { pid: Number(pid), argv };
  }
}

const stop = (pid: number) => { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } };

/** Stop the daemons serving a socket under `under`. The apps that used them close first: an app
 *  that finds its daemon gone starts another. */
export function stopDaemons(under: string): void {
  const root = path.resolve(under) + path.sep;
  for (const d of daemons()) if (d.argv.some((a) => a.startsWith(root))) stop(d.pid);
}

/** Stop the daemons the e2e run `run` (its HIVEMIND_E2E_XDG) started, wherever their sockets are:
 *  each inherited the run's mark from the app that started it. */
export function stopRunDaemons(run: string): void {
  const mark = `HIVEMIND_E2E_XDG=${run}`;
  for (const d of daemons()) {
    let env: string[];
    try { env = fs.readFileSync(`/proc/${d.pid}/environ`, "utf8").split("\0"); } catch { continue; }
    if (env.includes(mark)) stop(d.pid);
  }
}
