/**
 * kiro (kiro.dev — Kiro CLI, binary `kiro-cli`) — an injected-runtime provider
 * with per-tile resume: claude's hook vocabulary via a named custom agent
 * config in an ephemeral KIRO_HOME overlay (./kiro-home.ts, selected with
 * `--agent hivemind`), a captured session_id for `--resume-id`, and a
 * deny-only PreToolUse broker for `supervise` (./kiro-approval-hook-source.ts).
 * Bare `kiro` is a DIFFERENT product (the Kiro IDE) — recognised for status
 * only, never spawned. Daemon-side transforms: ./kiro.node.ts.
 */
import type { AgentProviderDef, AgentState } from "../../types.js";
import { hasConfirmationPrompt } from "../../detect-helpers.js";

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
    supervise: "broker",
    blockedDetection: true,
  },
  install: { url: "https://kiro.dev/docs/cli/", command: "curl -fsSL https://cli.kiro.dev/install | bash" },
  /** the Kiro ghost mark. */
  icon: {
    viewBox: "0 0 24 24",
    attrs: { fill: "currentColor", fillRule: "evenodd" },
    body: '<path d="M4.594 6.677C6.67-2.226 18.746-2.211 21.16 6.632c.353 1.297 1.725 7.582-1.673 13.747-1.545 2.797-5.841 5.49-6.99 1.883C8.6 25.477 3.315 24.1 5.789 18.609l-.318.143c-3.57 1.305-3.863-1.208-3.173-2.513.45-.84.727-1.335.937-1.897.353-.975.458-1.568.593-2.498.27-1.837.277-3.607.765-5.167zm8.37.01a.92.92 0 00-.81.428c-.217.323-.33.825-.33 1.462 0 .705.15 1.89 1.14 1.89h.008c.757 0 1.214-.705 1.214-1.89 0-.622-.127-1.125-.367-1.455a1.014 1.014 0 00-.855-.435zm4.08 0a.92.92 0 00-.81.428c-.217.323-.33.825-.33 1.462 0 .705.15 1.89 1.14 1.89h.008c.757 0 1.215-.705 1.215-1.89 0-.622-.128-1.125-.368-1.455a1.014 1.014 0 00-.855-.435z" />',
  },
  detect: detectKiro,
};
