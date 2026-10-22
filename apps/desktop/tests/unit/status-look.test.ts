// What a tile's status looks like on every surface (workspace/status-look.tsx): no state is told by
// colour alone, a failed exit is the only alarm an exit raises, and the words are one list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { exitFailed, groupLook, LOOKS, statusLook, statusWord, type StatusLook } from "../../src/renderer/src/workspace/status-look.tsx";

const NEEDS = ["blocked", "permission", "question", "plan_review", "awaiting_approval"] as const;

test("each look has its own shape and its own word, so none is told by colour alone", () => {
  const looks = Object.keys(LOOKS) as StatusLook[];
  assert.deepEqual(looks.sort(), ["done", "exited", "failed", "idle", "needs", "working"]);
  assert.equal(new Set(looks.map((l) => LOOKS[l].shape)).size, looks.length, "a shape per look");
  assert.equal(new Set(looks.map((l) => LOOKS[l].word)).size, looks.length, "a word per look");
});

test("only needing you pulses, so reduced motion loses no state", () => {
  for (const s of NEEDS) assert.equal(statusLook(s), "needs", s);
  assert.deepEqual((Object.keys(LOOKS) as StatusLook[]).filter((l) => LOOKS[l].pulse), ["needs"]);
  assert.equal(LOOKS.needs.color, "var(--color-status-attention)");
});

test("a failed exit is the failure look; a clean one, or one whose code is unknown, is neutral", () => {
  const look = (exitCode?: number) => statusLook("exited", { failed: exitFailed({ status: "exited", ...(exitCode === undefined ? {} : { exitCode }) }) });
  assert.equal(look(1), "failed");
  assert.equal(LOOKS.failed.color, "var(--color-status-failed)");
  assert.equal(look(0), "exited");
  assert.equal(look(), "exited");
  assert.equal(LOOKS.exited.color, "var(--color-status-exited)");
  assert.equal(statusLook("working", { failed: true }), "working", "only an exit can fail");
  assert.equal(statusWord("exited", { failed: true }), "failed");
  assert.equal(statusWord("exited"), "exited");
});

test("working, idle and finished are their own looks, none of them the attention colour", () => {
  assert.equal(statusLook("working"), "working");
  assert.equal(statusLook("idle"), "idle");
  assert.equal(statusLook(null), "idle", "no status yet reads as idle");
  assert.equal(statusLook("idle", { unread: true }), "done");
  for (const l of ["working", "idle", "done", "exited"] as const) assert.notEqual(LOOKS[l].color, LOOKS.needs.color, l);
});

test("a tile's own chip says what it waits for, in one word list", () => {
  assert.deepEqual(NEEDS.map((s) => statusWord(s)), ["blocked", "approve?", "input?", "review?", "approval?"]);
  assert.equal(statusWord("working"), "working");
  assert.equal(statusWord("idle"), "idle");
});

test("a frame's mark: needing you first, then a failure, then work; a clean exit or idle raises none", () => {
  assert.equal(groupLook(["working", "failed", "needs", "idle"]), "needs");
  assert.equal(groupLook(["working", "failed", "idle"]), "failed");
  assert.equal(groupLook(["idle", "working"]), "working");
  assert.equal(groupLook(["exited", "idle", "done"]), null);
  assert.equal(groupLook([]), null);
});
