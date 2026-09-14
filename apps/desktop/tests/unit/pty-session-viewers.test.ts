import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager, type ManagedPty, type SessionClient, type SpawnSpec } from "../../src/main/pty-session-manager.ts";

class FakePty implements ManagedPty {
  readonly pid = 4242;
  size: [number, number];
  written: string[] = [];
  paused = false;
  private dataCb: ((d: string) => void) | null = null;
  private exitCb: ((c: number, s: number | undefined) => void) | null = null;
  constructor(spec: SpawnSpec) { this.size = [spec.cols, spec.rows]; }
  write(d: string) { this.written.push(d); }
  resize(c: number, r: number) { this.size = [c, r]; }
  kill() {}
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  onData(cb: (d: string) => void) { this.dataCb = cb; }
  onExit(cb: (c: number, s: number | undefined) => void) { this.exitCb = cb; }
  emit(d: string) { this.dataCb?.(d); }
  exit(code = 0) { this.exitCb?.(code, undefined); }
}

function setup() {
  const ptys: FakePty[] = [];
  const mgr = new SessionManager((spec) => { const p = new FakePty(spec); ptys.push(p); return p; });
  const viewer = () => {
    const got: string[] = []; const exits: number[] = [];
    const c: SessionClient = { onData: (d) => got.push(d), onExit: (code) => exits.push(code) };
    return { c, got, exits };
  };
  return { mgr, ptys, viewer };
}
const spec = (cols: number, rows: number): SpawnSpec => ({ cwd: "/r", cmd: "bash", args: ["-l"], cols, rows });

test("output and exit fan out to every viewer", async () => {
  const { mgr, ptys, viewer } = setup();
  const desk = viewer(), phone = viewer();
  await mgr.createOrAttach("t1", spec(120, 40), desk.c);
  await mgr.createOrAttach("t1", spec(45, 30), phone.c);
  ptys[0]!.emit("hi");
  assert.deepEqual(desk.got, ["hi"]);
  assert.deepEqual(phone.got, ["hi"]);
  ptys[0]!.exit(3);
  assert.deepEqual(desk.exits, [3]);
  assert.deepEqual(phone.exits, [3]);
  assert.equal(ptys.length, 1, "second attach must not spawn a second pty");
});

test("detaching one viewer leaves the other streaming", async () => {
  const { mgr, ptys, viewer } = setup();
  const desk = viewer(), phone = viewer();
  await mgr.createOrAttach("t1", spec(120, 40), desk.c);
  await mgr.createOrAttach("t1", spec(45, 30), phone.c);
  mgr.detach("t1", phone.c);
  ptys[0]!.emit("after");
  assert.deepEqual(desk.got, ["after"]);
  assert.deepEqual(phone.got, []);
  assert.equal(mgr.info()[0]!.viewers, 1);
});

test("the last viewer to interact owns the pty size", async () => {
  const { mgr, ptys, viewer } = setup();
  const desk = viewer(), phone = viewer();
  await mgr.createOrAttach("t1", spec(120, 40), desk.c);
  await mgr.createOrAttach("t1", spec(45, 30), phone.c);
  assert.deepEqual(ptys[0]!.size, [45, 30], "attaching is interacting");
  mgr.write("t1", "ls\r", desk.c);
  assert.deepEqual(ptys[0]!.size, [120, 40], "typing on the desktop takes the size back");
  assert.deepEqual(ptys[0]!.written, ["ls\r"]);
  mgr.resize("t1", 50, 30, phone.c);
  assert.deepEqual(ptys[0]!.size, [50, 30]);
  mgr.write("t1", "y", phone.c);
  assert.deepEqual(ptys[0]!.size, [50, 30], "no resize when the writer already owns the size");
});

test("pause holds while any viewer is paused; a leaving viewer's pause is dropped", async () => {
  const { mgr, ptys, viewer } = setup();
  const desk = viewer(), phone = viewer();
  await mgr.createOrAttach("t1", spec(120, 40), desk.c);
  await mgr.createOrAttach("t1", spec(45, 30), phone.c);
  mgr.pause("t1", phone.c);
  mgr.pause("t1", desk.c);
  mgr.resume("t1", desk.c);
  assert.equal(ptys[0]!.paused, true, "phone still paused");
  mgr.detach("t1", phone.c);
  assert.equal(ptys[0]!.paused, false, "phone left → its back-pressure goes with it");
});

test("info() lists live sessions with viewers, size and command", async () => {
  const { mgr, viewer } = setup();
  await mgr.createOrAttach("t1", spec(80, 24), viewer().c);
  const [row] = mgr.info();
  assert.deepEqual(row, { id: "t1", state: "live", cmd: "bash", args: ["-l"], cwd: "/r", pid: 4242, viewers: 1, cols: 80, rows: 24 });
});

test("frozen snapshots show as frozen with no pid", () => {
  const { mgr } = setup();
  mgr.restoreSnapshot({ id: "old", spec: spec(80, 24), replay: "x", title: "claude", savedAt: 0 });
  assert.deepEqual(mgr.info(), [{ id: "old", state: "frozen", cmd: "bash", args: ["-l"], cwd: "/r", pid: null, viewers: 0, cols: 80, rows: 24, title: "claude" }]);
});

test("kill tells every other viewer the session ended; the killer hears nothing", async () => {
  const { mgr, viewer } = setup();
  const desk = viewer(), phone = viewer();
  await mgr.createOrAttach("t1", spec(120, 40), desk.c);
  await mgr.createOrAttach("t1", spec(45, 30), phone.c);
  mgr.kill("t1", desk.c);
  assert.deepEqual(phone.exits, [0], "the phone must not wait on a dead session");
  assert.deepEqual(desk.exits, [], "the viewer that closed it already knows");
  assert.equal(mgr.has("t1"), false);
});

test("when the size owner leaves, the most recent remaining viewer gets its size back", async () => {
  const { mgr, ptys, viewer } = setup();
  const desk = viewer(), tablet = viewer(), phone = viewer();
  await mgr.createOrAttach("t1", spec(120, 40), desk.c);
  await mgr.createOrAttach("t1", spec(90, 30), tablet.c);
  mgr.write("t1", "x", desk.c); // desk interacted most recently among the two
  await mgr.createOrAttach("t1", spec(45, 30), phone.c);
  assert.deepEqual(ptys[0]!.size, [45, 30]);
  mgr.detach("t1", phone.c);
  assert.deepEqual(ptys[0]!.size, [120, 40], "desk, not tablet: it interacted last");
  mgr.detach("t1", tablet.c);
  assert.deepEqual(ptys[0]!.size, [120, 40], "a non-owner leaving changes nothing");
});

test("a snapshot deferred by one viewer's detach is not written after another viewer kills the session", async () => {
  const writes: string[] = [];
  const evicts: string[] = [];
  const ptys: FakePty[] = [];
  const mgr = new SessionManager((spec) => { const p = new FakePty(spec); ptys.push(p); return p; }, {
    onSnapshot: (id) => { writes.push(id); },
    onSnapshotEvict: (id) => { evicts.push(id); },
  });
  const v = (): SessionClient => ({ onData: () => {}, onExit: () => {} });
  const dropped = v(), killer = v();
  await mgr.createOrAttach("t1", spec(80, 24), dropped);
  await mgr.createOrAttach("t1", spec(80, 24), killer);
  ptys[0]!.emit("output that makes it dirty\r\n");
  mgr.detach("t1", dropped);
  mgr.kill("t1", killer);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(evicts, ["t1"]);
  assert.deepEqual(writes, [], "the killed session's snapshot must not come back");
});

test("a returning viewer gets exactly the output it missed; another epoch or a too-old gap is refused", async () => {
  const { mgr, ptys, viewer } = setup();
  const first = viewer();
  const r = await mgr.createOrAttach("t1", spec(80, 24), first.c);
  const seen: { seq?: number } = {};
  mgr.detach("t1", first.c);
  ptys[0]!.emit("abc");
  const back = viewer();
  back.c.onData = (d, seq) => { back.got.push(d); seen.seq = seq; };
  const d = mgr.attachDelta("t1", back.c, { seq: r.seq, epoch: r.epoch }, 80, 24);
  assert.equal(d?.replay, "abc");
  assert.equal(d?.seq, r.seq + 3);
  ptys[0]!.emit("de");
  assert.deepEqual(back.got, ["de"]);
  assert.equal(seen.seq, r.seq + 5);
  assert.equal(mgr.attachDelta("t1", viewer().c, { seq: 1, epoch: "other" }, 80, 24), null);
  ptys[0]!.emit("x".repeat(300 * 1024));
  assert.equal(mgr.attachDelta("t1", viewer().c, { seq: r.seq, epoch: r.epoch }, 80, 24), null, "older than the ring");
});

test("a fresh attach clears a pause left by a viewer whose link died", async () => {
  const { mgr, ptys, viewer } = setup();
  const dead = viewer(), back = viewer();
  await mgr.createOrAttach("t1", spec(80, 24), dead.c);
  mgr.pause("t1", dead.c);
  assert.equal(ptys[0]!.paused, true);
  await mgr.createOrAttach("t1", spec(80, 24), back.c);
  assert.equal(ptys[0]!.paused, false);
});

test("a snapshot's position never counts output its replay lacks", async () => {
  const { mgr, ptys, viewer } = setup();
  await mgr.createOrAttach("t1", spec(80, 24), viewer().c);
  ptys[0]!.emit("hello ");
  const pending = mgr.snapshot("t1");
  ptys[0]!.emit("LOST");
  const snap = (await pending)!;
  assert.equal(snap.seq, 10);
  assert.ok(snap.replay.includes("LOST"), JSON.stringify(snap.replay));
});
