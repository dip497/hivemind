// The native-OS-notification decision/format core. The electron side effects
// (Notification, flashFrame, dock) are thin glue; the gate + text live in the
// pure `composeNotice`, tested here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { composeNotice } from "../../src/main/agent-notify-core.ts";

test("suppresses when the window is focused (in-app toast covers it)", () => {
  const r = composeNotice({ tileId: "t1", label: "claude #1", kind: "needs" }, true);
  assert.equal(r, null);
});

test("needs → critical urgency, 'needs you' title", () => {
  const r = composeNotice({ tileId: "t1", label: "claude #2 · plan", kind: "needs" }, false);
  assert.ok(r);
  assert.equal(r.urgency, "critical");
  assert.equal(r.title, "claude #2 · plan"); // TITLE = identity only
  assert.equal(r.body, "Needs your input");   // verb moved to the body
});

test("done → normal urgency, 'finished' title", () => {
  const r = composeNotice({ tileId: "t1", label: "codex", kind: "done" }, false);
  assert.ok(r);
  assert.equal(r.urgency, "normal");
  assert.equal(r.title, "codex");
  assert.equal(r.body, "Finished");
});

test("error → critical urgency, 'failed' title + exit code in body", () => {
  const r = composeNotice({ tileId: "t1", label: "claude #3", kind: "error", exitCode: 137 }, false);
  assert.ok(r);
  assert.equal(r.urgency, "critical");
  assert.equal(r.title, "claude #3");
  assert.equal(r.body, "Crashed · exit code 137"); // action + how, no context
});

test("error with no code and no context falls back to a generic line", () => {
  const r = composeNotice({ tileId: "t1", label: "claude", kind: "error" }, false);
  assert.ok(r);
  assert.equal(r.body, "Crashed");
});

test("error with frame shows 'Crashed · …' and the context", () => {
  const r = composeNotice(
    { tileId: "t1", label: "claude", kind: "error", exitCode: 1, frame: "billing-api" },
    false,
  );
  assert.ok(r);
  assert.equal(r.urgency, "critical");
  assert.equal(r.title, "claude");
  assert.equal(r.body, "Crashed · exit code 1 · billing-api");
});

test("error prefers explicit detail (signal) over the bare exit code", () => {
  const r = composeNotice(
    { tileId: "t1", label: "claude", kind: "error", exitCode: 143, detail: "killed by signal 15", frame: "api" },
    false,
  );
  assert.ok(r);
  assert.equal(r.body, "Crashed · killed by signal 15 · api");
});

test("error is suppressed when the window is focused (toast covers it)", () => {
  const r = composeNotice({ tileId: "t1", label: "claude", kind: "error", exitCode: 1 }, true);
  assert.equal(r, null);
});

test("repo basename is appended as context when provided", () => {
  const r = composeNotice(
    { tileId: "t1", label: "claude", kind: "needs", repo: "/home/me/dev/motadata-itsm-server" },
    false,
  );
  assert.ok(r);
  assert.equal(r.body, "Needs your input · motadata-itsm-server");
});

test("frame name is preferred over repo as the context", () => {
  const r = composeNotice(
    { tileId: "t1", label: "Refactor auth", kind: "done", frame: "billing-api", repo: "/x/y/repo" },
    false,
  );
  assert.ok(r);
  assert.equal(r.title, "Refactor auth");
  assert.equal(r.body, "Finished · billing-api");
});

test("ignores unknown kinds and missing tileId", () => {
  // @ts-expect-error — exercising the runtime guard
  assert.equal(composeNotice({ tileId: "t1", label: "x", kind: "bogus" }, false), null);
  // @ts-expect-error — exercising the runtime guard
  assert.equal(composeNotice({ label: "x", kind: "needs" }, false), null);
});

test("falls back to 'agent' when label is empty", () => {
  const r = composeNotice({ tileId: "t1", label: "", kind: "done" }, false);
  assert.ok(r);
  assert.equal(r.title, "agent");
});

test("a raw tile id never surfaces as the title — falls back to 'agent'", () => {
  const r = composeNotice({ tileId: "tile-claude-123", label: "tile-claude-123", kind: "needs", frame: "api" }, false);
  assert.ok(r);
  assert.equal(r.title, "agent");
  assert.equal(r.body, "Needs your input · api");
});
