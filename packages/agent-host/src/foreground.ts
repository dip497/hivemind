/**
 * Whose a session's terminal is: the program the session started, or a command that program ran.
 * A shell gives each command it runs a process group of its own and hands that group the terminal
 * (`sudo`, `cp -i`, `curl`), and takes it back at its prompt; a program that is no shell keeps what
 * it runs in its own group, so an agent holds its terminal while its tools run. A tile's last line
 * (screen-status.ts) shows the question a command waits on, and passes over the shell's prompt.
 * Linux reads it from /proc; macOS from the name of the terminal's foreground group's leader, which
 * the pty tells; Windows cannot tell.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** The longest name the kernel keeps for a process on macOS (`MAXCOMLEN`). */
const COMM_MAX = 16;

/**
 * Whether process `pid` (a session's program, which its pty made a group's leader) holds its
 * terminal: the terminal's foreground group (field 8 of /proc's `stat`, `tpgid`) is its own (field 5,
 * `pgrp`). Undefined where that cannot be told: on another system, or once the process is gone.
 * One read of a few hundred bytes of /proc.
 */
export function holdsTerminal(pid: number): boolean | undefined {
  if (process.platform !== "linux") return undefined;
  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, "latin1");
  } catch {
    return undefined;
  }
  // The fields after the program's name, which is in parentheses and may hold spaces and parentheses.
  const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return f[5] === undefined ? undefined : f[5] === f[2];
}

/**
 * How a session's terminal is told to be its own program's, for the pty `p` that runs it.
 *
 * macOS has no /proc. Its pty says the name of the process that leads the terminal's foreground
 * group (node-pty's `process`: `tcgetpgrp` on the pty, then `sysctl`), a few microseconds. While the
 * session's own program holds the terminal, that leader is the program itself, so the names are the
 * same; a command the shell runs leads a group of its own, under its own name. The program's own
 * name is asked of `ps` once, the first time it is wanted, after the pty's helper has made way for
 * it: until `ps` answers, and if it cannot, that cannot be told. A shell that runs another of itself
 * (`zsh` in `zsh`) is taken to hold its terminal.
 */
export function terminalHolder(p: { readonly pid: number; readonly process: string }): () => boolean | undefined {
  if (process.platform === "linux") return () => holdsTerminal(p.pid);
  if (process.platform !== "darwin") return () => undefined;
  let own: string | null | undefined;
  return () => {
    if (own === undefined) {
      own = null;
      // `ucomm` is the kernel's name for the process, as `sysctl` gives it (at most 16 characters).
      execFile("ps", ["-o", "ucomm=", "-p", String(p.pid)], { timeout: 5000 }, (err, out) => {
        own = err ? null : out.trim() || null;
      });
    }
    if (!own) return undefined;
    let leader: string;
    try { leader = p.process; } catch { return undefined; }
    if (!leader || leader === "spawn_helper" || leader === "kernel_task") return undefined;
    // Where the leader cannot be read, node-pty names the file it started, as a path.
    return path.basename(leader).slice(0, COMM_MAX) === own;
  };
}
