// droid-home — seeds the ephemeral FACTORY_HOME_OVERRIDE overlay (symlinks to
// the real ~/.factory + a hivemind-owned hooks.json).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { seedDroidHome } = await import("../../src/main/hcp/droid-home.ts");

function fakeFactory(): string {
  const real = mkdtempSync(join(tmpdir(), "real-factory-"));
  writeFileSync(join(real, "auth.v2.file"), "secret");
  writeFileSync(join(real, "settings.json"), "{}");
  mkdirSync(join(real, "sessions"));
  return real;
}

test("symlinks every real child + writes our hooks.json", () => {
  const real = fakeFactory();
  const home = mkdtempSync(join(tmpdir(), "droid-home-"));
  seedDroidHome({ droidHome: home, realFactory: real, hooks: { hooks: { Stop: ["x"] } } });

  const dot = join(home, ".factory");
  // auth + settings + sessions are symlinks pointing back at the real store.
  assert.equal(lstatSync(join(dot, "auth.v2.file")).isSymbolicLink(), true);
  assert.equal(readlinkSync(join(dot, "auth.v2.file")), join(real, "auth.v2.file"));
  assert.equal(realpathSync(join(dot, "sessions")), realpathSync(join(real, "sessions")));
  // hooks.json is a REAL hivemind-owned file, not a symlink.
  assert.equal(lstatSync(join(dot, "hooks.json")).isSymbolicLink(), false);
  assert.deepEqual(JSON.parse(readFileSync(join(dot, "hooks.json"), "utf8")), { hooks: { Stop: ["x"] } });
});

test("idempotent: re-seeding leaves links intact and refreshes hooks.json", () => {
  const real = fakeFactory();
  const home = mkdtempSync(join(tmpdir(), "droid-home-"));
  seedDroidHome({ droidHome: home, realFactory: real, hooks: { hooks: { Stop: ["a"] } } });
  seedDroidHome({ droidHome: home, realFactory: real, hooks: { hooks: { Stop: ["b"] } } });
  const dot = join(home, ".factory");
  assert.equal(readlinkSync(join(dot, "settings.json")), join(real, "settings.json"));
  assert.deepEqual(JSON.parse(readFileSync(join(dot, "hooks.json"), "utf8")), { hooks: { Stop: ["b"] } });
});

test("never symlinks the real hooks.json (hivemind owns that name)", () => {
  const real = fakeFactory();
  writeFileSync(join(real, "hooks.json"), JSON.stringify({ hooks: { PreToolUse: ["user"] } }));
  const home = mkdtempSync(join(tmpdir(), "droid-home-"));
  seedDroidHome({ droidHome: home, realFactory: real, hooks: { hooks: { Stop: ["ours"] } } });
  // Our hooks.json wins; it is NOT a link to the user's file.
  const p = join(home, ".factory", "hooks.json");
  assert.equal(lstatSync(p).isSymbolicLink(), false);
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { hooks: { Stop: ["ours"] } });
});

test("tolerates a missing real ~/.factory (fresh install) — still writes hooks", () => {
  const home = mkdtempSync(join(tmpdir(), "droid-home-"));
  seedDroidHome({ droidHome: home, realFactory: join(tmpdir(), "does-not-exist-xyz"), hooks: { hooks: {} } });
  assert.deepEqual(JSON.parse(readFileSync(join(home, ".factory", "hooks.json"), "utf8")), { hooks: {} });
});

test("writes settings.local.json with disableAutoUpdate (silences droid's self-updater)", () => {
  const real = fakeFactory();
  // user already has a local override → it's preserved, disableAutoUpdate added.
  writeFileSync(join(real, "settings.local.json"), JSON.stringify({ theme: "dark" }));
  const home = mkdtempSync(join(tmpdir(), "droid-home-"));
  seedDroidHome({ droidHome: home, realFactory: real, hooks: { hooks: {} } });
  const p = join(home, ".factory", "settings.local.json");
  assert.equal(lstatSync(p).isSymbolicLink(), false, "hivemind owns it (not a symlink to the user's)");
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { theme: "dark", disableAutoUpdate: true });
});
