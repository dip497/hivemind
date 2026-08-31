// kiro-home — seeds the ephemeral KIRO_HOME overlay (symlinks to the real
// ~/.kiro + a hivemind-owned agents/hivemind.json, preserving the user's own
// custom agents alongside it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { seedKiroHome } = await import("../../src/main/hcp/kiro-home.ts");

function fakeKiro(): string {
  const real = mkdtempSync(join(tmpdir(), "real-kiro-"));
  writeFileSync(join(real, "auth.json"), "secret");
  writeFileSync(join(real, "settings.json"), "{}");
  mkdirSync(join(real, "sessions"));
  mkdirSync(join(real, "agents"));
  writeFileSync(join(real, "agents", "my-custom-agent.json"), JSON.stringify({ name: "my-custom-agent" }));
  return real;
}

test("symlinks every real top-level child (except agents/) + writes agents/hivemind.json", () => {
  const real = fakeKiro();
  const home = mkdtempSync(join(tmpdir(), "kiro-home-"));
  seedKiroHome({ kiroHome: home, realKiro: real, agentConfig: { name: "hivemind", hooks: { stop: [] } } });

  const dot = join(home, ".kiro");
  assert.equal(lstatSync(join(dot, "auth.json")).isSymbolicLink(), true);
  assert.equal(readlinkSync(join(dot, "auth.json")), join(real, "auth.json"));
  assert.equal(realpathSync(join(dot, "sessions")), realpathSync(join(real, "sessions")));
  // agents/ itself is a REAL directory, not a symlink (hivemind owns it).
  assert.equal(lstatSync(join(dot, "agents")).isSymbolicLink(), false);
  assert.equal(
    JSON.parse(readFileSync(join(dot, "agents", "hivemind.json"), "utf8")).name,
    "hivemind",
  );
});

test("preserves the user's own custom agents alongside hivemind.json", () => {
  const real = fakeKiro();
  const home = mkdtempSync(join(tmpdir(), "kiro-home-"));
  seedKiroHome({ kiroHome: home, realKiro: real, agentConfig: { name: "hivemind" } });

  const agentsDir = join(home, ".kiro", "agents");
  assert.equal(lstatSync(join(agentsDir, "my-custom-agent.json")).isSymbolicLink(), true);
  assert.equal(readlinkSync(join(agentsDir, "my-custom-agent.json")), join(real, "agents", "my-custom-agent.json"));
  assert.equal(lstatSync(join(agentsDir, "hivemind.json")).isSymbolicLink(), false);
});

test("idempotent: re-seeding leaves links intact and refreshes hivemind.json", () => {
  const real = fakeKiro();
  const home = mkdtempSync(join(tmpdir(), "kiro-home-"));
  seedKiroHome({ kiroHome: home, realKiro: real, agentConfig: { name: "hivemind", v: 1 } });
  seedKiroHome({ kiroHome: home, realKiro: real, agentConfig: { name: "hivemind", v: 2 } });
  const dot = join(home, ".kiro");
  assert.equal(readlinkSync(join(dot, "settings.json")), join(real, "settings.json"));
  assert.equal(JSON.parse(readFileSync(join(dot, "agents", "hivemind.json"), "utf8")).v, 2);
});

test("never symlinks a real agents/hivemind.json (hivemind owns that name)", () => {
  const real = fakeKiro();
  writeFileSync(join(real, "agents", "hivemind.json"), JSON.stringify({ name: "not-ours" }));
  const home = mkdtempSync(join(tmpdir(), "kiro-home-"));
  seedKiroHome({ kiroHome: home, realKiro: real, agentConfig: { name: "hivemind", ours: true } });
  const p = join(home, ".kiro", "agents", "hivemind.json");
  assert.equal(lstatSync(p).isSymbolicLink(), false);
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { name: "hivemind", ours: true });
});

test("tolerates a missing real ~/.kiro (fresh install) — still writes the agent config", () => {
  const home = mkdtempSync(join(tmpdir(), "kiro-home-"));
  seedKiroHome({ kiroHome: home, realKiro: join(tmpdir(), "does-not-exist-xyz"), agentConfig: { name: "hivemind" } });
  assert.deepEqual(
    JSON.parse(readFileSync(join(home, ".kiro", "agents", "hivemind.json"), "utf8")),
    { name: "hivemind" },
  );
});
