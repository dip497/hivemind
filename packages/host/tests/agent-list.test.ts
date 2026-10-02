// Every agent here, as the person's devices follow them (agent-list.ts, spec/agents.md
// "Following"), held to conformance/agents.json's cases for a device: its boards, its agents'
// statuses and the plans they hand off, the machines it knows, and what its manifests say of each
// tile (the program, whether a permission can be decided, whether a turn can be interrupted), in;
// the list, out. The phone's side is held to the same file in crates/hive-phone.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentsOf } from "../src/agent-list.ts";
import { workingIn, type HeldBoard, type WaitingStatus } from "../src/needs.ts";
import type { PlanReview } from "@hivemind/workspace-api/plans";
import type { KnownMachines } from "@hivemind/core/remote-uri";

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../conformance/agents.json");
const { known, computer: cases } = JSON.parse(fs.readFileSync(file, "utf8")) as {
  known: { self: { device: string; name: string }; mine: Record<string, string>; whose: Record<string, string>; saved: Record<string, string> };
  computer: Array<{
    about: string; held: HeldBoard[]; statuses: WaitingStatus[]; plans: PlanReview[];
    programs: Record<string, { id: string; label: string }>; decides?: string[]; interrupts: string[];
    agents: unknown[]; working: number;
  }>;
};
const machines: KnownMachines = {
  self: () => known.self,
  mine: (device) => known.mine[device],
  whose: (device) => known.whose[device],
  saved: (id) => known.saved[id],
};

test("every agent here is the spec's: its state and since when, what it waits on, the program it runs, the machine it runs on and whether its turn can be interrupted, in order of workspace and tile; and how many are at work", () => {
  assert.ok(cases.length > 0);
  for (const c of cases) {
    const facts = {
      program: (tile: string) => c.programs[tile],
      decides: (tile: string) => (c.decides ?? []).includes(tile),
      interrupts: (tile: string) => c.interrupts.includes(tile),
    };
    assert.deepEqual(agentsOf(c.held, c.statuses, c.plans, machines, facts), c.agents, c.about);
    assert.equal(workingIn(c.held, c.statuses), c.working, c.about);
  }
});
