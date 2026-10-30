/**
 * 0007 on a machines.json saved before a machine said whether it keeps `hive`
 * (fixtures/0007/before): each machine keeps it, and nothing else about it changes. Killed at 20
 * points and run again, it ends as a clean run does.
 */
import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { readMachines } from "../machines.js";
import { TestRoot } from "./fixtures/runs.js";

const FIXTURE = path.join(import.meta.dir, "fixtures", "0007", "before");
let t: TestRoot;
afterEach(() => t.remove());

const endState = () => t.read("machines.json");

describe("machines saved before keep the hive the app put there", () => {
  test("each machine keeps it, and nothing else about it changes", async () => {
    t = new TestRoot(FIXTURE);
    const before = t.read("machines.json").machines;
    t.runOnce();
    const after = await readMachines(path.join(t.root, "machines.json"));
    expect(after.map((m) => m.installHive)).toEqual([true, true]);
    expect(after.map(({ installHive: _kept, ...m }) => m)).toEqual(before);
  });

  test("killed at 20 points and run again, it ends as a clean run does", async () => {
    t = new TestRoot(FIXTURE);
    const { clean, ends, cutOff } = await t.killedAndRunAgain(endState);
    for (const end of ends) expect(end).toEqual(clean);
    expect(cutOff).toBe(20);
  }, 240_000);
});
