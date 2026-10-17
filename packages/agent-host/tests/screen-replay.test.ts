// A session's screen, as a window that shows it again is sent it: drawn into a terminal of the
// session's size, it is the screen the session has now.
import { test, expect } from "bun:test";
import { Terminal } from "@xterm/headless";
import { SessionManager, type ManagedPty } from "../src/pty-session-manager.ts";

function fakePty() {
  let emit: ((d: string) => void) | undefined;
  const pty: ManagedPty = {
    pid: 1234,
    write: () => {},
    resize: () => {},
    kill: () => {},
    onData: (cb) => { emit = cb; },
    onExit: () => {},
  };
  return { pty, say: (d: string) => emit?.(d) };
}

async function session(cols: number, rows: number) {
  const f = fakePty();
  const m = new SessionManager(() => f.pty);
  await m.createOrAttach("t1", { cwd: "/", cmd: "sh", args: [], cols, rows }, { onData: () => {}, onExit: () => {} });
  return { m, say: f.say };
}

/** The screen a window draws from `replay`, at `cols` x `rows`. */
async function drawn(replay: string, cols: number, rows: number) {
  const t = new Terminal({ cols, rows, scrollback: 100, allowProposedApi: true });
  await new Promise<void>((r) => t.write(replay, r));
  const b = t.buffer.active;
  const lines = Array.from({ length: b.length }, (_, y) => b.getLine(y)?.translateToString(true) ?? "").filter(Boolean);
  return { lines, cursor: [b.cursorY, b.cursorX] };
}

test("a screen asked for while output is still arriving, then again, shows all of that output", async () => {
  const s = await session(80, 24);
  s.say("$ make\r\n");
  const first = s.m.snapshot("t1");
  s.say("built in 3s\r\n$ ");
  const second = s.m.snapshot("t1");
  await first;
  const screen = await drawn((await second)!.replay, 80, 24);
  expect(screen.lines).toEqual(["$ make", "built in 3s", "$ "]);
});

test("a screen asked for after the session is resized puts the cursor where the session has it", async () => {
  const s = await session(80, 24);
  s.say("$ " + "A".repeat(100));
  await s.m.snapshot("t1");
  s.m.resize("t1", 120, 24);
  const screen = await drawn((await s.m.snapshot("t1"))!.replay, 120, 24);
  const fresh = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  await new Promise<void>((r) => fresh.write("$ " + "A".repeat(100), r));
  fresh.resize(120, 24);
  await new Promise<void>((r) => fresh.write("", r));
  expect(screen.cursor).toEqual([fresh.buffer.active.cursorY, fresh.buffer.active.cursorX]);
});

test("a screen asked for while more output arrives than the daemon keeps of it still shows the session's screen", async () => {
  const s = await session(80, 24);
  s.say("\x1b[31m");
  const asked = s.m.snapshot("t1");
  // 400 K chars, more than the recent output kept for viewers; all still red.
  for (let i = 0; i < 100; i++) s.say(`line ${i} ${"x".repeat(3990)}\r\n`);
  const replay = (await asked)!.replay;
  const screen = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  await new Promise<void>((r) => screen.write(replay, r));
  const b = screen.buffer.active;
  expect(b.getLine(b.baseY)?.getCell(0)?.getFgColor()).toBe(1);
});

test("a session printing faster than its screen keeps up is paused until it does", async () => {
  let paused = 0;
  let resumed = 0;
  const f = fakePty();
  // A live pid: a paused pty whose program has ended is resumed to read its last output.
  const m = new SessionManager(() => ({ ...f.pty, pid: process.pid, pause: () => { paused++; }, resume: () => { resumed++; } }));
  await m.createOrAttach("t1", { cwd: "/", cmd: "sh", args: [], cols: 80, rows: 24 }, { onData: () => {}, onExit: () => {} });
  for (let i = 0; i < 400; i++) f.say(`${"y".repeat(16_000)}\r\n`);
  expect(paused).toBe(1);
  expect(resumed).toBe(0);
  await m.snapshot("t1");
  for (let i = 0; i < 500 && resumed === 0; i++) await new Promise((r) => setTimeout(r, 10));
  expect(resumed).toBe(1);
}, 60_000);

test("a session started again under the same id does not take the ended one's title", async () => {
  const fakes: Array<ReturnType<typeof fakePty>> = [];
  const m = new SessionManager(() => { const f = fakePty(); fakes.push(f); return f.pty; });
  const spec = { cwd: "/", cmd: "sh", args: [], cols: 80, rows: 24 };
  await m.createOrAttach("t1", spec, { onData: () => {}, onExit: () => {} });
  fakes[0]!.say("\x1b]0;the ended one\x07$ ");
  m.kill("t1");
  await m.createOrAttach("t1", spec, { onData: () => {}, onExit: () => {} });
  fakes[1]!.say("$ ");
  expect((await m.snapshot("t1"))!.replay).not.toContain("the ended one");
});

test("a session started again under the same id does not show what the ended one printed last", async () => {
  const fakes: Array<ReturnType<typeof fakePty>> = [];
  const m = new SessionManager(() => { const f = fakePty(); fakes.push(f); return f.pty; });
  const spec = { cwd: "/", cmd: "sh", args: [], cols: 80, rows: 24 };
  await m.createOrAttach("t1", spec, { onData: () => {}, onExit: () => {} });
  m.kill("t1");
  await m.createOrAttach("t1", spec, { onData: () => {}, onExit: () => {} });
  // A killed program's last output can still arrive after its id is taken again.
  fakes[0]!.say("the ended one's goodbye\r\n");
  fakes[1]!.say("$ ");
  expect((await m.snapshot("t1"))!.replay).not.toContain("goodbye");
});
