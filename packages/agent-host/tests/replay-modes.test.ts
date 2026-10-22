// A session's replay, drawn by a fresh terminal the way a reattaching window draws it: that
// terminal has to report the mouse the way the app asked, or the app ignores every click.
import { test, expect } from "bun:test";
import { Terminal } from "@xterm/headless";
import { SessionManager, type ManagedPty } from "../src/pty-session-manager.ts";

async function replayAfter(said: string): Promise<string> {
  let emit: ((d: string) => void) | undefined;
  const pty: ManagedPty = { pid: 1, write: () => {}, resize: () => {}, kill: () => {}, onData: (cb) => { emit = cb; }, onExit: () => {} };
  const m = new SessionManager(() => pty);
  await m.createOrAttach("t1", { cwd: "/", cmd: "sh", args: [], cols: 80, rows: 24 }, { onData: () => {}, onExit: () => {} });
  emit!(said);
  return (await m.snapshot("t1"))!.replay;
}

/** How a terminal fed `replay` reports the mouse: its tracking mode and its encoding. */
async function reports(replay: string): Promise<[string, string]> {
  const t = new Terminal({ allowProposedApi: true });
  await new Promise<void>((r) => t.write(replay, r));
  const core = (t as unknown as { _core: { mouseStateService: { activeEncoding: string } } })._core;
  return [t.modes.mouseTrackingMode, core.mouseStateService.activeEncoding];
}

test.each([
  ["SGR, asked for by an app tracking every move", "\x1b[?1049h\x1b[?1003h\x1b[?1006hhello", ["any", "SGR"]],
  ["SGR in pixels", "\x1b[?1003h\x1b[?1016h", ["any", "SGR_PIXELS"]],
  ["an app that never asked for the mouse", "hello", ["none", "DEFAULT"]],
])("a replayed session reports the mouse as its app asked: %s", async (_name, said, expected) => {
  expect(await reports(await replayAfter(said))).toEqual(expected);
});

/** The kitty keyboard flags a terminal fed `replay` reads keys with. */
async function kittyFlags(replay: string): Promise<number> {
  const t = new Terminal({ allowProposedApi: true, vtExtensions: { kittyKeyboard: true } });
  await new Promise<void>((r) => t.write(replay, r));
  return (t as unknown as { _core: { coreService: { kittyKeyboard: { flags: number } } } })._core.coreService.kittyKeyboard.flags;
}

test.each([
  ["pushed by an agent on its own screen", "\x1b[?1049h\x1b[>1uprompt", 1],
  ["pushed on the main screen", "\x1b[>3uhello", 3],
  ["a program that never asked", "hello", 0],
])("a replayed session reads keys by the kitty protocol as its program asked: %s", async (_name, said, expected) => {
  expect(await kittyFlags(await replayAfter(said))).toBe(expected);
});
