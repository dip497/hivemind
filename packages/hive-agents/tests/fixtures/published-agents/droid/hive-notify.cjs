// Droid's Notification: the two that mean "needs you". Idle and auth notices are not status.
let hive;
try { hive = require(process.env.HIVE_SDK); } catch (e) { process.exit(0); }
const KIND = { permission_prompt: "permission", elicitation_dialog: "question" };
(async () => {
  const p = await hive.payload();
  const kind = KIND[p.notification_type];
  if (kind) await hive.emit("input.requested", { kind: kind });
})().catch(() => {}).finally(() => process.exit(0));
