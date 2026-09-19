// kiro PreToolUse permission broker: asks the supervising agent.
// kiro has no permission prompt of its own, so there is nothing to fall back to: once a
// tool IS brokered, no answer means DENY. Failing open here would let a worker run
// ungated exactly when the supervisor is unreachable, while the caller still believes
// it is supervising. A tool that is not brokered at all is not gated and passes through.
const net = require("net");
function allow() { try { process.exit(0); } catch (e) {} }
// No decision from the supervisor: refuse, and say why, so the worker can report it.
function undecided(why) { deny("Supervising agent did not answer (" + why + ") — denied."); }
function deny(reason) {
  try { process.stderr.write(String(reason || "Denied by supervising agent.")); } catch (e) {}
  try { process.exitCode = 2; } catch (e) {}
  try { process.exit(2); } catch (e) {}
}
const sock = process.argv[2];
const token = process.env.HCP_TOKEN || "";
const tileId = process.env.HIVEMIND_TILE || "";
const sup = (process.env.HIVE_SUPERVISE || "").trim();
if (!sock || !tileId || !sup) { allow(); }
const all = sup === "all";
const set = all ? null : new Set(sup.split(",").map((s) => s.trim()).filter(Boolean));
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("error", () => allow());
process.stdin.on("end", () => {
  let evt = {};
  try { evt = JSON.parse(input); } catch (e) { return allow(); }
  const tool = evt && evt.tool_name;
  if (!tool || (!all && !set.has(tool))) return allow(); // not brokered → don't block
  const toolInput = (evt && evt.tool_input) || {};
  let settled = false;
  const done = (fn) => { if (settled) return; settled = true; fn(); };
  const id = "ap_" + Date.now() + "_" + Math.floor(Math.random() * 1e9);
  // Generous ceiling (< the hook's own timeout): no decision → don't block.
  const t = setTimeout(() => done(() => undecided("timeout")), 9 * 60 * 1000); if (t.unref) t.unref();
  try {
    const c = net.connect(sock, () => {
      try {
        c.write(JSON.stringify({ t: "req", id: id, method: "agent.await_approval", token: token,
          params: { callerTile: tileId, tool_name: tool, tool_input: toolInput } }) + "\n");
      } catch (e) { done(() => undecided("could not ask")); }
    });
    c.setEncoding("utf8");
    let buf = "";
    c.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let msg; try { msg = JSON.parse(line); } catch (e) { continue; }
        if (!msg || msg.t !== "res" || msg.id !== id) continue; // ignore hello/other
        try { c.end(); } catch (e) {}
        if (msg.ok && msg.result) {
          const d = msg.result.decision;
          if (d === "deny") return done(() => deny(msg.result.reason));
          if (d === "allow") return done(allow);
          // "ask" = nobody could decide, and kiro has no prompt to ask at.
          return done(() => undecided("no supervisor decision"));
        }
        return done(() => undecided("malformed reply"));
      }
    });
    c.on("error", () => done(() => undecided("control plane unreachable")));
    c.on("close", () => done(() => undecided("control plane closed")));
  } catch (e) { done(() => undecided("control plane unreachable")); }
});
