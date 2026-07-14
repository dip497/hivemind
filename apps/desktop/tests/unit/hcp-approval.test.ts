/**
 * Supervised-worker approval policy.
 *
 * Two rules with teeth:
 *  1. A plain `allow` STICKS for file-touching tools, but NEVER for bash — caching
 *     an allow on bash would hand the worker a blanket shell for the rest of its life.
 *  2. pi's broker fails CLOSED. claude's hook fails open to claude's own permission
 *     prompt; pi has no such prompt, so a lost/timed-out approval there would run the
 *     tool unapproved. `piDecide` below MIRRORS the handler in pi-ext-source.ts (which
 *     ships as a JS string and can't be imported) — keep them in sync.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stickyAllow } from "../../src/main/hcp/methods.js";

test("a plain allow sticks for file-touching tools", () => {
  assert.equal(stickyAllow("tile-claude-1:Edit"), true);
  assert.equal(stickyAllow("tile-claude-1:Write"), true);
  assert.equal(stickyAllow("tile-claude-1:MultiEdit"), true);
  // pi lowercases its tool names; claude capitalizes. Both must hit.
  assert.equal(stickyAllow("tile-claude-1:edit"), true);
  assert.equal(stickyAllow("tile-claude-1:write"), true);
});

test("a plain allow NEVER sticks for bash — each command is a different action", () => {
  assert.equal(stickyAllow("tile-claude-1:Bash"), false);
  assert.equal(stickyAllow("tile-claude-1:bash"), false);
  // Nor for anything we haven't explicitly vetted.
  assert.equal(stickyAllow("tile-claude-1:SomeNewMcpTool"), false);
  assert.equal(stickyAllow(""), false);
});

/** MIRROR of the supervise `tool_call` handler in pi-ext-source.ts. */
function piDecide(res: { ok: boolean; result?: { decision?: string } } | null): "run" | "block" {
  const decision = res && res.ok && res.result ? res.result.decision : null;
  return decision === "allow" ? "run" : "block";
}

test("pi's broker fails CLOSED — only an explicit allow runs the tool", () => {
  assert.equal(piDecide({ ok: true, result: { decision: "allow" } }), "run");

  // Everything else blocks. Pre-fix, each of these FELL OPEN and silently ran the
  // very tool the supervisor was being asked about.
  assert.equal(piDecide({ ok: true, result: { decision: "deny" } }), "block");
  assert.equal(piDecide({ ok: true, result: { decision: "ask" } }), "block", "no supervisor → block, pi has no human prompt");
  assert.equal(piDecide(null), "block", "socket error / timeout → block");
  assert.equal(piDecide({ ok: false }), "block", "HCP error → block");
  assert.equal(piDecide({ ok: true }), "block", "malformed reply → block");
  assert.equal(piDecide({ ok: true, result: {} }), "block", "missing decision → block");
});
