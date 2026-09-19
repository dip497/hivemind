import { test } from "node:test";
import assert from "node:assert/strict";
import { acquireBoot, bootPosition, cancelBoot, isRestored, markRestored, whenBootIdle } from "../../src/renderer/src/boot-queue.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

test("restored agents start a few at a time and the rest wait in order", async () => {
  const ids = Array.from({ length: 12 }, (_, i) => `t${i}`);
  markRestored(ids);
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  for (const id of ids) void acquireBoot(id).then((rel) => { started.push(id); releases.set(id, rel); });
  await tick();
  const limit = started.length;
  assert.ok(limit >= 2 && limit <= 6, `a bounded number start at once (got ${limit})`);
  assert.equal(bootPosition(ids[limit]!), 0, "the next in line is first");
  assert.equal(bootPosition(ids[limit + 1]!), 1);

  releases.get(ids[0]!)!();
  await tick();
  assert.equal(started.length, limit + 1, "a released slot starts exactly the next tile");
  assert.equal(started.at(-1), ids[limit], "in the order they were restored");
  assert.equal(isRestored(ids[0]!), false, "a tile that has booted is no longer a restore");

  cancelBoot(ids[limit + 1]!);
  assert.equal(bootPosition(ids[limit + 1]!), null, "a tile closed while waiting leaves the line");
  releases.get(ids[0]!)!(); // releasing twice does nothing
  await tick();
  assert.equal(started.length, limit + 1);

  // Drain the queue so later tests start from an idle one.
  while (releases.size) {
    for (const [id, release] of [...releases]) { releases.delete(id); release(); }
    await tick();
  }
});

test("whenBootIdle waits for every started and waiting tile, and is immediate when none", async () => {
  await whenBootIdle(); // nothing booting
  let idle = false;
  const releases = await Promise.all(["i1", "i2"].map((id) => acquireBoot(id)));
  void whenBootIdle().then(() => { idle = true; });
  await tick();
  assert.equal(idle, false);
  releases[0]!();
  await tick();
  assert.equal(idle, false);
  releases[1]!();
  await tick();
  assert.equal(idle, true);
});
