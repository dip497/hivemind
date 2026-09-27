// Faux's Stop: hand the host this turn's reply, then report the turn end.
let hive;
try { hive = require(process.env.HIVE_SDK); } catch (e) { process.exit(0); }
(async () => {
  const p = await hive.payload();
  if (typeof p.last_assistant_message === "string" && p.last_assistant_message) await hive.reportReply(p.last_assistant_message);
  // Background shells the turn left running — a count, never their commands.
  const running = Array.isArray(p.background_tasks) ? p.background_tasks.filter((t) => t && t.status === "running").length : 0;
  await hive.emit("turn.ended", running ? { background: running } : {});
})().catch(() => {}).finally(() => process.exit(0));
