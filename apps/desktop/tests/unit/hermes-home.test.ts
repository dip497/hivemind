// hermes-home — seeds the ephemeral HERMES_HOME overlay (symlinks to the real
// ~/.hermes + a merged config.yaml carrying our hooks).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, readlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

const { seedHermesHome } = await import("../../src/main/hcp/hermes-home.ts");

function fakeHermes(): string {
  const real = mkdtempSync(join(tmpdir(), "real-hermes-"));
  writeFileSync(join(real, ".env"), "KEY=1");
  writeFileSync(join(real, "auth.json"), "{}");
  mkdirSync(join(real, "sessions"));
  writeFileSync(join(real, "config.yaml"), "model:\n  default: glm-5.3\nhooks:\n  on_session_end:\n    - command: /user/own.sh\n");
  return real;
}

test("symlinks every real child + writes merged config.yaml", () => {
  const real = fakeHermes();
  const home = mkdtempSync(join(tmpdir(), "hermes-home-"));
  seedHermesHome({
    hermesHome: home,
    realHermesHome: real,
    hooks: { post_llm_call: [{ command: "/ours/stop.cjs", timeout: 10 }] },
  });
  // auth + sessions + .env are symlinks back at the real store.
  assert.equal(lstatSync(join(home, ".env")).isSymbolicLink(), true);
  assert.equal(readlinkSync(join(home, ".env")), join(real, ".env"));
  assert.equal(lstatSync(join(home, "sessions")).isSymbolicLink(), true);
  // config.yaml is a REAL hivemind-owned file with our hooks MERGED into the
  // user's own settings (model preserved, both hook sets present per event).
  assert.equal(lstatSync(join(home, "config.yaml")).isSymbolicLink(), false);
  const cfg = parse(readFileSync(join(home, "config.yaml"), "utf8"));
  assert.equal(cfg.model.default, "glm-5.3", "user settings preserved");
  assert.deepEqual(
    cfg.hooks.on_session_end.map((h: { command: string }) => h.command),
    ["/user/own.sh"],
    "user's own hooks preserved untouched",
  );
  assert.equal(cfg.hooks.post_llm_call[0].command, "/ours/stop.cjs");
});

test("user hook entries win + ours append when both define an event", () => {
  const real = fakeHermes();
  writeFileSync(join(real, "config.yaml"), "hooks:\n  post_llm_call:\n    - command: /user/own.sh\n");
  const home = mkdtempSync(join(tmpdir(), "hermes-home-"));
  seedHermesHome({
    hermesHome: home,
    realHermesHome: real,
    hooks: { post_llm_call: [{ command: "/ours/stop.cjs", timeout: 10 }] },
  });
  const cfg = parse(readFileSync(join(home, "config.yaml"), "utf8"));
  assert.deepEqual(
    cfg.hooks.post_llm_call.map((h: { command: string }) => h.command),
    ["/ours/stop.cjs", "/user/own.sh"],
    "ours first, user's preserved — both fire",
  );
});

test("the consent allowlist is never symlinked (ours stays out of the user's)", () => {
  const real = fakeHermes();
  writeFileSync(join(real, "shell-hooks-allowlist.json"), "{}");
  const home = mkdtempSync(join(tmpdir(), "hermes-home-"));
  seedHermesHome({ hermesHome: home, realHermesHome: real, hooks: {} });
  assert.equal(existsSync(join(home, "shell-hooks-allowlist.json")), false);
});

test("idempotent: re-seeding refreshes config + leaves links intact", () => {
  const real = fakeHermes();
  const home = mkdtempSync(join(tmpdir(), "hermes-home-"));
  seedHermesHome({ hermesHome: home, realHermesHome: real, hooks: { pre_llm_call: [{ command: "/a" }] } });
  seedHermesHome({ hermesHome: home, realHermesHome: real, hooks: { pre_llm_call: [{ command: "/b" }] } });
  assert.equal(readlinkSync(join(home, ".env")), join(real, ".env"));
  const cfg = parse(readFileSync(join(home, "config.yaml"), "utf8"));
  assert.equal(cfg.hooks.pre_llm_call[0].command, "/b");
});

test("tolerates a missing real ~/.hermes (fresh install) — still writes config", () => {
  const home = mkdtempSync(join(tmpdir(), "hermes-home-"));
  seedHermesHome({
    hermesHome: home,
    realHermesHome: join(tmpdir(), "does-not-exist-xyz"),
    hooks: { pre_llm_call: [{ command: "/a" }] },
  });
  const cfg = parse(readFileSync(join(home, "config.yaml"), "utf8"));
  assert.equal(cfg.hooks.pre_llm_call[0].command, "/a");
});
