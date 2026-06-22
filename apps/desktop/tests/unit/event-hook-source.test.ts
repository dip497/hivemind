// Unit test for the shared event-hook-source factory + the three hooks built on
// it. We can't spawn the CJS here, but we assert the generated script embeds the
// right topic + mapping and is syntactically valid (new Function compiles it).
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { eventHookSource } from "../../src/main/hcp/event-hook-source.ts";
import { stopHookSource } from "../../src/main/hcp/stop-hook-source.ts";
import { subagentHookSource } from "../../src/main/hcp/subagent-hook-source.ts";
import { notificationHookSource } from "../../src/main/hcp/notification-hook-source.ts";
import { userpromptHookSource } from "../../src/main/hcp/userprompt-hook-source.ts";

test("factory embeds the topic and compiles", () => {
  const src = eventHookSource("turn", "return { tileId: tileId };");
  assert.match(src, /topic: "turn"/);
  assert.doesNotThrow(() => new vm.Script(src), "generated CJS parses");
});

test("stop hook → topic 'turn', forwards transcript_path", () => {
  const src = stopHookSource();
  assert.match(src, /topic: "turn"/);
  assert.match(src, /transcript_path/);
  assert.doesNotThrow(() => new vm.Script(src));
});

test("subagent hook → topic 'subagent', derives phase + agent_id", () => {
  const src = subagentHookSource();
  assert.match(src, /topic: "subagent"/);
  assert.match(src, /SubagentStart/);
  assert.match(src, /agent_id/);
  assert.doesNotThrow(() => new vm.Script(src));
});

test("notification hook → topic 'notification', forwards notification_type", () => {
  const src = notificationHookSource();
  assert.match(src, /topic: "notification"/);
  assert.match(src, /notification_type/);
  assert.doesNotThrow(() => new vm.Script(src));
});

test("userprompt hook → topic 'status', state working (turn start)", () => {
  const src = userpromptHookSource();
  assert.match(src, /topic: "status"/);
  assert.match(src, /state: "working"/);
  assert.doesNotThrow(() => new vm.Script(src));
});

test("all hooks are fail-open: exit 0 with no socket/tile", () => {
  for (const src of [stopHookSource(), subagentHookSource(), notificationHookSource(), userpromptHookSource()]) {
    assert.match(src, /if \(!sock \|\| !tileId\)/);
  }
});
