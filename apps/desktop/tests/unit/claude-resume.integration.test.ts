// End-to-end-ish verification of multi-frame claude resume across a daemon
// restart, driving the REAL SessionManager + REAL claude-resume transforms +
// REAL SessionStart tracker `.cjs`, with a faithful fake `claude`.
//
// Scenario (what the user asked to verify):
//   1. Two frames, each with a claude tile (different cwds).
//   2. In frame A the user `/resume`s an OLD pre-existing session.
//   3. Frame B is a fresh NEW session.
//   4. Kill the daemon (drop the live SessionManager), restart (new manager +
//      restoreSnapshot), re-attach both tiles.
//   5. Verify each tile resumes the RIGHT session — A the OLD one it switched
//      to (NOT its original id), B its own — and both actually resume.
//
// The fake claude runs the real tracker hook from its `--settings`, so the
// per-tile tracking + the resume transform are exercised exactly as in prod.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SessionManager,
  type ManagedPty,
  type SpawnSpec,
  type SessionSnapshot,
} from "@hivemind/agent-host/pty-session-manager";
import { authoredDef } from "./authored-agents.ts";
import { hookPathsFor, manifestRuntime, renderHookDocument, transformsFor, trackerSource, readTrackedSession,
  type ProviderResumeTransforms, type RuntimePaths } from "@hivemind/agents/node";

// claude is a manifest now. These build the same two things its module used to expose: the
// hooks document the daemon hands it, and the spawn/restore transforms.
const claudeDef = authoredDef("claude");
const pathsFor = (deps: Record<string, string | undefined>): RuntimePaths => ({
  private: "/x/agents/claude",
  execPath: deps.execPath!,
  tileSessionsDir: deps.tileSessionsDir!,
  home: deps.home ?? "/home/u",
  ...(deps.hcpSock ? { hcpSock: deps.hcpSock, hcpToken: "tok" } : {}),
  hooks: hookPathsFor(claudeDef, { ...deps, execPath: deps.execPath!, tileSessionsDir: deps.tileSessionsDir! }),
});
const trackerSettings = (deps: Record<string, string | undefined>, tileId: string, supervise?: string): string =>
  renderHookDocument(claudeDef, {
    tileId, cwd: "/w", args: [], env: {}, phase: "spawn", ...(supervise ? { supervise } : {}), paths: pathsFor(deps),
  })!;
const makeClaudeResumeTransforms = (deps: Record<string, string | undefined>): ProviderResumeTransforms =>
  transformsFor(claudeDef, manifestRuntime(claudeDef, () => undefined)!, pathsFor(deps),
    { ...(deps.legacyMapFile ? { legacyMapFile: deps.legacyMapFile } : {}) });

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("trackerSettings: claude's own approval script is wired ONLY when supervised", () => {
  const deps = { trackerPath: "/x/tracker.cjs", tileSessionsDir: "/x/sess", execPath: "/x/node", sdkPath: "/x/hive-sdk.cjs", hcpSock: "/x/hcp.sock" };
  // No supervise → only the plan review on PreToolUse.
  const plain = JSON.parse(trackerSettings(deps, "t1"));
  assert.deepEqual(plain.hooks.PreToolUse.map((e: { matcher: string }) => e.matcher), ["ExitPlanMode"]);
  // Supervised with a tool list → an entry matching those tools, running claude's script with the SDK.
  const sup = JSON.parse(trackerSettings(deps, "t1", "Bash,Write"));
  const entry = sup.hooks.PreToolUse.find((e: { matcher: string }) => e.matcher === "Bash|Write");
  assert.ok(entry, "approval entry present with the brokered-tools matcher");
  const cmd = entry.hooks[0].command as string;
  assert.match(cmd, /HIVE_SUPERVISE='Bash,Write'/);
  assert.match(cmd, /HIVE_SDK='\/x\/hive-sdk\.cjs'/);
  assert.match(cmd, /HIVE_HOOK_SOCK='\/x\/hcp\.sock'/);
  assert.match(cmd, /'\/x\/agents\/claude\/hive-approve\.cjs'/);
  // "all" → matcher "*".
  const all = JSON.parse(trackerSettings(deps, "t1", "all"));
  assert.ok(all.hooks.PreToolUse.some((e: { matcher: string }) => e.matcher === "*"));
});

test("trackerSettings: claude's lifecycle events run the generic event script, each naming its canonical event", () => {
  const base = { trackerPath: "/x/tracker.cjs", tileSessionsDir: "/x/sess", execPath: "/x/node", hcpSock: "/x/hcp.sock" };
  // A daemon without the generic script wires none of them.
  const bare = JSON.parse(trackerSettings(base, "t1"));
  for (const e of ["UserPromptSubmit", "SubagentStart", "SubagentStop", "PermissionRequest"]) assert.equal(bare.hooks[e], undefined, e);
  const s = JSON.parse(trackerSettings({ ...base, eventHookPath: "/x/event.cjs" }, "t-abc"));
  const cmd = (e: string) => s.hooks[e][0].hooks[0].command as string;
  assert.match(cmd("UserPromptSubmit"), /HIVE_EVENT='turn\.started'/);
  assert.match(cmd("SubagentStart"), /HIVE_EVENT='subagent\.started'/);
  assert.match(cmd("SubagentStop"), /HIVE_EVENT='subagent\.stopped'/);
  assert.match(cmd("PermissionRequest"), /HIVE_EVENT='input\.requested' HIVE_EVENT_KIND='permission'/);
  for (const e of ["UserPromptSubmit", "SubagentStart"]) {
    assert.match(cmd(e), /HIVEMIND_TILE='t-abc'/);
    assert.match(cmd(e), /'\/x\/event\.cjs' '\/x\/hcp\.sock'/);
  }
  // A usage limit and any other failure are told apart by claude's own matcher.
  assert.deepEqual(s.hooks.StopFailure.map((g: { matcher: string }) => g.matcher.split("|")[0]), ["rate_limit", "overloaded"]);
  assert.match(s.hooks.StopFailure[0].hooks[0].command, /HIVE_EVENT_OUTCOME='limited'/);
});
const client = () => ({ onData: () => {}, onExit: () => {} });
const liveSpec = (cwd: string): SpawnSpec => ({ cwd, cmd: "claude", args: [], cols: 80, rows: 24 });
const argVal = (p: FakeClaude | undefined, flag: string): string | undefined => {
  const a = p?.spec.args ?? [];
  const i = a.indexOf(flag);
  return i >= 0 ? a[i + 1] : undefined;
};

interface Ctx {
  markerDir: string; // a uuid "exists" (has a JSONL) iff markerDir/<uuid> exists
}

/** A faithful fake `claude`: honors --session-id/--resume, runs the REAL
 *  SessionStart hook from --settings (so the tracker records its live id), and
 *  errors like real claude when asked to --resume a missing session. */
class FakeClaude implements ManagedPty {
  pid = Math.floor(Math.random() * 1e6) + 1;
  killed = false;
  active?: string;
  private dataCb?: (d: string) => void;
  private exitCb?: (c: number, s: number | undefined) => void;
  constructor(public spec: SpawnSpec, private ctx: Ctx) {
    // Run after SessionManager has wired onData/onExit (it does so synchronously
    // within createOrAttach, before this fires).
    setTimeout(() => this.run(), 5);
  }
  private args() { return this.spec.args ?? []; }
  private hookCmd(): string | undefined {
    const a = this.args();
    const i = a.indexOf("--settings");
    if (i < 0) return undefined;
    try {
      return JSON.parse(a[i + 1]!).hooks.SessionStart[0].hooks[0].command as string;
    } catch { return undefined; }
  }
  private fireHook(sid: string): void {
    const cmd = this.hookCmd();
    if (!cmd) return;
    // Runs the REAL tracker .cjs (HIVEMIND_TILE is baked into cmd). This is what
    // real claude does on SessionStart — records tile → live session id.
    spawnSync("sh", ["-c", cmd], { input: JSON.stringify({ session_id: sid }) });
  }
  private markerExists(uuid: string) { return existsSync(path.join(this.ctx.markerDir, `${uuid}.jsonl`)); }
  private createMarker(uuid: string) {
    mkdirSync(this.ctx.markerDir, { recursive: true });
    writeFileSync(path.join(this.ctx.markerDir, `${uuid}.jsonl`), "jsonl");
  }
  private run(): void {
    const a = this.args();
    const rIdx = a.indexOf("--resume");
    const sIdx = a.indexOf("--session-id");
    if (rIdx >= 0) {
      const uuid = a[rIdx + 1]!;
      if (!this.markerExists(uuid)) {
        // what real claude prints, then exits: the fast failure is what the daemon retries on
        this.dataCb?.(`No conversation found with session ID: ${uuid}\r\n`);
        this.exitCb?.(1, undefined);
        return;
      }
      this.active = uuid;
      this.fireHook(uuid);
      this.dataCb?.(`resumed:${uuid}\r\n`);
      return;
    }
    if (sIdx >= 0) {
      const uuid = a[sIdx + 1]!;
      this.createMarker(uuid);
      this.active = uuid;
      this.fireHook(uuid);
      this.dataCb?.(`started:${uuid}\r\n`);
      return;
    }
    this.dataCb?.("started:noid\r\n");
  }
  /** Simulate the user `/resume <uuid>`-ing inside the tile: claude switches to
   *  that session and re-fires SessionStart, so the tracker updates. */
  write(d: string): void {
    const m = /^SWITCH (\S+)/.exec(d.trim());
    if (m) {
      const uuid = m[1]!;
      this.createMarker(uuid);
      this.active = uuid;
      this.fireHook(uuid);
      this.dataCb?.(`switched:${uuid}\r\n`);
    }
  }
  resize() {}
  kill() { this.killed = true; }
  onData(cb: (d: string) => void) { this.dataCb = cb; }
  onExit(cb: (c: number, s: number | undefined) => void) { this.exitCb = cb; }
}

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "hm-resume-"));
  const tileSessionsDir = path.join(dir, "tile-sessions");
  const trackerPath = path.join(dir, "tile-session-tracker.cjs");
  // Where claude keeps a session, as its manifest declares: {home}/.claude/projects/<slug>/<id>.jsonl.
  const markerDir = path.join(dir, ".claude", "projects", "-repo");
  writeFileSync(trackerPath, trackerSource());
  const transforms = makeClaudeResumeTransforms({
    trackerPath,
    tileSessionsDir,
    legacyMapFile: path.join(dir, "tile-sessions.json"),
    execPath: process.execPath,
    home: dir,
  });
  const snaps = new Map<string, SessionSnapshot>();
  const ctx: Ctx = { markerDir };
  const makeMgr = () => {
    const created: FakeClaude[] = [];
    const mgr = new SessionManager(
      (spec) => { const p = new FakeClaude(spec, ctx); created.push(p); return p; },
      { ...transformsToOpts(transforms), onSnapshot: (id, s) => snaps.set(id, s), snapshotDebounceMs: 5 },
    );
    return { mgr, created };
  };
  return { dir, tileSessionsDir, markerDir, snaps, makeMgr };
}

function transformsToOpts(t: ProviderResumeTransforms) {
  return {
    transformSpecOnSpawn: t.transformSpecOnSpawn,
    transformSpecOnRestore: t.transformSpecOnRestore,
    restoreRetryTransform: t.restoreRetryTransform,
    restoreRetryMs: t.restoreRetryMs,
  };
}

test("multi-frame: /resume-old + new session both survive a daemon restart", async () => {
  const { dir, tileSessionsDir, markerDir, snaps, makeMgr } = setup();
  try {
    const { mgr, created } = makeMgr();

    // ── Frame A: fresh claude → gets a deterministic --session-id uuidA ──
    await mgr.createOrAttach("hm:tile-A", liveSpec("/repoA"), client());
    await delay(80);
    const uuidA = argVal(created[0], "--session-id");
    assert.ok(uuidA, "frame A should spawn with an injected --session-id");
    assert.equal(readTrackedSession(tileSessionsDir, "hm:tile-A"), uuidA, "tracker should record A's initial id");

    // ── user /resume's an OLD pre-existing session inside frame A ──
    const uuidOLD = "11111111-2222-3333-4444-555555555555";
    created[0]!.write(`SWITCH ${uuidOLD}`); // claude switches + re-fires SessionStart
    await delay(80);
    assert.equal(readTrackedSession(tileSessionsDir, "hm:tile-A"), uuidOLD, "tracker must follow the /resume switch");

    // ── Frame B: a fresh NEW session ──
    await mgr.createOrAttach("hm:tile-B", liveSpec("/repoB"), client());
    await delay(80);
    const uuidB = argVal(created[1], "--session-id");
    assert.ok(uuidB);
    assert.equal(readTrackedSession(tileSessionsDir, "hm:tile-B"), uuidB);

    // snapshot both (what survives a daemon restart)
    await mgr.flushAll();
    assert.ok(snaps.has("hm:tile-A") && snaps.has("hm:tile-B"), "both tiles snapshotted");

    // ── KILL DAEMON + RESTART: fresh manager, rehydrate snapshots ──
    const { mgr: mgr2, created: created2 } = makeMgr();
    mgr2.restoreSnapshot(snaps.get("hm:tile-A")!);
    mgr2.restoreSnapshot(snaps.get("hm:tile-B")!);

    // renderer re-attaches each tile (passes a bare spec; daemon uses frozen spec)
    await mgr2.createOrAttach("hm:tile-A", liveSpec("/repoA"), client());
    await delay(100);
    await mgr2.createOrAttach("hm:tile-B", liveSpec("/repoB"), client());
    await delay(100);

    // ── VERIFY ──
    // Frame A must resume the OLD session it switched to — NOT its original id.
    assert.equal(argVal(created2[0], "--resume"), uuidOLD, "A must resume the /resume'd OLD session across restart");
    assert.notEqual(argVal(created2[0], "--resume"), uuidA, "A must NOT resume its original (pre-switch) id");
    assert.equal(created2[0]!.active, uuidOLD, "A actually resumed the OLD session");
    // Frame B must resume its own new session.
    assert.equal(argVal(created2[1], "--resume"), uuidB, "B must resume its own session");
    assert.equal(created2[1]!.active, uuidB, "B actually resumed");
    // Both tiles are live after restart (no crash).
    assert.ok(mgr2.has("hm:tile-A") && mgr2.has("hm:tile-B"));
    void dir; void markerDir;
  } finally {
    rmSync(setupDirOf(tileSessionsDir), { recursive: true, force: true });
  }
});

test("restore of a session whose JSONL vanished starts fresh under the same id, without a failed spawn", async () => {
  const { tileSessionsDir, markerDir, snaps, makeMgr } = setup();
  try {
    const { mgr, created } = makeMgr();
    await mgr.createOrAttach("hm:tile-C", liveSpec("/repoC"), client());
    await delay(80);
    const uuidC = argVal(created[0], "--session-id");
    assert.ok(uuidC);
    await mgr.flushAll();

    // The session's JSONL disappears (claude GC, repo moved, etc.).
    unlinkSync(path.join(markerDir, `${uuidC!}.jsonl`));

    const { mgr: mgr2, created: created2 } = makeMgr();
    mgr2.restoreSnapshot(snaps.get("hm:tile-C")!);
    await mgr2.createOrAttach("hm:tile-C", liveSpec("/repoC"), client());
    await delay(150);

    // The store says the session is gone, so the tile is not handed a resume it would fail.
    assert.equal(created2.length, 1, "one spawn, no failed attempt");
    assert.equal(argVal(created2[0], "--resume"), undefined);
    assert.equal(argVal(created2[0], "--session-id"), uuidC, "recreated with the same id");
    assert.ok(mgr2.has("hm:tile-C"), "tile survived the missing-session restore");
  } finally {
    rmSync(setupDirOf(tileSessionsDir), { recursive: true, force: true });
  }
});

/** tileSessionsDir is `<tmp>/tile-sessions`; the tmp root is its parent. */
function setupDirOf(tileSessionsDir: string): string {
  return path.dirname(tileSessionsDir);
}

test("a saved spec that repeats its resume restores with it once", () => {
  const home = mkdtempSync(path.join(tmpdir(), "hm-home-"));
  const id = "30e61ded-dc21-4f87-97e6-a9553fdf9930";
  mkdirSync(path.join(home, ".claude", "projects", "-w"), { recursive: true });
  writeFileSync(path.join(home, ".claude", "projects", "-w", `${id}.jsonl`), "{}");
  const t = makeClaudeResumeTransforms({ tileSessionsDir: "/x/none", execPath: "/x/node", home });
  const out = t.transformSpecOnRestore!(
    { cwd: "/w", cmd: "claude", args: ["--resume", id, "--resume", id, "--resume", id, "--permission-mode", "auto"], cols: 80, rows: 24 },
    "hm:tile-x",
  );
  const args = out.args ?? [];
  assert.equal(args.filter((a) => a === "--resume").length, 1);
  assert.equal(args[args.indexOf("--resume") + 1], id);
  assert.ok(args.includes("--permission-mode"));
});
