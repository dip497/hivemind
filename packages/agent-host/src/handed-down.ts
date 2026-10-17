/**
 * What a daemon gets from whoever starts it besides its stdio: each descriptor of the starter not
 * marked close-on-exec (a test runner's pipe, a browser's sockets). The daemon outlives its
 * starter, so holding them keeps the starter's pipes and sockets open after it is gone; it closes
 * them first. The starter names them, since a process cannot tell an inherited descriptor from one
 * its runtime opened: its pipes and sockets, whose names (`pipe:[<inode>]`) are theirs alone, so a
 * descriptor of that name here is the one handed down. Linux only, where /proc says which they are.
 */
import fs from "node:fs";

/** The env var the starter names them in. */
export const HANDED_DOWN = "HIVEMIND_HANDED_DOWN";

const CLOEXEC = 0o2000000;
const PIPE_OR_SOCKET = /^(pipe|socket):\[\d+\]$/;

/** This process's descriptors a child it starts now gets, as `[fd, what it is]` in JSON; empty
 *  where /proc is not. */
export function handedDown(): string {
  if (process.platform !== "linux") return "";
  let fds: string[];
  try {
    fds = fs.readdirSync("/proc/self/fd");
  } catch {
    return "";
  }
  const out: Array<[number, string]> = [];
  for (const fd of fds.map(Number)) {
    if (fd <= 2) continue;
    try {
      const flags = /^flags:\s*([0-7]+)$/m.exec(fs.readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"))?.[1];
      if (flags === undefined || parseInt(flags, 8) & CLOEXEC) continue;
      const what = fs.readlinkSync(`/proc/self/fd/${fd}`);
      if (PIPE_OR_SOCKET.test(what)) out.push([fd, what]);
    } catch {
      /* closed meanwhile */
    }
  }
  return out.length ? JSON.stringify(out) : "";
}

/** Close each descriptor `named` (as `handedDown` gave it) that is still that pipe or socket here,
 *  so none of this process's own is ever closed. */
export function dropHandedDown(named: string | undefined): void {
  if (!named) return;
  let list: unknown;
  try {
    list = JSON.parse(named);
  } catch {
    return;
  }
  if (!Array.isArray(list)) return;
  for (const entry of list) {
    if (!Array.isArray(entry) || !Number.isInteger(entry[0]) || entry[0] <= 2 || typeof entry[1] !== "string" || !PIPE_OR_SOCKET.test(entry[1])) continue;
    try {
      if (fs.readlinkSync(`/proc/self/fd/${entry[0]}`) === entry[1]) fs.closeSync(entry[0]);
    } catch {
      /* not open here */
    }
  }
}
