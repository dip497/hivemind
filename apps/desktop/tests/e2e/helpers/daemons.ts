// The terminal daemons a test's profiles started, stopped by their pid: each serves a socket inside
// its profile, so `under` (a test's own folder) names them and never the daemon of an app someone
// is using, whose socket may be anywhere, the temp dir too.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Every process here, its pid and its argv: from /proc where there is one, else from `ps` (a Mac),
 *  whose argv is its command line split at spaces. */
function* processes(): Generator<{ pid: number; argv: string[] }> {
  if (!fs.existsSync("/proc")) {
    for (const line of execFileSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8" }).split("\n")) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (m) yield { pid: Number(m[1]), argv: m[2]!.split(" ") };
    }
    return;
  }
  for (const pid of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try { yield { pid: Number(pid), argv: fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0") }; } catch { continue; }
  }
}

/** Every terminal daemon here, its pid and its argv: the app's (built) or the dev bridge's (from source). */
function* daemons(): Generator<{ pid: number; argv: string[] }> {
  for (const p of processes()) if (p.argv.some((a) => /pty-daemon\.(js|ts)$/.test(a))) yield p;
}

/** What `pid` was started with in its environment, NAME=value each. */
function environment(pid: number): string[] {
  if (!fs.existsSync("/proc")) {
    const shown = process.platform === "darwin" ? ["-E", "-ww"] : ["eww"];
    return execFileSync("ps", [...shown, "-o", "command=", "-p", String(pid)], { encoding: "utf8" }).split(/\s+/);
  }
  return fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
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
    try { env = environment(d.pid); } catch { continue; }
    if (env.includes(mark)) stop(d.pid);
  }
}
