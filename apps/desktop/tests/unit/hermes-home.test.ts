// Hermes runs in a private HERMES_HOME: the user's files linked in, and config.yaml their own
// with our hooks added — never a copy that drops their model or their own hooks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

const { manifestRuntime } = await import("@hivemind/agents/node");
const { authoredDef, authoredAsset } = await import("./authored-agents.ts");

function seed(userConfig?: string) {
  const home = mkdtempSync(join(tmpdir(), "hermes-user-"));
  const real = join(home, ".hermes");
  mkdirSync(real);
  writeFileSync(join(real, ".env"), "OPENROUTER_API_KEY=secret");
  if (userConfig !== undefined) writeFileSync(join(real, "config.yaml"), userConfig);
  const priv = mkdtempSync(join(tmpdir(), "hermes-private-"));
  const def = authoredDef("hermes");
  manifestRuntime(def, (f) => authoredAsset("hermes", f))!.install!({
    private: priv, execPath: "/x/electron", tileSessionsDir: "/x/ts", home,
    hooks: { event: { path: "/x/hcp-event-hook.cjs", arg: "/x/hcp.sock" }, turn: { path: join(priv, "hive-turn.cjs"), env: { HIVE_SDK: "/x/sdk.cjs" } } },
  });
  const dir = join(priv, "hermes-home");
  return { dir, config: YAML.parse(readFileSync(join(dir, "config.yaml"), "utf8")) as Record<string, any> };
}

test("the user's config carries over, their hooks run before ours, and their secrets stay linked", () => {
  const { dir, config } = seed(YAML.stringify({
    model: { provider: "openrouter", default: "anthropic/claude" },
    hooks: { pre_llm_call: [{ command: "~/.hermes/agent-hooks/mine.sh" }] },
  }));
  assert.deepEqual(config.model, { provider: "openrouter", default: "anthropic/claude" });
  assert.equal(config.hooks.pre_llm_call.length, 2);
  assert.equal(config.hooks.pre_llm_call[0].command, "~/.hermes/agent-hooks/mine.sh");
  assert.equal(lstatSync(join(dir, ".env")).isSymbolicLink(), true);
  assert.equal(lstatSync(join(dir, "config.yaml")).isSymbolicLink(), false);
});

test("our hooks: every one runs as argv, names no tile (so it is trusted once), and matches clarify only for questions", () => {
  const { config } = seed();
  assert.deepEqual(Object.keys(config.hooks).sort(), [
    "on_session_end", "post_approval_response", "post_llm_call", "pre_approval_request", "pre_llm_call", "post_tool_call", "pre_tool_call",
  ].sort());
  for (const [event, entries] of Object.entries(config.hooks) as Array<[string, Array<{ command: string; matcher?: string }>]>) {
    for (const e of entries) {
      assert.match(e.command, /^env /, event);
      assert.ok(!e.command.includes("HIVEMIND_TILE"), event);
    }
  }
  assert.equal(config.hooks.pre_tool_call[0].matcher, "clarify");
  assert.match(config.hooks.pre_llm_call[0].command, /HIVE_EVENT='turn\.started'/);
});
