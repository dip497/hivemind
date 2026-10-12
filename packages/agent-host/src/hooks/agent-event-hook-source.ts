/**
 * The generic observe hook: every manifest `emit:` entry runs this one script. The canonical
 * event comes from the environment the host put in front of the command; from the agent's
 * payload it keeps only a closed list of ids and counts — never text the agent wrote.
 *
 * Self-contained CommonJS with no dependencies, run as `<exec> hook.cjs <socket>`. It sends
 * one `agent.event` notification (spec/hook-protocol.md) and always exits 0: a missing socket,
 * tile or event, or an unreadable payload, sends nothing (or what it can) and the agent goes on.
 * An entry that answers (`answer:`) then asks the host for the answer and prints it; nothing when
 * there is none.
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
  const lines = [{ jsonrpc: "2.0", method: "agent.event", params: out }];
  // An entry that answers waits for the answer, however long: the agent's own prompt runs meanwhile.
  const answers = ${env("answer")} === "1";
  if (answers) {
    const ask = { callerTile: tileId, hook: e.hook_event_name, tool: e.tool_name, input: e.tool_input };
    if (out.agentId) ask.agentId = out.agentId;
    lines.push({ jsonrpc: "2.0", id: "init", method: "initialize", params: { token: env.HCP_TOKEN || "" } });
    lines.push({ jsonrpc: "2.0", id: "answer", method: "agent.await_answer", params: ask });
  } else {
    const t = setTimeout(fin, 1500); if (t.unref) t.unref();
  }
  try {
    const c = net.connect(sock, () => {
      try { c.write(lines.map((l) => JSON.stringify(l) + "\\n").join("")); } catch (x) {}
      if (!answers) try { c.end(); } catch (x) {}
    });
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\\n")) >= 0) {
        let m = null;
        try { m = JSON.parse(buf.slice(0, nl)); } catch (x) {}
        buf = buf.slice(nl + 1);
        if (!m || m.id !== "answer") continue;
        const said = m.result && m.result.stdout;
        if (settled) return;
        settled = true;
        if (typeof said === "string" && said) process.stdout.write(said, () => done());
        else done();
        return;
      }
    });
    c.on("error", fin);
    c.on("close", fin);
  } catch (x) { fin(); }
});
`;
}
