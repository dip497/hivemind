// Claude's PreToolUse(ExitPlanMode): open the plan beside the tile and wait for the person.
// Fails open: with no review UI the plan proceeds as if this hook were not installed.
const ALLOW = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
function out(o) { try { process.stdout.write(JSON.stringify(o)); } catch (e) {} process.exit(0); }
let hive;
try { hive = require(process.env.HIVE_SDK); } catch (e) { out(ALLOW); }
(async () => {
  const p = await hive.payload();
  const plan = p.tool_input && p.tool_input.plan;
  if (typeof plan !== "string" || !plan) return out(ALLOW);
  const r = await hive.openPlanReview({ plan: plan, cwd: typeof p.cwd === "string" ? p.cwd : process.cwd() });
  if (r && r.decision === "deny") {
    return out({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: r.feedback || "Changes requested." } });
  }
  out(ALLOW);
})().catch(() => out(ALLOW));
