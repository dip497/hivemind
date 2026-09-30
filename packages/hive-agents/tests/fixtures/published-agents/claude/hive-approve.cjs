// Claude's PreToolUse on a supervised worker: ask the agent that spawned it.
// No answer prints nothing, so Claude falls back to its own permission prompt — never a silent allow.
function out(o) { try { if (o) process.stdout.write(JSON.stringify(o)); } catch (e) {} process.exit(0); }
const decide = (d, reason) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: d, ...(reason ? { permissionDecisionReason: reason } : {}) } });
let hive;
try { hive = require(process.env.HIVE_SDK); } catch (e) { out(null); }
(async () => {
  const sup = (process.env.HIVE_SUPERVISE || "").trim();
  if (!sup) return out(null);
  const p = await hive.payload();
  const tool = typeof p.tool_name === "string" ? p.tool_name : "";
  const brokered = sup === "all" || sup.split(",").map((s) => s.trim()).includes(tool);
  if (!tool || !brokered) return out(null);
  const r = await hive.requestApproval({ tool: tool, input: p.tool_input || {} });
  if (r.decision === "allow") return out(decide("allow"));
  if (r.decision === "deny") return out(decide("deny", r.reason || "Denied by supervising agent."));
  out(null);
})().catch(() => out(null));
