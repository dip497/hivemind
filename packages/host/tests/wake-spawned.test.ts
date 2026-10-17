// A session the host wakes (spawned.ts wakeSpawned) says it is ready once its agent is at its
// prompt, as a first task waits for: not while its screen is blank or still being drawn, but once it
// has been drawn and quiet a moment; one that ends is ready at once (nothing waits on it), and so is
// one that did not start.
import { test } from "node:test";
import assert from "node:assert/strict";
import { wakeSpawned } from "../src/spawned.ts";
import type { Terminals } from "../src/terminals.ts";

const start = { ptyId: "hm:a1", cwd: "/work/api", cmd: "acme", args: [] };

function waker(pid = 7) {
  let watch!: { data(data: string): void; exit(): void };
  let screen = "";
  const asked: unknown[] = [];
  const terminals = {
    own: async (opts: unknown, w: typeof watch) => { asked.push(opts); watch = w; return { pid }; },
  } as unknown as Pick<Terminals, "own">;
  const woken = wakeSpawned({ terminals, holds: () => true, status: () => "idle", screen: async () => screen }, start);
  let ready = false;
  void woken.then((w) => w.ready.then(() => { ready = true; }));
  return {
    woken, asked,
    ready: () => ready,
    draw: (text: string) => { screen = text; watch.data(text); },
    end: () => watch.exit(),
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("woken, it is ready once its screen is drawn and quiet, not while blank or being drawn", async () => {
  const w = waker();
  assert.equal((await w.woken).pid, 7);
  assert.deepEqual(w.asked, [{ tileId: "hm:a1", cwd: "/work/api", cmd: "acme", args: [], cols: 120, rows: 36, wake: true }]);
  await wait(3000);
  assert.equal(w.ready(), false, "a blank screen is an agent still loading");
  for (let i = 0; i < 4; i++) { w.draw(`resuming ${i}\n> `); await wait(700); }
  assert.equal(w.ready(), false, "still being drawn");
  await wait(4500);
  assert.equal(w.ready(), true);
});

test("one that ends as it wakes is ready at once, and one that did not start too", async () => {
  const w = waker();
  await w.woken;
  w.end();
  await wait(1500);
  assert.equal(w.ready(), true);
  const none = waker(-1);
  await none.woken;
  await wait(300);
  assert.equal(none.ready(), true);
});
