// Unit test for the ported Claude-state detector. Run: pnpm test:unit
// (node --test via tsx). This is the real risk surface — the regexes — tested
// hermetically, unlike an e2e that fights shell-env PATH resolution.
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectClaudeState } from "../../src/renderer/src/claude-state.ts";

test("working: 'esc to interrupt' on screen", () => {
  assert.equal(detectClaudeState("Thinking…\nDoing the thing (esc to interrupt)"), "working");
});

test("permission: numbered 'Yes,' tool dialog", () => {
  const screen = [
    "Claude wants to read a file",
    "  1. No",
    "  2. Yes, allow reading from /home/x",
  ].join("\n");
  assert.equal(detectClaudeState(screen), "permission");
});

test("question: arrow-select prompt", () => {
  assert.equal(detectClaudeState("Pick one:\n↑/↓ to navigate"), "question");
  assert.equal(detectClaudeState("Choose a model\n[use arrows to move]"), "question");
});

test("idle: ❯ prompt", () => {
  assert.equal(detectClaudeState("done.\n❯ "), "idle");
});

test("idle: bypass-permissions splash", () => {
  assert.equal(detectClaudeState("Welcome to Claude Code\n⏵⏵ bypass permissions on"), "idle");
});

test("permission wins over a stale 'esc to interrupt' higher up", () => {
  const screen = ["working (esc to interrupt)", "  1. No", "  2. Yes, allow"].join("\n");
  assert.equal(detectClaudeState(screen), "permission");
});

test("prose 'do you want to' does NOT trigger permission", () => {
  assert.equal(detectClaudeState("I can refactor this. Do you want to proceed? (esc to interrupt)"), "working");
});

test("default falls back to working", () => {
  assert.equal(detectClaudeState("some random output with no markers"), "working");
});

test("trailing blank lines ignored", () => {
  assert.equal(detectClaudeState("❯ \n\n\n\n"), "idle");
});
