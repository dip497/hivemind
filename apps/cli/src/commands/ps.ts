/** `hive ps` — sessions on a PTY daemon; compact cards below phone width. */
import { defineCommand } from "citty";
import { err, ok } from "../format.js";
import { EXIT } from "../hcp.js";
import { DaemonUnavailable, defaultSocket, listSessions, type SessionInfo } from "../pty-client.js";
import { execOnMachine, loadMachine } from "../remote.js";

export const COMPACT_BELOW = 64;

const home = process.env.HOME ?? "";
// Titles come from whatever runs in the session: keep their control bytes out of this terminal.
// eslint-disable-next-line no-control-regex
const clean = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const tilde = (p: string) => clean(home && p.startsWith(home) ? `~${p.slice(home.length)}` : p);
const what = (s: SessionInfo) => clean(s.title || [s.cmd.split("/").pop(), ...s.args].join(" ").trim() || "?");
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`);

export function renderSessions(list: SessionInfo[], width: number): string {
  if (list.length === 0) return "no sessions — start one with `hive run -- <command>`";
  if (width < COMPACT_BELOW) {
    return list.map((s) => {
      const badge = s.state === "live" ? `live·${s.viewers}` : "frozen";
      return `${clip(clean(s.id), width - badge.length - 1)} ${badge}\n  ${clip(what(s), width - 2)}`;
    }).join("\n");
  }
  const idW = Math.min(40, Math.max(2, ...list.map((s) => s.id.length)));
  const head = `${"ID".padEnd(idW)}  STATE   VIEW  SIZE      WHAT`;
  const rows = list.map((s) => {
    const size = s.cols ? `${s.cols}x${s.rows}` : "-";
    const rest = `${what(s)}  ${tilde(s.cwd)}`;
    return `${clip(clean(s.id), idW).padEnd(idW)}  ${s.state.padEnd(6)}  ${String(s.viewers).padStart(4)}  ${size.padEnd(8)}  ${clip(rest, Math.max(10, width - idW - 30))}`;
  });
  return [head, ...rows].join("\n");
}

export const psCmd = defineCommand({
  meta: { name: "ps", description: "List persistent terminal sessions on this (or a saved) machine" },
  args: {
    machine: { type: "string", description: "saved machine id or label — list over ssh" },
    socket: { type: "string", description: "daemon socket (default: $HIVEMIND_PTY_SOCK or <config>/hivemind/pty-daemon.sock)" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    if (args.machine) {
      try {
        const m = await loadMachine(String(args.machine));
        return execOnMachine(m, ["ps", ...(args.json ? ["--json"] : [])], false);
      } catch (e) { return err(ctx, (e as { code?: string }).code ?? "machine_error", (e as Error).message); }
    }
    const sock = String(args.socket || defaultSocket());
    try {
      const sessions = await listSessions(sock);
      return ok(ctx, { socket: sock, sessions }, () => renderSessions(sessions, process.stdout.columns || 100));
    } catch (e) {
      if (e instanceof DaemonUnavailable) return err(ctx, "daemon_unavailable", e.message, EXIT.unavailable);
      return err(ctx, "ps_failed", (e as Error).message);
    }
  },
});
