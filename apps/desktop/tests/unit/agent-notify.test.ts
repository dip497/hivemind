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
  assert.equal(r.title, "claude #2 · plan needs you");
  assert.equal(r.body, "Waiting for your input");
});

test("done → normal urgency, 'finished' title", () => {
  const r = composeNotice({ tileId: "t1", label: "codex", kind: "done" }, false);
  assert.ok(r);
  assert.equal(r.urgency, "normal");
  assert.equal(r.title, "codex finished");
  assert.equal(r.body, "Task finished");
});

test("repo basename is appended as context when provided", () => {
  const r = composeNotice(
    { tileId: "t1", label: "claude", kind: "needs", repo: "/home/me/dev/motadata-itsm-server" },
    false,
  );
  assert.ok(r);
  assert.equal(r.body, "Waiting for you · motadata-itsm-server");
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
  assert.equal(r.title, "agent finished");
});
