// A pty that takes no signals, as on Windows (its kill throws when given one), is still ended by a
// sleep, and kept to be woken; one that ends by itself as it is put to sleep is kept asleep too.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { SessionManager, type ManagedPty, type SessionSnapshot, type SpawnSpec } from "../src/pty-session-manager.ts";

class NoSignals implements ManagedPty {
  // A process that has ended, so no group is signalled in its name.
  readonly pid = spawnSync("true").pid!;
  private ended?: (code: number, signal: number | undefined) => void;
  constructor(readonly spec: SpawnSpec) {}
  write(): void {}
  resize(): void {}
  kill(signal?: string): void {
    if (signal) throw new Error("Signals not supported on windows.");
    setTimeout(() => this.ended?.(0, undefined), 10);
  }
  onData(): void {}
  onExit(cb: (code: number, signal: number | undefined) => void): void { this.ended = cb; }
  /** It ends by itself. */
  end(): void { this.ended?.(0, undefined); }
}

test("a pty that takes no signals is ended by a sleep, and kept", async () => {
  const saved = new Map<string, SessionSnapshot>();
  const manager = new SessionManager((spec) => new NoSignals(spec), {
    onSnapshot: (id, snap) => { saved.set(id, snap); },
    loadSnapshot: (id) => saved.get(id),
  });
  await manager.createOrAttach("t1", { cwd: "/", cmd: "agent", args: [], cols: 80, rows: 24 }, { onData: () => {}, onExit: () => {} });
  expect(await manager.sleep("t1")).toBe(true);
  expect(saved.get("t1")?.sleeping).toBe(true);
}, 5_000);

test("one that ends by itself as it is put to sleep, before its screen is read, is saved asleep", async () => {
  const saved = new Map<string, SessionSnapshot>();
  let pty!: NoSignals;
  const manager = new SessionManager((spec) => (pty = new NoSignals(spec)), {
    onSnapshot: (id, snap) => { saved.set(id, snap); },
    loadSnapshot: (id) => saved.get(id),
  });
  await manager.createOrAttach("t2", { cwd: "/", cmd: "agent", args: [], cols: 80, rows: 24 }, { onData: () => {}, onExit: () => {} });
  const slept = manager.sleep("t2");
  pty.end();
  expect(await slept).toBe(true);
  expect(saved.get("t2")?.sleeping, "after a restart, only a wake starts it").toBe(true);
}, 5_000);
