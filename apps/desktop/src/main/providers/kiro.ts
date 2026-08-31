/**
 * The kiro (kiro-cli) provider. kiro-cli ships claude's hook vocabulary
 * (agentSpawn/userPromptSubmit/preToolUse/postToolUse/stop) via a NAMED custom
 * agent config, so — given an ephemeral KIRO_HOME overlay seeded with
 * hivemind's `agents/hivemind.json` (ctx.kiroHome) — it emits deterministic
 * turn signals: `userPromptSubmit`/`stop` drive working/idle, and a captured
 * `session_id` (off the first hook event) enables PER-TILE resume via
 * `--resume-id`, not just per-cwd. The renderer screen-scrape (`detectKiro`)
 * stays as the fallback for sessions started before injection, and is the ONLY
 * source for "blocked" (kiro has no notification-style event — see
 * agent-state.ts). `matches`/session logic is imported from kiro-resume.ts
 * (kiro-cli ONLY — the bare `kiro` binary is a different product, the Kiro
 * IDE — see that file for why aliasing it would misfire).
 */
import { isKiro, makeKiroResumeTransforms } from "../kiro-resume.js";
import type { AgentProvider } from "./types.js";

export const kiroProvider: AgentProvider = {
  id: "kiro",
  matches: (cmd) => isKiro({ cmd: cmd ?? "" }),
  resume: (ctx) =>
    makeKiroResumeTransforms({
      execPath: ctx.execPath,
      kiroHome: ctx.kiroHome,
      stopHookPath: ctx.stopHookPath,
      userpromptHookPath: ctx.userpromptHookPath,
      kiroApprovalHookPath: ctx.kiroApprovalHookPath,
      trackerPath: ctx.trackerPath,
      tileSessionsDir: ctx.tileSessionsDir,
      legacyMapFile: ctx.legacyMapFile,
      hcpSock: ctx.hcpSock,
      hcpToken: ctx.hcpToken,
    }),
};
