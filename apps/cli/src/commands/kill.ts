/** `hive kill <session>` — end a session and its process (a detached session otherwise runs until it exits). */
import { defineCommand } from "citty";
import { err, ok } from "../format.js";
import { EXIT } from "../hcp.js";
import { connect, DaemonUnavailable, defaultSocket, listSessions, resolveSession, SessionRefError } from "../pty-client.js";
import { execOnMachine, loadMachine } from "../remote.js";

export const killCmd = defineCommand({
  meta: { name: "kill", description: "End a session and its process" },
  args: {
    session: { type: "positional", required: true, description: "session id or unique prefix (see `hive ps`)" },
    machine: { type: "string", description: "saved machine id or label — kill it there over ssh" },
    socket: { type: "string", description: "daemon socket (default: $HIVEMIND_PTY_SOCK or <config>/hivemind/pty-daemon.sock)" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    if (args.machine) {
      try {
        const m = await loadMachine(String(args.machine));
        return execOnMachine(m, ["kill", String(args.session), ...(args.json ? ["--json"] : [])], false);
      } catch (e) { return err(ctx, (e as { code?: string }).code ?? "machine_error", (e as Error).message); }
    }
    const sock = String(args.socket || defaultSocket());
    try {
      const s = resolveSession(await listSessions(sock), String(args.session));
      const c = await connect(sock);
      c.send({ t: "kill", id: s.id });
      c.close();
      return ok(ctx, { id: s.id, killed: true }, () => `killed ${s.id}`);
    } catch (e) {
      if (e instanceof DaemonUnavailable) return err(ctx, "daemon_unavailable", e.message, EXIT.unavailable);
      if (e instanceof SessionRefError) return err(ctx, e.code, e.message, e.code === "session_not_found" ? EXIT.notFound : EXIT.error);
      return err(ctx, "kill_failed", (e as Error).message);
    }
  },
});
