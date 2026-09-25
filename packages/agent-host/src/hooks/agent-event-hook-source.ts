/**
 * The generic observe hook: every manifest `emit:` entry runs this one script. The canonical
 * event comes from the environment the host put in front of the command; from the agent's
 * payload it keeps only a closed list of ids and counts — never text the agent wrote.
 *
 * Self-contained CommonJS with no dependencies, run as `<exec> hook.cjs <socket>`. It sends
 * one `agent.event` notification (spec/hook-protocol.md) and always exits 0: a missing socket,
 * tile or event, or an unreadable payload, sends nothing (or what it can) and the agent goes on.
 */
import { EVENT_ENV } from "@hivemind/agents";

export function agentEventHookSource(): string {
  const env = (k: keyof typeof EVENT_ENV) => `env[${JSON.stringify(EVENT_ENV[k])}]`;
  return `// Written by the hivemind host: reports one canonical agent event.
const net = require("net");
function done() { try { process.exit(0); } catch (e) {} }
const env = process.env;
const sock = process.argv[2];
const tileId = env.HIVEMIND_TILE || "";
const name = ${env("event")} || "";
if (!sock || !tileId || !name) { done(); }
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("error", () => done());
process.stdin.on("end", () => {
  let e = {};
  try { e = JSON.parse(input) || {}; } catch (x) {}
  const out = { tileId: tileId, event: name };
  if (${env("outcome")}) out.outcome = ${env("outcome")};
  if (${env("kind")}) out.kind = ${env("kind")};
  if (e.agent_id != null) out.agentId = String(e.agent_id);
  if (typeof e.session_id === "string") out.sessionId = e.session_id;
  if (Array.isArray(e.background_tasks)) {
    const running = e.background_tasks.filter((t) => t && t.status === "running").length;
    if (running > 0) out.background = running;
  }
  let settled = false;
  const fin = () => { if (settled) return; settled = true; done(); };
  const t = setTimeout(fin, 1500); if (t.unref) t.unref();
  try {
    const c = net.connect(sock, () => {
      try { c.write(JSON.stringify({ jsonrpc: "2.0", method: "agent.event", params: out }) + "\\n"); } catch (x) {}
      try { c.end(); } catch (x) {}
    });
    c.on("error", fin);
    c.on("close", fin);
  } catch (x) { fin(); }
});
`;
}
