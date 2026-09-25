/**
 * Minimal Pty Host inside the main process (v1; later moves into
 * Electron utilityProcess per the VS Code 3-process pattern). Like the daemon, it keeps a
 * headless screen per session, and reads agents' screens there for their fallback status.
 */
import * as pty from "@lydell/node-pty";
import { agentForCmd, envToUnset } from "@hivemind/agents";
import { ScreenWatcher } from "@hivemind/agent-host/screen-status";
import { HeadlessTerminal } from "@hivemind/agent-host/pty-session-manager";
import { resolveWindowsSpawn } from "@hivemind/agents/discover";
import { applyShellEnvToProcess, sanitizeShellEnv } from "@hivemind/agent-host/shell-env";
import { repairShellSpec } from "@hivemind/agent-host/shell-spec";
import { applyInitialPrompt } from "@hivemind/agent-host/initial-prompt";

interface SpawnOpts {
  tileId: string;
  cwd: string;
  cmd: string;
  args?: string[];
  cols: number;
  rows: number;
  env?: Record<string, string>;
  /** Initial task delivered as claude's positional argv (HIVE_INITIAL_PROMPT); consumed by the ptySpawn handler into env. */
  initialPrompt?: string;
}

interface Callbacks {
  onData: (data: string) => void;
  onExit: (code: number, signal: number | undefined) => void;
}

const ptys = new Map<string, pty.IPty>();

const screens = new Map<string, { term: InstanceType<typeof HeadlessTerminal>; cmd: string }>();
let eventSink: ((topic: string, data: unknown) => void) | null = null;
/** Where screen readings go (the same `agent.screen` events a daemon sends). */
export function setDaemonEventSink(fn: (topic: string, data: unknown) => void): void { eventSink = fn; }
const watcher = new ScreenWatcher({
  read: (id) => {
    const s = screens.get(id);
    if (!s) return undefined;
    const buf = s.term.buffer.active;
    const rows: string[] = [];
    for (let y = 0; y < s.term.rows; y++) rows.push(buf.getLine(buf.baseY + y)?.translateToString(true) ?? "");
    return { cmd: s.cmd, screen: rows.join("\n") };
  },
  detect: (cmd, screen) => agentForCmd(cmd)?.detect?.(screen),
  report: (id, state) => eventSink?.("agent.screen", { tileId: id, state }),
});
setInterval(() => watcher.tick(), 1200).unref();
function dropScreen(tileId: string): void {
  screens.get(tileId)?.term.dispose();
  screens.delete(tileId);
  watcher.forget(tileId);
}

export async function spawnPty(
  opts: SpawnOpts,
  cb: Callbacks,
): Promise<{ pid: number }> {
  // Reject duplicate tileId.
  if (ptys.has(opts.tileId)) {
    killPty(opts.tileId);
  }
  // Same belt-and-suspenders as git-adapter: if pty.spawn throws ENOENT (e.g.
  // user clicked "+Claude" before applyShellEnvToProcess() finished), force
  // shell-env resolution then retry once.
  let p: pty.IPty;
  try {
    p = doSpawn(opts);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw e;
    await applyShellEnvToProcess();
    p = doSpawn(opts);
  }
  ptys.set(opts.tileId, p);
  // Only an agent's screen is read; a plain shell keeps none.
  const term = agentForCmd(opts.cmd) ? new HeadlessTerminal({ cols: opts.cols, rows: opts.rows, scrollback: 0, allowProposedApi: true }) : undefined;
  if (term) screens.set(opts.tileId, { term, cmd: opts.cmd });
  p.onData((d: string) => {
    if (term) { term.write(d); watcher.output(opts.tileId); }
    cb.onData(d);
  });
  p.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
    ptys.delete(opts.tileId);
    dropScreen(opts.tileId);
    cb.onExit(exitCode, signal);
  });
  return { pid: p.pid };
}

function doSpawn(opts: SpawnOpts): pty.IPty {
  // Build env with sane defaults for tools that key off them. node-pty already
  // sets TERM via `name`, but COLORTERM (truecolor advertising) and LANG/
  // LC_ALL (UTF-8 locale for unicode glyphs in claude/gh/nvim) are NOT set by
  // node-pty. Fill them only if the parent env didn't already carry a value
  // — never clobber a user-configured locale.
  // What this process inherited is cleaned; what the tile asked for is its own.
  const env: Record<string, string> = {
    ...sanitizeShellEnv({ ...(process.env as Record<string, string>) }, envToUnset()),
    ...(opts.env ?? {}),
  };
  if (!env.COLORTERM) env.COLORTERM = "truecolor";
  if (!env.LANG) env.LANG = "C.UTF-8";
  if (!env.TERM_PROGRAM) env.TERM_PROGRAM = "hivemind";
  // Mirror the daemon: a ▶ Work prompt (HIVE_INITIAL_PROMPT) becomes claude's
  // positional argv (auto-submits) rather than being typed into the booting TUI.
  // A canvas written on another OS can name a shell this one doesn't have.
  const spec = repairShellSpec({ cmd: opts.cmd, args: opts.args });
  const { args: execArgs, env: execEnv } = applyInitialPrompt(spec.args ?? [], env);
  // Last step before the pty: on Windows a bare agent name has to be resolved
  // to its real file (npm shims are .cmd) — spec.cmd itself must stay bare.
  const resolved = resolveWindowsSpawn(spec.cmd, execArgs, execEnv);
  return pty.spawn(resolved.file, resolved.args, {
    cwd: opts.cwd,
    cols: opts.cols,
    rows: opts.rows,
    name: "xterm-256color",
    env: execEnv,
  });
}

/** Whether a live in-process pty exists for this id (HCP dead-tile detection). */
export function hasSession(tileId: string): boolean {
  return ptys.has(tileId);
}
export function writePty(tileId: string, data: string): void {
  const p = ptys.get(tileId);
  if (p) p.write(data);
}

/** In-process path has no persistence — detach == kill (matches today's
 *  behavior where unmounting a tile ends its PTY). The daemon path overrides
 *  this with a real detach that keeps the session alive. */
export function detachPty(tileId: string): void {
  killPty(tileId);
}

/** Renderer back-pressure: stop reading the child's output (it blocks on a
 *  full pty buffer) until resumePty. See TerminalTile's flow-control watermarks. */
export function pausePty(tileId: string): void {
  try { ptys.get(tileId)?.pause(); } catch { /* already gone */ }
}
export function resumePty(tileId: string): void {
  try { ptys.get(tileId)?.resume(); } catch { /* already gone */ }
}

export function resizePty(tileId: string, cols: number, rows: number): void {
  const p = ptys.get(tileId);
  if (p) p.resize(cols, rows);
  screens.get(tileId)?.term.resize(cols, rows);
}

export function killPty(tileId: string): void {
  const p = ptys.get(tileId);
  if (p) {
    try {
      p.kill();
    } catch {
      /* swallow — process may have already exited */
    }
    ptys.delete(tileId);
  }
  dropScreen(tileId);
}

/** Best-effort reap before app quit. Sends SIGHUP (node-pty default), waits
 *  briefly for exit notifications to flush, then escalates anything still
 *  alive to SIGKILL. Without escalation, oh-my-zsh `zshexit` hooks or claude's
 *  signal-trap can stall exit past Electron's before-quit window, leaving
 *  orphaned shells parented to PID 1. */
export function killAll(): void {
  const live: pty.IPty[] = [];
  for (const id of Array.from(ptys.keys())) {
    const p = ptys.get(id);
    if (p) live.push(p);
    killPty(id);
  }
  // Escalate after a short grace period. Synchronous setTimeout — Electron's
  // before-quit doesn't await, so this is fire-and-forget; the OS will reap
  // on process teardown regardless, but SIGKILL guarantees no orphans on
  // session-manager shutdown.
  setTimeout(() => {
    for (const p of live) {
      try { p.kill("SIGKILL"); } catch { /* already gone */ }
    }
  }, 250);
}
