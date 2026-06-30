/**
 * The pi (pi.dev — @earendil-works/pi-coding-agent) provider. Pi is a minimal
 * terminal coding harness: it has NO hook system (no Stop/UserPromptSubmit/
 * Notification like claude/droid), so there are no deterministic spawn-time
 * signals to inject — status comes from the renderer screen-scrape detector
 * (agent-state.ts `detectPi`). Like codex, pi can't pre-assign a session id, so
 * it has no spawn-time binding; on restore it resolves the newest session under
 * ~/.pi/agent/sessions whose header `cwd` matches the tile cwd and respawns
 * `pi --session <id>`. This adapter wraps the existing, unit-tested pi-resume
 * transforms.
 */
import { makePiResumeTransforms } from "../pi-resume.js";
import type { AgentProvider } from "./types.js";

export const piProvider: AgentProvider = {
  id: "pi",
  matches: (cmd) => (cmd ?? "").split("/").pop() === "pi",
  resume: () => makePiResumeTransforms(),
};
