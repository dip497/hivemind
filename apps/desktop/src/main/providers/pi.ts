/**
 * The pi (pi.dev — @earendil-works/pi-coding-agent) provider. Pi has NO
 * claude-style hook system, but it DOES load an ESM extension via `pi -e`, so it
 * is now integrated via a lifecycle-bridge extension (hcp/pi-ext-source.ts):
 * hivemind injects that extension + the HCP socket/token/tile-id env into every
 * pi spawn, bridging pi's agent_start/message_end/agent_end to the HCP
 * `status`/`turn` topics. So a pi tile reports turn-completion, status, and its
 * inline reply deterministically (hive_read / auto-report / workflow work with
 * `agent: pi`), mirroring claude's Stop hook — no longer raw / screen-scrape
 * only (the renderer `detectPi` scrape remains the fallback). Like codex, pi
 * can't pre-assign a session id, so on restore it resolves the newest session
 * under ~/.pi/agent/sessions whose header `cwd` matches the tile cwd and
 * respawns `pi --session <id>`. This adapter wraps the unit-tested pi-resume
 * transforms.
 */
import { makePiResumeTransforms } from "../pi-resume.js";
import type { AgentProvider } from "./types.js";

export const piProvider: AgentProvider = {
  id: "pi",
  matches: (cmd) => (cmd ?? "").split("/").pop() === "pi",
  resume: (ctx) => makePiResumeTransforms({ hcpSock: ctx.hcpSock, hcpToken: ctx.hcpToken, piExtPath: ctx.piExtPath }),
};
