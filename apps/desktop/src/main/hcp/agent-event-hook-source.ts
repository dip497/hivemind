/**
 * The generic observe hook: every manifest `emit:` entry runs this one script. The canonical
 * event comes from the environment the renderer put in front of the command; from the agent's
 * payload it keeps only a closed list of ids and paths — never text the agent wrote.
 */
import { AGENT_EVENT_TOPIC, EVENT_ENV } from "@hivemind/agents";
import { eventHookSource } from "./event-hook-source.js";

export function agentEventHookSource(): string {
  return eventHookSource(
    AGENT_EVENT_TOPIC,
    `var env = process.env;
     var name = env[${JSON.stringify(EVENT_ENV.event)}] || "";
     if (!name) return null;
     var e = evt || {};
     var out = { tileId: tileId, event: name };
     if (env[${JSON.stringify(EVENT_ENV.outcome)}]) out.outcome = env[${JSON.stringify(EVENT_ENV.outcome)}];
     if (env[${JSON.stringify(EVENT_ENV.kind)}]) out.kind = env[${JSON.stringify(EVENT_ENV.kind)}];
     if (typeof e.transcript_path === "string") out.transcriptPath = e.transcript_path;
     if (e.agent_id != null) out.agentId = String(e.agent_id);
     if (typeof e.session_id === "string") out.sessionId = e.session_id;
     return out;`,
  );
}
