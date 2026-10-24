// The scheduler (scheduler.ts) the PR watcher runs on: started, it runs its task on its beat, the
// first run when asked; never two runs at once; stopped, it runs nothing more.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { Repeating } from "../src/scheduler.ts";

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

test("it runs on its beat while started, and not at all once stopped", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let runs = 0;
    const r = new Repeating(async () => { runs++; }, 1000);
    r.start(10);
    mock.timers.tick(9);
    await flush();
    assert.equal(runs, 0);
    mock.timers.tick(1);
    await flush();
    assert.equal(runs, 1, "the first run when asked");
    mock.timers.tick(1000);
    await flush();
    assert.equal(runs, 2, "then on the beat");
    r.stop();
    mock.timers.tick(5000);
    await flush();
    assert.equal(runs, 2, "stopped: nothing more");
    assert.equal(r.started, false);
  } finally {
    mock.timers.reset();
  }
});

test("a run that outlasts the beat is never overlapped, and a failure does not stop the beat", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let running = 0;
    let most = 0;
    let runs = 0;
    let release: () => void = () => {};
    const failures: unknown[] = [];
    const r = new Repeating(async () => {
      runs++;
      running++;
      most = Math.max(most, running);
      if (runs === 1) await new Promise<void>((res) => { release = res; });
      running--;
      if (runs === 2) throw new Error("gh is down");
    }, 100, (e) => failures.push(e));
    r.start(0);
    mock.timers.tick(0);
    await flush();
    mock.timers.tick(500);
    await flush();
    assert.equal(runs, 1, "the slow run is still going: no second one");
    release();
    await flush();
    mock.timers.tick(100);
    await flush();
    assert.equal(runs, 2);
    mock.timers.tick(100);
    await flush();
    assert.equal(runs, 3, "the failed run did not stop the beat");
    assert.equal(most, 1);
    assert.equal(failures.length, 1);
    r.stop();
  } finally {
    mock.timers.reset();
  }
});

test("stopped while a run is going, it arms nothing after it; started again meanwhile, it goes on", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let runs = 0;
    let release: () => void = () => {};
    const r = new Repeating(async () => { runs++; await new Promise<void>((res) => { release = res; }); }, 100);
    r.start(0);
    mock.timers.tick(0);
    await flush();
    r.stop();
    release();
    await flush();
    mock.timers.tick(1000);
    await flush();
    assert.equal(runs, 1, "stopped mid-run: no next run");
    r.start(0);
    mock.timers.tick(0);
    await flush();
    r.stop();
    r.start(5);
    release();
    await flush();
    mock.timers.tick(100);
    await flush();
    assert.equal(runs, 3, "restarted mid-run: the beat goes on from the run's end, once");
    r.stop();
  } finally {
    mock.timers.reset();
  }
});
