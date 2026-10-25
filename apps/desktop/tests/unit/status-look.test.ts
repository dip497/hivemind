// What a tile's status looks like on every surface (workspace/status-look.tsx): no state is told by
// colour alone, a failed exit is the only alarm an exit raises, and the words are one list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { exitFailed, groupLook, LOOKS, statusLook, statusWord, type StatusLook } from "../../src/renderer/src/workspace/status-look.tsx";
import { STATUS_MARKS } from "@hivemind/view-sdk/status";

const NEEDS = ["blocked", "permission", "question", "plan_review", "awaiting_approval"] as const;

test("each look has its own shape and its own word, so none is told by colour alone", () => {
  const looks = Object.keys(LOOKS) as StatusLook[];
  assert.deepEqual(looks.sort(), ["done", "exited", "failed", "idle", "needs", "working"]);
  assert.equal(new Set(looks.map((l) => LOOKS[l].shape)).size, looks.length, "a shape per look");
  assert.equal(new Set(looks.map((l) => LOOKS[l].word)).size, looks.length, "a word per look");
});

test("the app draws the SDK's marks and words, the ones every view draws, so the two cannot drift", () => {
  const tone = { working: "working", needs: "attention", done: "done", failed: "failed", idle: "idle", exited: "exited" } as const;
  for (const l of Object.keys(LOOKS) as StatusLook[]) {
    const m = STATUS_MARKS[tone[l]];
    assert.deepEqual([LOOKS[l].shape, LOOKS[l].word, LOOKS[l].pulse], [m.path, m.word, m.pulse], l);
  }
});

test("only needing you pulses, so reduced motion loses no state", () => {
  for (const s of NEEDS) assert.equal(statusLook(s), "needs", s);
  assert.deepEqual((Object.keys(LOOKS) as StatusLook[]).filter((l) => LOOKS[l].pulse), ["needs"]);
});

test("needing you and failing each have a colour no other look has", () => {
  const looks = Object.keys(LOOKS) as StatusLook[];
  for (const alarm of ["needs", "failed"] as const) {
    for (const l of looks) if (l !== alarm) assert.notEqual(LOOKS[l].color, LOOKS[alarm].color, `${l} is not drawn as ${alarm}`);
  }
});

test("a failed exit is the failure look; a clean one, or one whose code is unknown, is neutral", () => {
  const look = (e: { exitCode?: number; failed?: boolean }) => statusLook("exited", { failed: exitFailed({ status: "exited", ...e }) });
  assert.equal(look({ exitCode: 1 }), "failed");
  assert.equal(look({ exitCode: 0 }), "exited");
  assert.equal(look({}), "exited");
  // No code, and it never ran: a spawn that failed, a session that could not be opened.
  assert.equal(look({ failed: true }), "failed");
  assert.equal(statusLook("working", { failed: true }), "working", "only an exit can fail");
  assert.equal(exitFailed({ status: "working", failed: true }), false, "only an exit can fail");
  assert.equal(statusWord("exited", { failed: true }), "failed");
  assert.equal(statusWord("exited"), "exited");
});

test("working, idle and finished are their own looks", () => {
  assert.equal(statusLook("working"), "working");
  assert.equal(statusLook("idle"), "idle");
  assert.equal(statusLook(null), "idle", "no status yet reads as idle");
  assert.equal(statusLook("idle", { unread: true }), "done");
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
