/**
 * OpenClaw — probed by `hive agent detect` and accepted as an agent assignee
 * (the only two places it was ever listed). No captured screen text, so it has
 * NO detector: a user-run openclaw tile is treated like any unknown program,
 * exactly as before. Not spawnable until it is probed and wired.
 */
import type { AgentProviderDef } from "../../types.js";
import { GENERIC_AGENT_ICON } from "../../icon.js";

export const openclaw: AgentProviderDef = {
  id: "openclaw",
  label: "OpenClaw",
  bin: "openclaw",
  enabled: false,
  caps: {
    promptDelivery: "typed",
    turnSignal: false,
    resume: "none",
    supervise: "human",
    blockedDetection: false,
  },
  icon: GENERIC_AGENT_ICON,
  note: "not spawnable and not status-scraped yet; no detector strings captured.",
};
