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

// The reported bug: claude working in bypass/auto mode showed idle because the
// persistent prompt + mode footer stayed on screen. Working signals must win.
test("working: spinner glyph + gerund ellipsis (no interrupt hint)", () => {
  assert.equal(detectClaudeState("✻ Cogitating…\n❯ "), "working");
  assert.equal(detectClaudeState("* Forging…\n❯ "), "working");
  assert.equal(detectClaudeState("✳ Crunching the diff…"), "working");
});

test("working wins over the queued-input prompt during work", () => {
  // Claude shows the spinner status line ABOVE the still-visible input box.
  const screen = [
    "✻ Reticulating splines… (12s · ↑ 1.2k tokens · esc to interrupt)",
    "╭───────────────────────────╮",
    "│ > ",
    "╰───────────────────────────╯",
    "⏵⏵ bypass permissions on",
  ].join("\n");
  assert.equal(detectClaudeState(screen), "working");
});

test("idle in bypass mode (boxed prompt, no spinner) is still idle", () => {
  assert.equal(detectClaudeState("done.\n❯ \n⏵⏵ bypass permissions on"), "idle");
});

// Reported bug: a background agent is running but the main loop sits at the ❯
// prompt with "✻ Waiting for N background agent to finish" — no interrupt hint,
// no spinner ellipsis — so the tile falsely showed idle.
// Reported miss: claude in high-effort "thinking" mode shows a spinner line with
// a NEW glyph (✚), a punctuated task title, a live token counter, and NO "esc to
// interrupt" — above the still-visible ❯ prompt → it read as idle.
test("working: token-stream counter (high-effort thinking, no interrupt hint)", () => {
  const screen = [
    "✚ If your site is down, would you know it first?… (6m 41s · ↓ 18.3k tokens · thinking some more with high effort)",
    "╭───────────────────────────╮",
    "│ ❯ ",
    "╰───────────────────────────╯",
    "▶▶ auto mode on (shift+tab to cycle)",
  ].join("\n");
  assert.equal(detectClaudeState(screen), "working");
});

test("working: token counter alone (↑ upload) over a prompt", () => {
  assert.equal(detectClaudeState("✶ Working… (↑ 1.2k tokens)\n❯ "), "working");
  assert.equal(detectClaudeState("Booping (· 4321 tokens ·)\n❯ "), "working");
});

test("working: new spinner glyph ✚ + punctuated title + ellipsis", () => {
  assert.equal(detectClaudeState("✚ Is it down, or is it me?…\n❯ "), "working");
});

test("working: background agent running, main loop back at prompt", () => {
  assert.equal(detectClaudeState("✻ Waiting for 1 background agent to finish\n❯ "), "working");
  assert.equal(detectClaudeState("Waiting for 3 background agents to finish\n> "), "working");
});

test("working: background-agent wait line above a long picker overlay", () => {
  const screen = [
    "✻ Waiting for 1 background agent to finish",
    "─────────────",
    "> ",
    "Model: Opus 4.8 | v2.1.181",
    "↑/↓ to select · Enter to view",
    "> ● main",
    "○ general-purpose  Resolve improvement/skills merge  6m",
  ].join("\n");
  assert.equal(detectClaudeState(screen), "working");
});
