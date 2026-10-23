/**
 * Whose a session's terminal is: the program the session started, or a command that program ran.
 * A shell gives each command it runs a process group of its own and hands that group the terminal
 * (`sudo`, `cp -i`, `curl`), and takes it back at its prompt; a program that is no shell keeps what
 * it runs in its own group, so an agent holds its terminal while its tools run. A tile's last line
 * (screen-status.ts) shows the question a command waits on, and passes over the shell's prompt.
 * Linux only, where /proc says which group the terminal is with.
 */
import fs from "node:fs";

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
