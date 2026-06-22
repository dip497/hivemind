// droid-resume — session resolver, resume transforms, hook + env injection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { isDroid, newestDroidSessionForCwd, makeDroidResumeTransforms, droidHooksSettings } =
  await import("../../src/main/droid-resume.ts");

// Mirrors ~/.factory/sessions/<cwd-slug>/<id>.jsonl: first line is a
// `session_start` record carrying { id, cwd }.
function sessionFile(root: string, rel: string, id: string, cwd: string, mtime: number): void {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  const meta = JSON.stringify({ type: "session_start", id, cwd, title: "x" });
  writeFileSync(p, meta + "\n" + JSON.stringify({ type: "message" }) + "\n");
  utimesSync(p, new Date(mtime), new Date(mtime));
}

const HOOK_DEPS = {
  execPath: "/x/electron",
  droidHome: "/x/droid-home",
  stopHookPath: "/x/stop.cjs",
  userpromptHookPath: "/x/up.cjs",
  notificationHookPath: "/x/notif.cjs",
  hcpSock: "/x/hcp.sock",
  hcpToken: "tok",
};

test("isDroid matches the droid binary (path/args tolerant)", () => {
  assert.equal(isDroid({ cmd: "droid" }), true);
  assert.equal(isDroid({ cmd: "/usr/local/bin/droid" }), true);
  assert.equal(isDroid({ cmd: "droid --resume abc" }), true);
  assert.equal(isDroid({ cmd: "claude" }), false);
  assert.equal(isDroid({ cmd: "codex" }), false);
});

test("newestDroidSessionForCwd picks the newest session matching the cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "droid-sess-"));
  sessionFile(root, "-proj-app/a.jsonl", "id-old", "/proj/app", 1_000_000);
  sessionFile(root, "-proj-app/b.jsonl", "id-new", "/proj/app", 2_000_000);
  sessionFile(root, "-proj-other/c.jsonl", "id-other", "/proj/other", 3_000_000); // newer, different cwd
  assert.equal(newestDroidSessionForCwd("/proj/app", root), "id-new");
  assert.equal(newestDroidSessionForCwd("/proj/other", root), "id-other");
  assert.equal(newestDroidSessionForCwd("/proj/missing", root), undefined);
});

test("droidHooksSettings wires Stop/UserPromptSubmit/Notification at TOP LEVEL (no `hooks` wrapper)", () => {
  const hooks = droidHooksSettings(HOOK_DEPS);
  // Top-level event keys — droid's hooks.json matches 0 commands if wrapped.
  assert.ok(hooks.Stop && hooks.UserPromptSubmit && hooks.Notification, "all three events wired");
  assert.equal((hooks as any).hooks, undefined, "must NOT be nested under a `hooks` key");
  const stopCmd = (hooks.Stop[0] as any).hooks[0].command as string;
  assert.match(stopCmd, /ELECTRON_RUN_AS_NODE=1/);
  assert.match(stopCmd, /stop\.cjs/);
  assert.match(stopCmd, /hcp\.sock/);
  // Attribution must NOT be baked into the shared hooks.json command — it rides env.
  assert.doesNotMatch(stopCmd, /HIVEMIND_TILE=/);
});

test("droidHooksSettings is empty without execPath/hcpSock (no injection)", () => {
  assert.deepEqual(droidHooksSettings({}), {});
  assert.deepEqual(droidHooksSettings({ execPath: "/x" }), {}, "needs the socket too");
});

test("transformSpecOnSpawn injects FACTORY_HOME_OVERRIDE + HCP env for THIS tile", () => {
  const { transformSpecOnSpawn } = makeDroidResumeTransforms(HOOK_DEPS);
  const out = transformSpecOnSpawn({ cwd: "/w", cmd: "droid", args: [] }, "tile-7");
  assert.equal(out.env?.FACTORY_HOME_OVERRIDE, "/x/droid-home");
  assert.equal(out.env?.HIVE_HCP_SOCK, "/x/hcp.sock");
  assert.equal(out.env?.HCP_TOKEN, "tok");
  assert.equal(out.env?.HIVEMIND_TILE, "tile-7");
  assert.deepEqual(out.args, []); // no arg change — hooks come from the home file
});

test("transformSpecOnSpawn is a no-op for non-droid", () => {
  const { transformSpecOnSpawn } = makeDroidResumeTransforms(HOOK_DEPS);
  const claude = { cwd: "/w", cmd: "claude", args: [] };
  assert.deepEqual(transformSpecOnSpawn(claude, "t"), claude);
});

test("transformSpecOnRestore appends `--resume <id>` AND injects env", () => {
  const root = mkdtempSync(join(tmpdir(), "droid-sess-"));
  sessionFile(root, "-w/x.jsonl", "sid-1", "/w", 1_000_000);
  const { transformSpecOnRestore } = makeDroidResumeTransforms({ ...HOOK_DEPS, sessionsRoot: root });
  const out = transformSpecOnRestore({ cwd: "/w", cmd: "droid", args: [] }, "tile-1");
  assert.deepEqual(out.args, ["--resume", "sid-1"]);
  assert.equal(out.env?.FACTORY_HOME_OVERRIDE, "/x/droid-home");
  assert.equal(out.env?.HIVEMIND_TILE, "tile-1");
});

test("transformSpecOnRestore no-ops resume for unknown cwd / already-resuming (still injects env)", () => {
  const root = mkdtempSync(join(tmpdir(), "droid-sess-"));
  const { transformSpecOnRestore } = makeDroidResumeTransforms({ ...HOOK_DEPS, sessionsRoot: root });
  const noSess = transformSpecOnRestore({ cwd: "/missing", cmd: "droid", args: [] }, "t");
  assert.deepEqual(noSess.args, []);
  assert.equal(noSess.env?.FACTORY_HOME_OVERRIDE, "/x/droid-home");
  const already = transformSpecOnRestore({ cwd: "/w", cmd: "droid", args: ["--resume", "old"] }, "t");
  assert.deepEqual(already.args, ["--resume", "old"]);
});

test("restoreRetryTransform strips the resume so a stale id respawns fresh", () => {
  const { restoreRetryTransform } = makeDroidResumeTransforms(HOOK_DEPS);
  const out = restoreRetryTransform({ cwd: "/w", cmd: "droid", args: ["--resume", "sid"] });
  assert.deepEqual(out?.args, []);
  assert.equal(restoreRetryTransform({ cwd: "/w", cmd: "claude", args: ["--resume", "u"] }), null);
});
