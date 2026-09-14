/**
 * pi (pi.dev — @earendil-works/pi-coding-agent) — an injected-runtime provider:
 * no hook system, but it loads an ESM extension via `pi -e`, so hivemind
 * injects a lifecycle bridge (./pi-ext-source.ts) that reports turn / status /
 * the inline reply over HCP — a real worker. pi has NO permission system, so it
 * cannot be supervised (a `supervise` request is refused, never downgraded).
 * Resumes the newest session for the tile's cwd (./pi.node.ts).
 */
import type { AgentProviderDef, AgentState } from "../../types.js";

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
    supervise: "none",
    blockedDetection: false,
  },
  options: [
    { id: "model", label: "Model", flag: "--model", list: { args: ["--list-models"], skip: 1, format: "{1}/{2}" } },
  ],
  install: { url: "https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md", command: "npm install -g --ignore-scripts @earendil-works/pi-coding-agent" },
  /** pi's block glyph. */
  icon: {
    viewBox: "0 0 800 800",
    attrs: { fill: "currentColor", fillRule: "evenodd" },
    body: '<path d="M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z" /><path d="M517.36 400 H634.72 V634.72 H517.36 Z" />',
  },
  detect: detectPi,
  note: "pi has no permission system: it always runs autonomously and cannot be supervised.",
};
