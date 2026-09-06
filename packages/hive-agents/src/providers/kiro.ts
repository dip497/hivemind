/**
 * kiro (kiro.dev — Kiro CLI, binary `kiro-cli`) — an injected-runtime provider
 * with per-tile resume: claude's hook vocabulary via a named custom agent
 * config in an ephemeral KIRO_HOME overlay (./kiro-home.ts, selected with
 * `--agent hivemind`), a captured session_id for `--resume-id`, and a
 * deny-only PreToolUse broker for `supervise` (./kiro-approval-hook-source.ts).
 * Bare `kiro` is a DIFFERENT product (the Kiro IDE) — recognised for status
 * only, never spawned. Daemon-side transforms: ./kiro.node.ts.
 */
import type { AgentProviderDef, AgentState } from "../types.js";
import { hasConfirmationPrompt } from "../detect-helpers.js";

// ASSUMPTION (maintainer audit, PR #2): no kiro-cli binary is available to
// capture its real approval-prompt chrome, so this "blocked" heuristic is
// modeled on detectDroid/detectAmp's shape (a question/confirmation line PLUS
// navigation/option chrome, not either alone) rather than any captured kiro
// screen text. kiro-cli prompts per-tool by default when a tool isn't in its
// `allowedTools` (docs/cli/chat/permissions), and hivemind ships no trust
// flags, so a kiro tile CAN sit on an approval prompt — without this branch it
// would misread as idle (no attention badge, "Finished" instead of "Needs your
// input"). Replace with real captured strings once the binary is available.
export function detectKiro(content: string): AgentState {
  const lower = content.toLowerCase();
  const toolSpinner = content.split("\n").some((line) => {
    const trimmed = line.trimStart();
    const first = trimmed.charAt(0);
    if (!"◔◑◕●".includes(first)) return false;
    return /[a-z]/i.test(trimmed.slice(1).trimStart().charAt(0));
  });
  const chrome =
    lower.includes("enter to select") ||
    lower.includes("enter to confirm") ||
    lower.includes("↑/↓") ||
    lower.includes("y/n");
  const options =
    lower.includes("allow") && (lower.includes("deny") || lower.includes("reject") || lower.includes("trust"));
  if ((chrome && options) || hasConfirmationPrompt(lower)) return "blocked";
  if (lower.includes("kiro is working") || (lower.includes("esc to cancel") && toolSpinner))
    return "working";
  return "idle";
}

export const kiro: AgentProviderDef = {
  id: "kiro",
  label: "Kiro",
  bin: "kiro-cli",
  aliases: ["kiro"],
  enabled: true,
  caps: {
    promptDelivery: "typed",
    turnSignal: true,
    resume: "tile",
    supervise: true,
    modelFlag: false,
    permissionModes: false,
    blockedDetection: true,
  },
  detect: detectKiro,
};
