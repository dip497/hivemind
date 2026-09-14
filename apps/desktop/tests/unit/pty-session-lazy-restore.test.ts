import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager, type ManagedPty, type SpawnSpec, type SessionSnapshot } from "../../src/main/pty-session-manager.ts";

class FakePty implements ManagedPty {
  readonly pid = Math.floor(Math.random() * 100000);
  constructor(public spec: SpawnSpec) {}
  write() {}
  resize() {}
  kill() {}
  onData() {}
  onExit() {}
}

const callerSpec: SpawnSpec = { cwd: "/r", cmd: "bash", args: [], cols: 100, rows: 30 };
const saved: SessionSnapshot = {
  id: "hm:t1",
  spec: { cwd: "/saved", cmd: "claude", args: ["--session-id", "u"], cols: 80, rows: 24 },
  replay: "restored screen",
  savedAt: 1,
};
const client = { onData: () => {}, onExit: () => {} };

function setup(opts = {}) {
  const made: FakePty[] = [];
  const evicted: string[] = [];
  const mgr = new SessionManager((spec) => { const p = new FakePty(spec); made.push(p); return p; },
    { onSnapshotEvict: (id: string) => evicted.push(id), ...opts });
  return { mgr, made, evicted };
}

test("a registered snapshot is not read until its tile attaches", async () => {
  const { mgr, made } = setup();
  let reads = 0;
  mgr.restoreLazySnapshot("hm:t1", () => { reads++; return saved; });
  assert.equal(reads, 0, "boot must not read the file");
  assert.deepEqual(mgr.frozenIds(), ["hm:t1"]);
  assert.equal(mgr.has("hm:t1"), true, "still known to the daemon");

  const r = await mgr.createOrAttach("hm:t1", callerSpec, client);
  assert.equal(reads, 1);
  assert.equal(made[0]!.spec.cmd, "claude", "the snapshot's spec is what respawns");
  assert.equal(made[0]!.spec.cols, 100, "…at the attaching window's size");
  assert.ok(r.replay.includes("restored screen"), "the saved screen is replayed");
  assert.deepEqual(mgr.frozenIds(), []);
});

test("two attaches of one tile restore it once — the second joins the first", async () => {
  const { mgr, made } = setup();
  let reads = 0;
  mgr.restoreLazySnapshot("hm:t1", () => { reads++; return saved; });
  const [a, b] = await Promise.all([
    mgr.createOrAttach("hm:t1", callerSpec, client),
    mgr.createOrAttach("hm:t1", callerSpec, client),
  ]);
  assert.equal(reads, 1, "the snapshot is loaded exactly once");
  assert.equal(made.length, 1, "exactly one PTY — neither attach spawned a fresh copy");
  assert.equal(a.pid, b.pid);
});

test("a snapshot that cannot be read degrades to a fresh session", async () => {
  const { mgr, made } = setup();
  mgr.restoreLazySnapshot("hm:t1", () => undefined);
  const r = await mgr.createOrAttach("hm:t1", callerSpec, client);
  assert.equal(r.isNew, true);
  assert.equal(made[0]!.spec.cmd, "bash", "falls back to what the caller asked for");
});

test("killing an unclaimed snapshot evicts it without ever reading it", () => {
  const { mgr, evicted } = setup();
  let reads = 0;
  mgr.restoreLazySnapshot("hm:t1", () => { reads++; return saved; });
  mgr.kill("hm:t1");
  assert.equal(reads, 0);
  assert.deepEqual(evicted, ["hm:t1"], "the file is removed from disk");
  assert.deepEqual(mgr.frozenIds(), []);
  assert.equal(mgr.has("hm:t1"), false);
});
