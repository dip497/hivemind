/**
 * The claude provider. Reuses the (electron-free, unit-tested) resume + signal
 * injection in claude-resume.ts — that module is the claude provider's
 * implementation; this is just the AgentProvider adapter. claude is the rich
 * provider: it emits all three canonical deterministic signals via injected
 * hooks (turn → Stop, subagent → SubagentStart/Stop, notification → Notification)
 * plus session resume and the plan-review / approval-broker hooks.
 */
import { makeClaudeResumeTransforms } from "../claude-resume.js";
import type { AgentProvider } from "./types.js";

export const claudeProvider: AgentProvider = {
  id: "claude",
  matches: (cmd) => (cmd ?? "").split("/").pop() === "claude",
  resume: (ctx) =>
    makeClaudeResumeTransforms({
      trackerPath: ctx.trackerPath,
      tileSessionsDir: ctx.tileSessionsDir,
      legacyMapFile: ctx.legacyMapFile,
      execPath: ctx.execPath,
      planHookPath: ctx.planHookPath,
      planBridgeSock: ctx.planBridgeSock,
      stopHookPath: ctx.stopHookPath,
      approvalHookPath: ctx.approvalHookPath,
      subagentHookPath: ctx.subagentHookPath,
      notificationHookPath: ctx.notificationHookPath,
      userpromptHookPath: ctx.userpromptHookPath,
      hcpSock: ctx.hcpSock,
      hcpToken: ctx.hcpToken,
    }),
};
