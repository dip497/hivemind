// A session put to sleep whose program ends on its own before its screen at sleep is taken is
// still saved as asleep: started again, it waits to be woken like any other sleeper.
import { expect, test } from "bun:test";
import { SessionManager, type ManagedPty, type SessionSnapshot } from "../src/pty-session-manager.ts";

test("a program that ends on its own as it is put to sleep is saved asleep", async () => {
  let emit: ((d: string) => void) | undefined;
  let exit: ((code: number, signal: number | undefined) => void) | undefined;
  const pty: ManagedPty = {
    pid: process.pid, write: () => {}, resize: () => {}, kill: () => {},
    onData: (cb) => { emit = cb; }, onExit: (cb) => { exit = cb; },
  };
  const saved = new Map<string, SessionSnapshot>();
  const m = new SessionManager(() => pty, {
    onSnapshot: (id, snap) => { saved.set(id, snap); },
    loadSnapshot: (id) => saved.get(id),
  });
  await m.createOrAttach("t1", { cwd: "/", cmd: "sh", args: [], cols: 80, rows: 24 }, { onData: () => {}, onExit: () => {} });
  emit!("working\r\n");
  const slept = m.sleep("t1");
  exit!(0, undefined);
  expect(await slept).toBe(true);
  expect(saved.get("t1")?.sleeping).toBe(true);
  expect(saved.get("t1")?.replay).toContain("working");
});
