/**
 * The generic observe hook: every manifest `emit:` entry runs this one script. The canonical
 * event comes from the environment the host put in front of the command; what it says is
 * `hookLines` (hook-lines.ts), whose source it carries.
 *
 * Self-contained CommonJS with no dependencies, run as `<exec> hook.cjs <socket>`. It sends
 * one `agent.event` notification (spec/hook-protocol.md) and always exits 0: a missing socket,
 * tile or event, or an unreadable payload, sends nothing (or what it can) and the agent goes on.
 * An entry that answers (`answer:`) then asks the host for the answer and prints it; nothing when
 * there is none.
 */
import { EVENT_ENV } from "@hivemind/agents";
import { answerIn, hookLines } from "./hook-lines.js";

export function agentEventHookSource(): string {
  const env = (k: keyof typeof EVENT_ENV) => `env[${JSON.stringify(EVENT_ENV[k])}]`;
  return `// Written by the hivemind host: reports one canonical agent event.
const net = require("net");
const hookLines = (${hookLines.toString()});
const answerIn = (${answerIn.toString()});
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
  // An entry that answers waits for the answer, however long: the agent's own prompt runs meanwhile.
  const answers = ${env("answer")} === "1";
  const lines = hookLines({ event: name, kind: ${env("kind")}, outcome: ${env("outcome")}, answer: answers, reply: ${env("reply")} }, tileId, env.HCP_TOKEN || "", e);
  let settled = false;
  const fin = () => { if (settled) return; settled = true; done(); };
  if (!answers) { const t = setTimeout(fin, 1500); if (t.unref) t.unref(); }
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
        const said = answerIn(m);
        if (said === undefined || settled) continue;
        settled = true;
        if (said) process.stdout.write(said, () => done());
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
