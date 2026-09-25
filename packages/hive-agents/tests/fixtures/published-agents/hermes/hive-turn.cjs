// Hermes's turn end, in two hooks: post_llm_call carries the reply, on_session_end (once per
// turn, despite the name) says how the turn ended.
let hive;
try { hive = require(process.env.HIVE_SDK); } catch (e) { process.exit(0); }

(async () => {
  const p = await hive.payload();
  const extra = p.extra && typeof p.extra === "object" ? p.extra : {};
  if (p.hook_event_name === "post_llm_call") {
    if (typeof extra.assistant_response === "string" && extra.assistant_response) await hive.reportReply(extra.assistant_response);
    return;
  }
  if (p.hook_event_name === "on_session_end") {
    const outcome = extra.interrupted ? "interrupted" : extra.failed ? "failed" : "done";
    await hive.emit("turn.ended", { outcome });
  }
})().catch(() => {}).finally(() => process.stdout.write("{}\n", () => process.exit(0)));
