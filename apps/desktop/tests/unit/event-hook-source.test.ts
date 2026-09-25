// The shared event-hook-source factory: the generated script embeds its topic and parses.
// The one hook built on it runs for real in agent-event-hook.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { eventHookSource } from "@hivemind/agent-host/hooks/event-hook-source";

test("factory embeds the topic and compiles", () => {
  const src = eventHookSource("turn", "return { tileId: tileId };");
  assert.match(src, /topic: "turn"/);
  assert.doesNotThrow(() => new vm.Script(src), "generated CJS parses");
});
