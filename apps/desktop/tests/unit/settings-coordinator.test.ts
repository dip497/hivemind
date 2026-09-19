/**
 * Main's settings operations must be serialized, not merely "freshness
 * checked". The race a sequence number cannot catch:
 *
 *   reload A reads the OLD file → the CLI writes → reload B reads the NEW file
 *   → A publishes first → B is discarded as stale → main holds the OLD value.
 *
 * The CLI writing the file does not publish anything in main, so nothing tells
 * A that its read is the older one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSettingsCoordinator } from "../../src/main/settings-coordinator";

/** A file whose reads can be made to resolve out of order, on demand. */
function fakeFile(initial: string) {
  let content = initial;
  const gates: (() => void)[] = [];
  return {
    write: (next: string) => { content = next; },
    /** Read snapshots `content` NOW and resolves when released. */
    read: () => {
      const snapshot = content;
      return new Promise<string>((resolve) => gates.push(() => resolve(snapshot)));
    },
    releaseAll: () => { while (gates.length) gates.shift()!(); },
    waiting: () => gates.length,
  };
}

/** Drive a queued operation to completion, releasing reads as they open. */
async function drive<T>(file: { releaseAll: () => void }, p: Promise<T>): Promise<T> {
  let done = false;
  const settled = p.then((v) => { done = true; return v; }, (e) => { done = true; throw e; });
  for (let i = 0; i < 100 && !done; i++) { file.releaseAll(); await new Promise((r) => setTimeout(r, 0)); }
  return settled;
}

test("two reloads around a foreign write end on the NEWEST value, in order", async () => {
  const file = fakeFile("old");
  const published: string[] = [];
  const c = createSettingsCoordinator<string>({ read: file.read, publish: (v) => published.push(v) });

  const a = c.reload();          // A starts; its read snapshots "old"
  await Promise.resolve();
  file.write("new");             // the CLI writes — main is told nothing
  const b = c.reload();          // B is queued behind A
  // Serialization means B has not read yet: A must finish first.
  assert.equal(file.waiting(), 1, "only A's read is open");

  assert.equal(await drive(file, a), "old");
  assert.equal(await drive(file, b), "new", "B reads AFTER A published, so it sees the CLI's write");
  assert.deepEqual(published, ["old", "new"], "publishes are ordered, nothing dropped");
  assert.equal(published.at(-1), "new", "main ends up holding the newest read");
});

test("a write and a reload never interleave; the last operation's value is the settled one", async () => {
  const file = fakeFile("v0");
  const published: string[] = [];
  const c = createSettingsCoordinator<string>({ read: file.read, publish: (v) => published.push(v) });

  const write = c.mutate(async () => { file.write("v1"); return "v1"; });
  const reload = c.reload();
  assert.equal(await drive(file, write), "v1");
  assert.equal(await drive(file, reload), "v1", "the reload reads what the write left");
  assert.deepEqual(published, ["v1", "v1"]);
});

test("a failed operation does not wedge the queue", async () => {
  const file = fakeFile("v0");
  const published: string[] = [];
  const c = createSettingsCoordinator<string>({ read: file.read, publish: (v) => published.push(v) });

  const bad = c.mutate(async () => { throw new Error("settings.json is locked"); });
  await assert.rejects(bad, /locked/);
  const after = c.reload();
  assert.equal(await drive(file, after), "v0");
  assert.deepEqual(published, ["v0"], "the failed op published nothing; the next one still ran");
  assert.equal(c.depth(), 0);
});
