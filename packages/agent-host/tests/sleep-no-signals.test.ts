// A pty that takes no signals, as on Windows (its kill throws when given one), is still ended by a
// sleep, and kept to be woken; one that ends by itself as it is put to sleep is kept asleep too; one
// whose wake cannot start it (its folder gone, say) stays asleep, to be woken once it can.
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

test("a wake that cannot start it leaves it asleep, to be woken once it can", async () => {
  const saved = new Map<string, SessionSnapshot>();
  let fails = false;
  const manager = new SessionManager((spec) => { if (fails) throw new Error("no such folder"); return new NoSignals(spec); }, {
    onSnapshot: (id, snap) => { saved.set(id, snap); },
    loadSnapshot: (id) => saved.get(id),
  });
  const spec = { cwd: "/", cmd: "agent", args: [], cols: 80, rows: 24 };
  const client = { onData: () => {}, onExit: () => {} };
  await manager.createOrAttach("t3", spec, client);
  expect(await manager.sleep("t3")).toBe(true);
  fails = true;
  await expect(manager.createOrAttach("t3", spec, client, false, undefined, true)).rejects.toThrow("no such folder");
  fails = false;
  expect((await manager.createOrAttach("t3", spec, client, false, undefined, true)).isNew).toBe(true);
}, 5_000);
