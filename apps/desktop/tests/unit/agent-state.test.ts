// Unit tests for the multi-agent state detector ported from herdr (detect.rs).
// Run: pnpm test:unit (node --test via tsx). Covers identifyAgent + each agent's
// blocked/working/idle heuristics — the real risk surface is the string matching.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  identifyAgent,
  detectAgentState,
  detectTileStatus,
  stabilizeClaudeStatus,
  CLAUDE_WORKING_HOLD_MS,
} from "../../src/renderer/src/agent-state.ts";

test("stabilizeClaudeStatus: holds a lone idle blip, releases after the window", () => {
  const lw = { t: null as number | null };
  // first working scan records the timestamp
  assert.equal(stabilizeClaudeStatus("idle", "working", 1000, lw), "working");
  assert.equal(lw.t, 1000);
  // idle within the hold window (between-tool blip) → still working
  assert.equal(stabilizeClaudeStatus("working", "idle", 1000 + CLAUDE_WORKING_HOLD_MS - 1, lw), "working");
  // idle past the hold window → genuinely finished
  assert.equal(stabilizeClaudeStatus("working", "idle", 1000 + CLAUDE_WORKING_HOLD_MS + 1, lw), "idle");
});

test("stabilizeClaudeStatus: needs-human states are never held back", () => {
  const lw = { t: 1000 };
  assert.equal(stabilizeClaudeStatus("working", "permission", 1100, lw), "permission");
  assert.equal(stabilizeClaudeStatus("working", "question", 1100, lw), "question");
  assert.equal(stabilizeClaudeStatus("working", "blocked", 1100, lw), "blocked");
});

test("stabilizeClaudeStatus: idle stays idle when not coming from working", () => {
  const lw = { t: null as number | null };
  assert.equal(stabilizeClaudeStatus("idle", "idle", 5000, lw), "idle");
});

test("identifyAgent: bare names + path + aliases", () => {
  assert.equal(identifyAgent("claude"), "claude");
  assert.equal(identifyAgent("/usr/local/bin/claude --dangerously-skip-permissions"), "claude");
  assert.equal(identifyAgent("cursor-agent"), "cursor");
  assert.equal(identifyAgent("agy"), "antigravity");
  assert.equal(identifyAgent("ghcs"), "copilot");
  assert.equal(identifyAgent("/opt/x/grok-build"), "grok");
  assert.equal(identifyAgent("/bin/bash -il"), null);
  assert.equal(identifyAgent("vim"), null);
});

test("pi: Working… → working, else idle", () => {
  assert.equal(detectAgentState("pi", "out\nWorking..."), "working");
  assert.equal(detectAgentState("pi", "❯ "), "idle");
});

test("codex: confirm prompt → blocked, interrupt → working", () => {
  assert.equal(detectAgentState("codex", "allow command?\n[y/n]"), "blocked");
  assert.equal(detectAgentState("codex", "press enter to confirm or esc to cancel"), "blocked");
  assert.equal(detectAgentState("codex", "generating\nesc to interrupt"), "working");
  assert.equal(detectAgentState("codex", "• Working (0s • esc…"), "working");
  assert.equal(detectAgentState("codex", "❯ "), "idle");
});

test("gemini: box confirmation → blocked, esc to cancel → working", () => {
  assert.equal(detectAgentState("gemini", "│ Apply this change\n│ Yes  │ No"), "blocked");
  assert.equal(detectAgentState("gemini", "waiting for user confirmation"), "blocked");
  assert.equal(detectAgentState("gemini", "thinking…\nesc to cancel"), "working");
  assert.equal(detectAgentState("gemini", "❯ "), "idle");
});

test("cursor: approval → blocked, spinner → working", () => {
  assert.equal(detectAgentState("cursor", "Apply changes? (y) (enter) or keep (n)"), "blocked");
  assert.equal(detectAgentState("cursor", "⬡ Grepping.."), "working");
  assert.equal(detectAgentState("cursor", "⠞ Working  5.62k tokens"), "working");
  assert.equal(detectAgentState("cursor", "> "), "idle");
});

test("droid: EXECUTE approval → blocked, braille+esc to stop → working", () => {
  assert.equal(
    detectAgentState("droid", "EXECUTE rm x\n> Yes, allow\n> No, cancel\nEnter to select"),
    "blocked",
  );
  assert.equal(detectAgentState("droid", "⠹ Thinking...\n(Press ESC to stop)"), "working");
  assert.equal(detectAgentState("droid", "❯ "), "idle");
});

test("amp: approval footer → blocked, esc to cancel → working", () => {
  const blocked = "Run this command?\nApprove\nAllow All for This Session\nDeny with feedback";
  assert.equal(detectAgentState("amp", blocked), "blocked");
  assert.equal(detectAgentState("amp", "≈ Running tools…  Esc to cancel"), "working");
});

test("grok: scope selector → blocked, braille+verb → working", () => {
  assert.equal(detectAgentState("grok", "Yes, proceed\nNo, reject"), "blocked");
  assert.equal(detectAgentState("grok", "⠋ Waiting… 1.8s"), "working");
  assert.equal(detectAgentState("grok", "Ctrl+c:cancel  Ctrl+Enter:interject"), "working");
});

test("opencode: △ Permission required → blocked", () => {
  assert.equal(detectAgentState("opencode", "△ Permission required"), "blocked");
  assert.equal(detectAgentState("opencode", "running\nesc to interrupt"), "working");
});

test("cline: defaults to working, ready → idle", () => {
  assert.equal(detectAgentState("cline", "random output"), "working");
  assert.equal(detectAgentState("cline", "cline is ready for your message"), "idle");
  assert.equal(detectAgentState("cline", "let cline use this tool"), "blocked");
});

test("detectTileStatus: claude keeps permission/question buckets", () => {
  const perm = ["x", "  1. No", "  2. Yes, allow"].join("\n");
  assert.equal(detectTileStatus("claude", perm), "permission");
  assert.equal(detectTileStatus("claude", "Pick:\n↑/↓ to navigate"), "question");
  assert.equal(detectTileStatus("codex", "allow command?\n[y/n]"), "blocked");
});
