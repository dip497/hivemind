/**
 * The droid (Factory) provider. Droid ships the same hook model as Claude Code,
 * so — given an ephemeral FACTORY_HOME_OVERRIDE home seeded with hivemind's
 * hooks.json (ctx.droidHome) — it emits the deterministic turn/notification
 * signals: `UserPromptSubmit`/`Stop` drive working/idle AND `Stop`'s
 * transcript_path lets agent.read / workflow.run gather a clean reply via the
 * turn-tracker. The renderer screen-scrape (`detectDroid`) stays as the fallback
 * for sessions started before injection. On restore it resolves the newest
 * ~/.factory/sessions entry for the tile cwd and respawns `droid --resume <id>`.
 */
import { makeDroidResumeTransforms } from "../droid-resume.js";
import type { AgentProvider } from "./types.js";

export const droidProvider: AgentProvider = {
  id: "droid",
  matches: (cmd) => (cmd ?? "").split("/").pop() === "droid",
  resume: (ctx) =>
    makeDroidResumeTransforms({
      execPath: ctx.execPath,
      droidHome: ctx.droidHome,
      stopHookPath: ctx.stopHookPath,
      userpromptHookPath: ctx.userpromptHookPath,
      notificationHookPath: ctx.notificationHookPath,
      hcpSock: ctx.hcpSock,
      hcpToken: ctx.hcpToken,
    }),
};
