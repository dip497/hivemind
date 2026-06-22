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
} from "../../src/main/pty-session-manager.ts";
import { makeClaudeResumeTransforms, trackerSettings, type ClaudeResumeTransforms } from "../../src/main/claude-resume.ts";
import { trackerSource, readTrackedSession } from "../../src/main/tile-session-store.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("trackerSettings: injects the permission-broker hook ONLY when supervised", () => {
  const deps = {
    trackerPath: "/x/tracker.cjs", tileSessionsDir: "/x/sess", execPath: "/x/node",
    approvalHookPath: "/x/approval.cjs", hcpSock: "/x/hcp.sock",
  };
  // No supervise → no approval hook (PreToolUse absent without a plan hook either).
  const plain = JSON.parse(trackerSettings(deps, "t1"));
  assert.equal(plain.hooks.PreToolUse, undefined);
  // Supervised with a tool list → a PreToolUse entry matching those tools, whose
  // command runs the approval hook against the HCP socket with HIVE_SUPERVISE set.
  const sup = JSON.parse(trackerSettings(deps, "t1", "Bash,Write"));
  const entry = sup.hooks.PreToolUse.find((e: { matcher: string }) => e.matcher === "Bash|Write");
  assert.ok(entry, "approval hook entry present with the brokered-tools matcher");
  const cmd = entry.hooks[0].command as string;
  assert.match(cmd, /HIVE_SUPERVISE=/);
  assert.match(cmd, /approval\.cjs/);
  assert.match(cmd, /hcp\.sock/);
  // "all" → matcher "*".
  const all = JSON.parse(trackerSettings(deps, "t1", "all"));
  assert.ok(all.hooks.PreToolUse.some((e: { matcher: string }) => e.matcher === "*"));
});

test("trackerSettings: injects SubagentStart/Stop hooks when the subagent hook path is set", () => {
  // Without the subagent hook path → no SubagentStart/Stop (e.g. older daemon).
  const bare = JSON.parse(trackerSettings(
    { trackerPath: "/x/tracker.cjs", tileSessionsDir: "/x/sess", execPath: "/x/node", hcpSock: "/x/hcp.sock" },
    "t1",
  ));
  assert.equal(bare.hooks.SubagentStart, undefined);
  assert.equal(bare.hooks.SubagentStop, undefined);
  // With the path + socket → both events run the subagent hook against the socket,
  // carrying this tile's HIVEMIND_TILE so main attributes the subagent correctly.
  const deps = {
    trackerPath: "/x/tracker.cjs", tileSessionsDir: "/x/sess", execPath: "/x/node",
    subagentHookPath: "/x/subagent.cjs", hcpSock: "/x/hcp.sock",
  };
  const s = JSON.parse(trackerSettings(deps, "t-abc"));
  const cmd = s.hooks.SubagentStart[0].hooks[0].command as string;
  assert.equal(s.hooks.SubagentStop[0].hooks[0].command, cmd); // one command, both events
  assert.match(cmd, /HIVEMIND_TILE='t-abc'/);
  assert.match(cmd, /subagent\.cjs/);
  assert.match(cmd, /hcp\.sock/);
});

test("trackerSettings: injects the UserPromptSubmit hook (turn-start → working)", () => {
  const bare = JSON.parse(trackerSettings(
    { trackerPath: "/x/tracker.cjs", tileSessionsDir: "/x/sess", execPath: "/x/node", hcpSock: "/x/hcp.sock" },
    "t1",
  ));
  assert.equal(bare.hooks.UserPromptSubmit, undefined); // no path → not injected
  const s = JSON.parse(trackerSettings(
    {
      trackerPath: "/x/tracker.cjs", tileSessionsDir: "/x/sess", execPath: "/x/node",
      userpromptHookPath: "/x/userprompt.cjs", hcpSock: "/x/hcp.sock",
    },
    "t-up",
  ));
  const cmd = s.hooks.UserPromptSubmit[0].hooks[0].command as string;
  assert.match(cmd, /HIVEMIND_TILE='t-up'/);
  assert.match(cmd, /userprompt\.cjs/);
  assert.match(cmd, /hcp\.sock/);
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
  private markerExists(uuid: string) { return existsSync(path.join(this.ctx.markerDir, uuid)); }
  private createMarker(uuid: string) {
    mkdirSync(this.ctx.markerDir, { recursive: true });
    writeFileSync(path.join(this.ctx.markerDir, uuid), "jsonl");
  }
  private run(): void {
    const a = this.args();
    const rIdx = a.indexOf("--resume");
    const sIdx = a.indexOf("--session-id");
    if (rIdx >= 0) {
      const uuid = a[rIdx + 1]!;
      if (!this.markerExists(uuid)) {
        // exactly what real claude prints → triggers the daemon's retry
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
  const markerDir = path.join(dir, "markers");
  writeFileSync(trackerPath, trackerSource());
  const transforms = makeClaudeResumeTransforms({
    trackerPath,
    tileSessionsDir,
    legacyMapFile: path.join(dir, "tile-sessions.json"),
    execPath: process.execPath,
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

function transformsToOpts(t: ClaudeResumeTransforms) {
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

test("restore of a session whose JSONL vanished retries with --session-id (no tile crash)", async () => {
  const { tileSessionsDir, markerDir, snaps, makeMgr } = setup();
  try {
    const { mgr, created } = makeMgr();
    await mgr.createOrAttach("hm:tile-C", liveSpec("/repoC"), client());
    await delay(80);
    const uuidC = argVal(created[0], "--session-id");
    assert.ok(uuidC);
    await mgr.flushAll();

    // The session's JSONL disappears (claude GC, repo moved, etc.).
    unlinkSync(path.join(markerDir, uuidC!));

    const { mgr: mgr2, created: created2 } = makeMgr();
    mgr2.restoreSnapshot(snaps.get("hm:tile-C")!);
    await mgr2.createOrAttach("hm:tile-C", liveSpec("/repoC"), client());
    await delay(150);

    // First restore attempt: --resume uuidC → "No conversation found" → exit 1.
    assert.equal(argVal(created2[0], "--resume"), uuidC, "first attempt resumes the tracked id");
    // Retry transform recreates the session deterministically with --session-id.
    assert.equal(argVal(created2[1], "--session-id"), uuidC, "retry recreates the session with the same id");
    assert.ok(mgr2.has("hm:tile-C"), "tile survived the missing-session restore");
  } finally {
    rmSync(setupDirOf(tileSessionsDir), { recursive: true, force: true });
  }
});

/** tileSessionsDir is `<tmp>/tile-sessions`; the tmp root is its parent. */
function setupDirOf(tileSessionsDir: string): string {
  return path.dirname(tileSessionsDir);
}
