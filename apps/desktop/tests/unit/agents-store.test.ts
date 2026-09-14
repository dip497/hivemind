// getSnapshot must be referentially stable, or useSyncExternalStore loops.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_CATALOG, setCatalog } from "@hivemind/agents";

const { getAgents, agentById, agentForCmd } = await import("../../src/renderer/src/agents.tsx");

test("getAgents returns a STABLE reference — useSyncExternalStore loops otherwise", () => {
  setCatalog(BUILTIN_CATALOG);
  const a = getAgents();
  const b = getAgents();
  assert.equal(a, b, "getAgents must be memoised: a fresh array each call is an infinite render loop");
  assert.ok(a.length > 0);
});

test("the reference changes exactly when the catalog does", () => {
  setCatalog(BUILTIN_CATALOG);
  const before = getAgents();
  setCatalog(BUILTIN_CATALOG.filter((d) => d.id !== "codex"));
  const after = getAgents();
  assert.notEqual(before, after, "a catalog swap must invalidate the memo");
  assert.equal(after.length, before.length - 1);
  assert.equal(getAgents(), after, "and then be stable again");
  setCatalog(BUILTIN_CATALOG);
});

test("lookups follow the live catalog, not a stale snapshot", () => {
  setCatalog(BUILTIN_CATALOG);
  assert.ok(agentById("codex"), "codex is catalogued");
  assert.equal(agentForCmd("codex")?.id, "codex");
  setCatalog(BUILTIN_CATALOG.filter((d) => d.id !== "codex"));
  assert.equal(agentForCmd("codex"), undefined, "agentForCmd must not serve a removed provider");
  setCatalog(BUILTIN_CATALOG);
  assert.equal(agentForCmd("codex")?.id, "codex");
});

test("a rebuilt list is cheap enough for the render paths that call it", () => {
  setCatalog(BUILTIN_CATALOG);
  const t = performance.now();
  for (let i = 0; i < 100_000; i++) agentById("claude");
  const nsPerOp = ((performance.now() - t) / 100_000) * 1e6;
  assert.ok(nsPerOp < 2000, `agentById is ${nsPerOp.toFixed(0)}ns/op — the memo is not being hit`);
});
