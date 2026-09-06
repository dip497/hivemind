/**
 * pi (pi.dev — @earendil-works/pi-coding-agent) — an injected-runtime provider:
 * no hook system, but it loads an ESM extension via `pi -e`, so hivemind
 * injects a lifecycle bridge (./pi-ext-source.ts) that reports turn / status /
 * the inline reply over HCP — a real worker. pi has NO permission system, so it
 * cannot be supervised (a `supervise` request is refused, never downgraded).
 * Resumes the newest session for the tile's cwd (./pi.node.ts).
 */
import type { AgentProviderDef, AgentState } from "../types.js";

export function detectPi(content: string): AgentState {
  return content.includes("Working...") ? "working" : "idle";
}

export const pi: AgentProviderDef = {
  id: "pi",
  label: "Pi",
  bin: "pi",
  enabled: true,
  caps: {
    promptDelivery: "argv",
    turnSignal: true,
    resume: "cwd",
    supervise: false,
    modelFlag: false,
    permissionModes: false,
    blockedDetection: false,
  },
  detect: detectPi,
  note: "pi has no permission system: it always runs autonomously and cannot be supervised.",
};
