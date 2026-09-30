// kiro PreToolUse permission broker: asks the supervising agent.
// kiro has no permission prompt of its own, so there is nothing to fall back to: once a
// tool IS brokered, no answer means DENY. Failing open here would let a worker run
// ungated exactly when the supervisor is unreachable, while the caller still believes
// it is supervising. A tool that is not brokered at all is not gated and passes through.
function allow() { process.exit(0); }
function deny(reason) {
  try { process.stderr.write(String(reason || "Denied by supervising agent.")); } catch (e) {}
  process.exit(2);
}
const sup = (process.env.HIVE_SUPERVISE || "").trim();
if (!sup) allow();
let hive;
try { hive = require(process.env.HIVE_SDK); } catch (e) { deny("Supervising agent did not answer (no control plane) — denied."); }
(async () => {
  if (!hive.tile) return allow();
  const p = await hive.payload();
  const tool = typeof p.tool_name === "string" ? p.tool_name : "";
  const brokered = sup === "all" || sup.split(",").map((s) => s.trim()).includes(tool);
  if (!tool || !brokered) return allow();
  const r = await hive.requestApproval({ tool: tool, input: p.tool_input || {} });
  if (r.decision === "allow") return allow();
  if (r.decision === "deny") return deny(r.reason);
  deny("Supervising agent did not answer — denied.");
})().catch(() => deny("Supervising agent did not answer — denied."));
