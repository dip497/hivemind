/**
 * The codex provider. codex can't pre-assign a session id, so it has no
 * spawn-time binding; on restore it resolves the newest session under
 * ~/.codex/sessions matching the tile cwd and respawns `codex … resume <id>`.
 * No deterministic signals (codex exposes no hook system) → it relies on the
 * renderer screen-scrape detector (agent-state.ts `detectCodex`) for status.
 * This adapter wraps the existing, unit-tested codex-resume transforms.
 */
import { makeCodexResumeTransforms } from "../codex-resume.js";
import type { AgentProvider } from "./types.js";

export const codexProvider: AgentProvider = {
  id: "codex",
  matches: (cmd) => (cmd ?? "").split("/").pop() === "codex",
  resume: () => makeCodexResumeTransforms(),
};
