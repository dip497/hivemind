/** `hive attach <session>` — one more viewer of a session. Detach: ctrl-b d; literal ctrl-b: ctrl-b ctrl-b. */
import { defineCommand } from "citty";
import { err } from "../format.js";
import { EXIT } from "../hcp.js";
import { connect, DaemonUnavailable, defaultSocket, listSessions, resolveSession, SessionRefError } from "../pty-client.js";
import type { ServerMsg } from "../../../desktop/src/main/pty-protocol.js";
import { execOnMachine, loadMachine } from "../remote.js";

const PREFIX = 0x02; // ctrl-b

/** Modes a TUI may have left on in this terminal (alt screen, cursor, mouse, paste). */
const RESET = "\x1b[?1049l\x1b[?25h\x1b[0m\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\r\n";

/** `pending` carries a ctrl-b across reads. */
export function routeKeys(chunk: Buffer, pending: boolean): { send: Buffer; detach: boolean; pending: boolean } {
  const out: number[] = [];
  for (let i = 0; i < chunk.length; i++) {
    const b = chunk[i]!;
    if (pending) {
      pending = false;
      if (b === 0x64 /* d */) return { send: Buffer.from(out), detach: true, pending: false };
      if (b === PREFIX) { out.push(PREFIX); continue; }
      out.push(PREFIX, b); // not a binding — pass both through
      continue;
    }
    if (b === PREFIX) { pending = true; continue; }
    out.push(b);
  }
  return { send: Buffer.from(out), detach: false, pending };
}

export async function attachLoop(sock: string, id: string, opts: { readOnly?: boolean; size?: { cols: number; rows: number } } = {}): Promise<number> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const termSize = () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 });
  const c = await connect(sock);
  // Read-only attaches at the current size so it never takes the size from whoever is working.
  const size = opts.readOnly && opts.size ? opts.size : termSize();
  c.send({ t: "attach", reqId: "attach", id, noSpawn: true, spec: { cwd: "/", cmd: "", args: [], ...size } });
  const attached = await c.next((m): m is Extract<ServerMsg, { t: "attached" }> => m.t === "attached", 10_000);
  if (attached.error || attached.pid < 0) { c.close(); throw new SessionRefError("attach_failed", attached.error ?? `could not attach to '${id}'`); }

  return new Promise<number>((resolve) => {
    let pending = false;
    let done = false;
    const raw = stdin.isTTY && !opts.readOnly;
    const finish = (code: number, note: string) => {
      if (done) return;
      done = true;
      process.off("SIGWINCH", onWinch);
      stdin.off("data", onKeys);
      if (raw) stdin.setRawMode(false);
      stdin.pause();
      stdout.write(RESET);
      if (note) process.stderr.write(`${note}\n`);
      c.close();
      resolve(code);
    };
    const onWinch = () => { if (!opts.readOnly) { const s = termSize(); c.send({ t: "resize", id, ...s }); } };
    const onKeys = (d: Buffer) => {
      const r = routeKeys(d, pending);
      pending = r.pending;
      if (!opts.readOnly && r.send.length) c.send({ t: "write", id, data: r.send.toString("utf8") });
      if (r.detach) { c.send({ t: "detach", id }); finish(0, `[detached from ${id}]`); }
    };
    c.onMessage((m) => {
      if (m.t === "data" && m.id === id) stdout.write(m.data);
      else if (m.t === "exit" && m.id === id) finish(m.code, `[${id} exited with ${m.code}]`);
    });
    c.onClose(() => finish(EXIT.unavailable, "[daemon connection lost — the session keeps running; attach again]"));
    stdout.write(attached.replay);
    if (raw) stdin.setRawMode(true);
    stdin.on("data", onKeys);
    stdin.resume();
    process.on("SIGWINCH", onWinch);
    if (opts.readOnly) {
      // Not raw here, so ctrl-c arrives as SIGINT.
      process.once("SIGINT", () => finish(0, `[left ${id}]`));
      process.stderr.write(`[read-only view of ${id} — ctrl-c to leave]\r\n`);
    }
  });
}

export const attachCmd = defineCommand({
  meta: { name: "attach", description: "View and type into a running session (ctrl-b d detaches)" },
  args: {
    session: { type: "positional", required: true, description: "session id or unique prefix (see `hive ps`)" },
    machine: { type: "string", description: "saved machine id or label — attach over ssh" },
    socket: { type: "string", description: "daemon socket (default: $HIVEMIND_PTY_SOCK or <config>/hivemind/pty-daemon.sock)" },
    "read-only": { type: "boolean", description: "watch only: no input, never changes the size" },
  },
  async run({ args }) {
    const ctx = { json: false };
    if (args.machine) {
      try {
        const m = await loadMachine(String(args.machine));
        return execOnMachine(m, ["attach", String(args.session), ...(args["read-only"] ? ["--read-only"] : [])], true);
      } catch (e) { return err(ctx, (e as { code?: string }).code ?? "machine_error", (e as Error).message); }
    }
    const sock = String(args.socket || defaultSocket());
    try {
      const s = resolveSession(await listSessions(sock), String(args.session));
      const code = await attachLoop(sock, s.id, { readOnly: !!args["read-only"], size: { cols: s.cols, rows: s.rows } });
      process.exit(code);
    } catch (e) {
      if (e instanceof DaemonUnavailable) return err(ctx, "daemon_unavailable", e.message, EXIT.unavailable);
      if (e instanceof SessionRefError) return err(ctx, e.code, e.message, e.code === "session_not_found" ? EXIT.notFound : EXIT.error);
      return err(ctx, "attach_failed", (e as Error).message);
    }
  },
});
