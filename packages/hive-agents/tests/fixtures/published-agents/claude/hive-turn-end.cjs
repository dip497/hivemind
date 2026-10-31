// Claude's Stop: hand the host this turn's reply, then report the turn end.
let hive;
try { hive = require(process.env.HIVE_SDK); } catch (e) { process.exit(0); }
(async () => {
  const p = await hive.payload();
  if (typeof p.last_assistant_message === "string" && p.last_assistant_message) await hive.reportReply(p.last_assistant_message);
  // Background tasks the turn left running — counts, never their commands.
  const tasks = Array.isArray(p.background_tasks) ? p.background_tasks : [];
  const running = tasks.filter((t) => t && t.status === "running").length;
  // Those that wake Claude when they finish. A shell or a monitor may run for as long as it likes,
  // and a teammate is running while it sits idle, so Claude waits on none of them.
  const awaiting = tasks.filter((t) => t && (t.status === "running" || t.status === "pending") && ["subagent", "workflow", "cloud session", "MCP task"].includes(t.type)).length;
  await hive.emit("turn.ended", { ...(running ? { background: running } : {}), ...(awaiting ? { awaiting } : {}) });
})().catch(() => {}).finally(() => process.exit(0));
