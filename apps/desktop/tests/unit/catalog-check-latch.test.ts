// The once-per-launch catalog check: a run that FAILED does not count as the run.
// (The handler itself needs Electron; this pins the rule it implements.)
import { test } from "node:test";
import assert from "node:assert/strict";

/** The shape of the guard in plugin-catalog-ipc's `agents:auto-install` handler. */
function makeCheck(run: () => Promise<string>) {
  let checked = false;
  let inflight: Promise<string> | null = null;
  return async function check(): Promise<string> {
    if (checked) return "skipped";
    if (inflight) return inflight;
    inflight = run();
    try {
      const out = await inflight;
      checked = true;
      return out;
    } catch {
      return "failed";
    } finally {
      inflight = null;
    }
  };
}

test("a failed check can be asked again; a successful one is the last", async () => {
  let attempts = 0;
  const check = makeCheck(async () => {
    attempts++;
    if (attempts < 3) throw new Error("socket closed mid-fetch");
    return "updated";
  });
  assert.equal(await check(), "failed");
  assert.equal(await check(), "failed");
  assert.equal(await check(), "updated", "the third attempt reaches the registry");
  assert.equal(await check(), "skipped", "and then it is done for this launch");
  assert.equal(attempts, 3);
});

test("two asks while one is in flight share it, so the registry is asked once", async () => {
  let attempts = 0;
  let release: (v: string) => void = () => {};
  const check = makeCheck(() => { attempts++; return new Promise<string>((r) => { release = r; }); });
  const a = check();
  const b = check();
  release("updated");
  assert.deepEqual([await a, await b], ["updated", "updated"]);
  assert.equal(attempts, 1);
});
