// The write path, end to end through a session: a message is handed to the TUI the way the app
// running there expects — bracketed when it asked for it, one line when it did not.
import { test, expect } from "bun:test";
import { SessionManager, type ManagedPty } from "../src/pty-session-manager.ts";

function fakePty() {
  const wrote: string[] = [];
  let emit: ((d: string) => void) | undefined;
  const pty: ManagedPty = {
    pid: 1234,
    write: (d) => { wrote.push(d); },
    resize: () => {},
    kill: () => {},
    onData: (cb) => { emit = cb; },
    onExit: () => {},
  };
  return { pty, wrote, say: (d: string) => emit?.(d) };
}

/** Let the session's headless terminal parse what the app just said. */
const settled = () => new Promise<void>((r) => setTimeout(r, 30));

async function session(announce: string) {
  const f = fakePty();
  const m = new SessionManager(() => f.pty);
  await m.createOrAttach("t1", { cwd: "/", cmd: "agent", args: [], cols: 80, rows: 24 }, { onData: () => {}, onExit: () => {} });
  f.say(announce);
  await settled();
  f.wrote.length = 0;
  return { m, ...f };
}

test("an app that turned bracketed paste on gets the message as one paste", async () => {
  const s = await session("\x1b[?2004h> ");
  s.m.write("t1", "line one\nline two", undefined, true);
  expect(s.wrote).toEqual(["\x1b[200~line one\nline two\x1b[201~"]);
  // Keystrokes are still keystrokes: the Enter that submits is written as it is.
  s.m.write("t1", "\r");
  expect(s.wrote[1]).toBe("\r");
});

test("an app that did not gets one line, so a newline cannot submit half a prompt", async () => {
  const s = await session("$ ");
  s.m.write("t1", "line one\nline two", undefined, true);
  expect(s.wrote).toEqual(["line one line two"]);
});
