/**
 * The hermes (Nous Research — hermes-agent) provider. Hermes ships a
 * Claude-Code-shaped shell-hook system (config.yaml `hooks:` → JSON-on-stdin
 * commands) plus a full config-home override (`HERMES_HOME`), so it is a
 * first-class hook provider like droid — NOT scrape-only:
 *  - pre_llm_call → working (pairs with post_llm_call's turn END → idle),
 *  - post_llm_call → turn event carrying `extra.assistant_response` inline
 *    (the clean reply — agent.read / workflow gather it directly, no
 *    transcript scrape; same inline-reply path pi uses),
 *  - pre_approval_request → deterministic "needs you" status.
 * The renderer `detectHermes` scrape stays as the fallback. On restore it
 * respawns `hermes --in <cwd> --resume latest` — hermes resolves the newest
 * session for that workspace itself (no session-file scan).
 */
import { makeHermesResumeTransforms } from "../hermes-resume.js";
import type { AgentProvider } from "./types.js";

export const hermesProvider: AgentProvider = {
  id: "hermes",
  matches: (cmd) => (cmd ?? "").split("/").pop() === "hermes",
  resume: (ctx) =>
    makeHermesResumeTransforms({
      execPath: ctx.execPath,
      hermesHome: ctx.hermesHome,
      hermesStopHookPath: ctx.hermesStopHookPath,
      userpromptHookPath: ctx.userpromptHookPath,
      hermesNotifyHookPath: ctx.hermesNotifyHookPath,
      hcpSock: ctx.hcpSock,
      hcpToken: ctx.hcpToken,
    }),
};
