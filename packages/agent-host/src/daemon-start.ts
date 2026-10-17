/**
 * Starting the PTY daemon, and reaching it: the one way the app, `hive daemon` and the dev bridge
 * bring one up. It outlives its starter, so it is started detached, in a cgroup scope of its own
 * where the starter's would take it down with it, and holding none of the starter's pipes
 * (`handed-down.ts`).
 */
import net from "node:net";
import { readFileSync } from "node:fs";
import { spawn, spawnSync, type StdioOptions } from "node:child_process";
import { HANDED_DOWN, handedDown } from "./handed-down.js";

// GNOME / systemd desktops launch an app inside a transient `app-gnome-<name>-<pid>.scope` cgroup
// whose default `KillMode=control-group` ends EVERY process in it when the app closes. `detached`
// (setsid) leaves the process group and the controlling terminal, not the cgroup, so the daemon
// is put in a scope of its own (`systemd-run --user --scope`, which keeps our env and cwd).
function cgroupEscapePrefix(): string[] {
  if (process.platform !== "linux" || !process.env.XDG_RUNTIME_DIR) return [];
  let cg = "";
  try { cg = readFileSync("/proc/self/cgroup", "utf8"); } catch { return []; }
  if (!/app-[^/\n]*\.scope/.test(cg)) return [];
  if (spawnSync("systemd-run", ["--version"], { stdio: "ignore" }).status !== 0) return [];
  return ["systemd-run", "--user", "--scope", "--quiet", "--collect"];
}

/** Start the daemon `command` (its argv), to outlive this process. */
export function startDaemon(command: readonly string[], o: { env?: NodeJS.ProcessEnv; stdio?: StdioOptions } = {}): void {
  const [file, ...args] = [...cgroupEscapePrefix(), ...command];
  const child = spawn(file!, args, { env: { ...(o.env ?? process.env), [HANDED_DOWN]: handedDown() }, detached: true, stdio: o.stdio ?? "ignore" });
  child.unref();
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms).unref?.());

function connect(sock: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(sock);
    const failed = (e: Error) => { s.destroy(); reject(e); };
    s.once("error", failed);
    s.once("connect", () => { s.removeListener("error", failed); resolve(s); });
  });
}

/** A connection to the daemon at `sock`, started with `command` when none answers there. */
export async function reachDaemon(sock: string, command: readonly string[], o: { env?: NodeJS.ProcessEnv } = {}): Promise<net.Socket> {
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      return await connect(sock);
    } catch {
      if (attempt === 0) startDaemon(command, o);
      await delay(120);
    }
  }
  throw new Error(`the terminal daemon did not answer on ${sock}`);
}
