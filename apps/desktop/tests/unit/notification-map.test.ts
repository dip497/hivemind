// Unit test for the claude Notification → "needs you" status mapping.
import { test } from "node:test";
import assert from "node:assert/strict";
import { notifyStatusFor } from "../../src/main/hcp/notification-map.ts";

test("permission types map to 'permission'", () => {
  assert.equal(notifyStatusFor("permission_request"), "permission");
  assert.equal(notifyStatusFor("worker_permission_prompt"), "permission");
  assert.equal(notifyStatusFor("tool_use_permission"), "permission"); // generic .includes
});

test("elicitation maps to 'question'", () => {
  assert.equal(notifyStatusFor("elicitation"), "question");
  assert.equal(notifyStatusFor("elicitation_response"), "question");
});

test("idle_prompt + non-status types map to null (scrape owns idle)", () => {
  assert.equal(notifyStatusFor("idle_prompt"), null);
  assert.equal(notifyStatusFor("auth_success"), null);
  assert.equal(notifyStatusFor("computer_use_enter"), null);
  assert.equal(notifyStatusFor("push_notification"), null);
  assert.equal(notifyStatusFor(""), null);
});

test("case-insensitive", () => {
  assert.equal(notifyStatusFor("PERMISSION_REQUEST"), "permission");
});
