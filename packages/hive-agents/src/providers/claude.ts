/**
 * claude (Claude Code) — the native-tier provider: pre-assignable session id,
 * `--settings` hook injection (Stop / UserPromptSubmit / Subagent* /
 * Notification / PreToolUse) and a blocking permission broker. Daemon-side
 * transforms: ./claude.node.ts. Status detector: ./claude-state.ts (the only
 * one that distinguishes permission from question).
 */
import type { AgentProviderDef } from "../types.js";
import { detectClaudeState } from "./claude-state.js";

export const claude: AgentProviderDef = {
  id: "claude",
  label: "Claude",
  bin: "claude",
  aliases: ["claude-code"],
  enabled: true,
  caps: {
    promptDelivery: "argv",
    turnSignal: true,
    resume: "tile",
    supervise: true,
    modelFlag: true,
    permissionModes: true,
    blockedDetection: true,
  },
  detect: detectClaudeState,
};
