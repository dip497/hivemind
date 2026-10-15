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
