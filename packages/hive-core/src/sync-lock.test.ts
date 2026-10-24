import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SyncLockedError, syncLockPath, withSyncLock } from "./sync-lock.js";

const SOURCE = "jira:acme/PAY";
const mkRoot = async () => path.join(await fs.mkdtemp(path.join(os.tmpdir(), "hive-synclock-")), ".hivemind");
const holderFile = (root: string) => syncLockPath(root, SOURCE);
/** A pid that is certainly gone: a child that has already exited. */
const deadPid = (): number => spawnSync(process.execPath, ["-e", "0"]).pid!;

async function plant(root: string, h: { pid: number; machine: string; heartbeatAgoMs: number }): Promise<void> {
  const at = new Date(Date.now() - h.heartbeatAgoMs).toISOString();
  await fs.mkdir(path.dirname(holderFile(root)), { recursive: true });
  await fs.writeFile(holderFile(root), JSON.stringify({ pid: h.pid, machine: h.machine, since: at, heartbeat: at, token: "planted" }));
}

describe("sync lock", () => {
  test("a second sync of the same source is refused while the first runs, and allowed once it ends", async () => {
    const root = await mkRoot();
    let ran = false;
    await withSyncLock(root, SOURCE, async () => {
      await expect(withSyncLock(root, SOURCE, async () => { ran = true; })).rejects.toBeInstanceOf(SyncLockedError);
    });
    expect(ran).toBe(false);
    await withSyncLock(root, SOURCE, async () => { ran = true; });
    expect(ran).toBe(true);
    await expect(fs.stat(holderFile(root))).rejects.toThrow(); // released
  });

  test("the lock is released when the work throws", async () => {
    const root = await mkRoot();
    await expect(withSyncLock(root, SOURCE, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await withSyncLock(root, SOURCE, async () => {});
  });

  test("a lock left by a dead process on this machine is taken over, with a note", async () => {
    const root = await mkRoot();
    const pid = deadPid();
    await plant(root, { pid, machine: os.hostname(), heartbeatAgoMs: 0 });
    const notes: string[] = [];
    let ran = false;
    await withSyncLock(root, SOURCE, async () => { ran = true; }, { onTakeover: (n) => notes.push(n) });
    expect(ran).toBe(true);
    expect(notes.join()).toContain(`pid ${pid}`);
  });

  test("another machine's holder is trusted while its heartbeat is fresh, taken over once it is old", async () => {
    const root = await mkRoot();
    await plant(root, { pid: process.pid, machine: "other-box", heartbeatAgoMs: 1_000 });
    await expect(withSyncLock(root, SOURCE, async () => {}, { staleAfterMs: 60_000 })).rejects.toBeInstanceOf(SyncLockedError);
    await plant(root, { pid: process.pid, machine: "other-box", heartbeatAgoMs: 120_000 });
    const notes: string[] = [];
    await withSyncLock(root, SOURCE, async () => {}, { staleAfterMs: 60_000, onTakeover: (n) => notes.push(n) });
    expect(notes.join()).toContain("other-box");
  });

  test("the holder's heartbeat moves while it works, so a long sync is not taken for a dead one", async () => {
    const root = await mkRoot();
    await withSyncLock(root, SOURCE, async () => {
      const first = JSON.parse(await fs.readFile(holderFile(root), "utf8"));
      await new Promise((r) => setTimeout(r, 150));
      const later = JSON.parse(await fs.readFile(holderFile(root), "utf8"));
      expect(Date.parse(later.heartbeat)).toBeGreaterThan(Date.parse(first.heartbeat));
      expect(later.pid).toBe(process.pid);
      expect(later.machine).toBe(os.hostname());
    }, { heartbeatMs: 20 });
  });
});
