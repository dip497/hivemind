// What waits on the person (needs.ts, spec/needs.md), held to conformance/needs.json's cases for a
// device: its boards, its agents' statuses and the plans they hand off, in; the list its owner's
// phone is answered, and how many agents are at work, out. The phone's side is held to the same
// file in crates/hive-phone.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { needsOf, workingIn, type HeldBoard, type WaitingStatus } from "../src/needs.ts";
import type { PlanReview } from "@hivemind/workspace-api/plans";

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../conformance/needs.json");
const cases = (JSON.parse(fs.readFileSync(file, "utf8")) as {
  computer: Array<{ about: string; held: HeldBoard[]; statuses: WaitingStatus[]; plans: PlanReview[]; needs: unknown[]; working: number }>;
}).computer;

test("what waits on the person is the spec's: each agent waiting on them, called as the spec says, the one waiting longest first; and how many are at work", () => {
  assert.ok(cases.length > 0);
  for (const c of cases) {
    assert.deepEqual(needsOf(c.held, c.statuses, c.plans), c.needs, c.about);
    assert.equal(workingIn(c.held, c.statuses), c.working, c.about);
  }
});
