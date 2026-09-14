/** `hive run -- <command…>` — a persistent session anyone can `hive attach` to later; starts the daemon if needed. */
import { defineCommand } from "citty";
import { randomBytes } from "node:crypto";
import { err, ok } from "../format.js";
import { EXIT } from "../hcp.js";
import { connect, DaemonUnavailable, defaultSocket, listSessions } from "../pty-client.js";
import type { ServerMsg } from "../../../desktop/src/main/pty-protocol.js";
import { execOnMachine, loadMachine } from "../remote.js";
import { attachLoop } from "./attach.js";
import { checkSocketPath, daemonUnsupported, ensureDaemon } from "./daemon.js";

const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** citty keeps everything after `--` in `args._`. */
function commandOf(rest: unknown): string[] {
  return Array.isArray(rest) ? rest.map(String) : [];
}

export const runCmd = defineCommand({
  meta: { name: "run", description: "Start a persistent session: hive run [--attach] -- <command…>" },
  args: {
    cwd: { type: "string", description: "working directory (default: current)" },
    id: { type: "string", description: "session id (default: run-<random>)" },
    attach: { type: "boolean", description: "attach to it right away (ctrl-b d detaches)" },
    machine: { type: "string", description: "saved machine id or label — start it there over ssh" },
    socket: { type: "string", description: "daemon socket (default: $HIVEMIND_PTY_SOCK or <config>/hivemind/pty-daemon.sock)" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const cmd = commandOf(args._);
    if (cmd.length === 0) return err(ctx, "usage", "nothing to run — `hive run -- <command…>`", EXIT.usage);
    const id = String(args.id || `run-${randomBytes(3).toString("hex")}`);
    if (!ID_RE.test(id)) return err(ctx, "usage", `session id '${id}' may only use letters, digits and . _ : -`, EXIT.usage);

    if (args.machine) {
      try {
        const m = await loadMachine(String(args.machine));
        const fwd = ["run", "--id", id, ...(args.cwd ? ["--cwd", String(args.cwd)] : []), ...(args.attach ? ["--attach"] : []), ...(args.json ? ["--json"] : []), "--", ...cmd];
        return execOnMachine(m, fwd, !!args.attach);
      } catch (e) { return err(ctx, (e as { code?: string }).code ?? "machine_error", (e as Error).message); }
    }

    const sock = String(args.socket || defaultSocket());
    const bad = checkSocketPath(sock);
    if (bad) return err(ctx, "socket_invalid", bad, EXIT.usage);
    const unsupported = daemonUnsupported();
    if (unsupported) return err(ctx, "daemon_unsupported", unsupported, EXIT.unavailable);
    try {
      await ensureDaemon(sock);
      if ((await listSessions(sock)).some((s) => s.id === id)) return err(ctx, "session_exists", `session '${id}' already exists — \`hive attach ${id}\``);
      const c = await connect(sock);
      const cols = process.stdout.columns || 120;
      const rows = process.stdout.rows || 40;
      c.send({ t: "attach", reqId: "run", id, spec: { cwd: String(args.cwd || process.cwd()), cmd: cmd[0]!, args: cmd.slice(1), cols, rows } });
      const r = await c.next((m): m is Extract<ServerMsg, { t: "attached" }> => m.t === "attached", 15_000);
      // Detach, not kill: it keeps running for whoever attaches next.
      c.send({ t: "detach", id });
      c.close();
      if (r.error || r.pid < 0) return err(ctx, "run_failed", r.error ?? `could not start '${cmd.join(" ")}'`);
      if (args.attach) process.exit(await attachLoop(sock, id));
      return ok(ctx, { id, pid: r.pid, socket: sock }, () => `${id}  (pid ${r.pid}) — \`hive attach ${id}\``);
    } catch (e) {
      if (e instanceof DaemonUnavailable) return err(ctx, "daemon_unavailable", e.message, EXIT.unavailable);
      return err(ctx, "run_failed", (e as Error).message);
    }
  },
});
