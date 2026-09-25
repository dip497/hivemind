// OpenCode's session events as the host's: loaded into OpenCode through OPENCODE_CONFIG, it
// reports turns, replies, questions and subagents with the host's SDK. Inert outside a tile.
import { createRequire } from "node:module";

export const HivePlugin = async () => {
  let hive;
  try { hive = createRequire(import.meta.url)(process.env.HIVE_SDK); } catch { return {}; }
  if (!hive.tile) return {};

  // In order and off OpenCode's event loop: a reply must reach the host before its turn ends.
  let queue = Promise.resolve();
  const send = (fn) => { queue = queue.then(fn).catch(() => {}); };

  const subagents = new Set(); // sessions a task started; their turns are not the tile's
  const parts = new Map(); // messageID -> (partID -> text)
  let lastAssistant = "";
  let working = false;
  let outcome = "done";

  const replyText = () => [...(parts.get(lastAssistant)?.values() ?? [])].join("").trim();

  return {
    event: async ({ event }) => {
      const p = event.properties ?? {};
      const session = p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID;
      const sub = session !== undefined && subagents.has(session);
      switch (event.type) {
        case "session.created":
          if (p.info?.parentID) { subagents.add(p.info.id); send(() => hive.emit("subagent.started", { agentId: p.info.id })); }
          return;
        case "session.status":
          if (sub) {
            if (p.status?.type === "idle") send(() => hive.emit("subagent.stopped", { agentId: session }));
            return;
          }
          if (p.status?.type === "busy" && !working) {
            working = true; outcome = "done"; lastAssistant = ""; parts.clear();
            send(() => hive.emit("turn.started"));
          } else if (p.status?.type === "idle" && working) {
            working = false;
            const text = replyText(), ended = outcome;
            send(async () => { if (text) await hive.reportReply(text); await hive.emit("turn.ended", { outcome: ended }); });
          }
          return;
        case "session.error":
          if (!sub) outcome = p.error?.name === "MessageAbortedError" ? "interrupted" : "failed";
          return;
        case "message.updated":
          if (!sub && p.info?.role === "assistant") lastAssistant = p.info.id;
          return;
        case "message.part.updated":
          if (!sub && p.part?.type === "text" && typeof p.part.text === "string") {
            if (!parts.has(p.part.messageID)) parts.set(p.part.messageID, new Map());
            parts.get(p.part.messageID).set(p.part.id, p.part.text);
          }
          return;
        case "permission.asked":
          send(() => hive.emit("input.requested", { kind: "permission" }));
          return;
        case "question.asked":
          send(() => hive.emit("input.requested", { kind: "question" }));
          return;
        case "permission.replied":
        case "question.replied":
        case "question.rejected":
          send(() => hive.emit("input.resolved"));
          return;
      }
    },
  };
};
