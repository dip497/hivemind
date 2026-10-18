// The agent a new tile starts: Send to agent, the island's button, a view or a plugin's prompt all ask it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { useAuthoredAgents } from "./authored-agents.ts";

const { agentToStart } = await import("../../src/renderer/src/agent-plugins.ts");

test("without a usable choice, the first agent installed here starts: one missing or a different program is passed over", () => {
  useAuthoredAgents();
  const presence = {
    aider: { path: null }, amp: { path: null }, antigravity: { path: null },
    auggie: { path: "/bin/auggie", mismatch: "not auggie" }, claude: { path: "/bin/claude" },
  };
  assert.equal(agentToStart("amp", presence)?.id, "claude");
  assert.equal(agentToStart("", presence)?.id, "claude");
});
