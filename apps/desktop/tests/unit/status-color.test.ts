// statusColor — the one place an agent status becomes a colour. Pure, no React/DOM.
import { test } from "node:test";
import assert from "node:assert/strict";

const { statusColor } = await import("../../src/renderer/src/workspace/tile-status-bucket.ts");

test("every way of needing you is the same colour", () => {
  const needs = ["blocked", "permission", "question", "plan_review", "awaiting_approval"].map((s) => statusColor(s));
  assert.deepEqual(new Set(needs), new Set(["var(--color-status-attention)"]));
});

test("working, idle and a clean exit each have their own meaning, and none is attention", () => {
  assert.equal(statusColor("working"), "var(--color-status-working)");
  assert.equal(statusColor("idle"), "var(--color-status-idle)");
  assert.equal(statusColor("exited"), "var(--color-status-exited)");
});

test("only a failed exit is the failure colour", () => {
  assert.equal(statusColor("exited", { failed: true }), "var(--color-status-failed)");
  assert.equal(statusColor("working", { failed: true }), "var(--color-status-working)");
});
