// What waits on the person (needs.ts, spec/needs.md), held to conformance/needs.json's cases for a
// device: its boards, its agents' statuses and the plans they hand off, the machines it knows and
// which agents' permissions it can decide, in; the list its owner's phone is answered, each agent
// with the machine it runs on, and how many agents are at work, out. The phone's side is held to
// the same file in crates/hive-phone. And a participant's computer is named for whose it is, as
// the device's lists have them.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AccessLists } from "@hivemind/workspace-host/access";
import { certifyDevice, idOf, newSeed, newWorkspaceId } from "@hivemind/workspace-host/identity";
import { needsOf, participantNamed, workingIn, type HeldBoard, type WaitingStatus } from "../src/needs.ts";
import type { PlanReview } from "@hivemind/workspace-api/plans";
import type { KnownMachines } from "@hivemind/core/remote-uri";

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../conformance/needs.json");
const { known, computer: cases } = JSON.parse(fs.readFileSync(file, "utf8")) as {
  known: { self: { device: string; name: string }; mine: Record<string, string>; whose: Record<string, string>; saved: Record<string, string> };
  computer: Array<{ about: string; held: HeldBoard[]; statuses: WaitingStatus[]; plans: PlanReview[]; decides?: string[]; needs: unknown[]; working: number }>;
};
/** The machines the case's device knows, as the file names them. */
const machines: KnownMachines = {
  self: () => known.self,
  mine: (device) => known.mine[device],
  whose: (device) => known.whose[device],
  saved: (id) => known.saved[id],
};

test("what waits on the person is the spec's: each agent waiting on them, called as the spec says, on the machine it runs on, a permission it can allow or deny said so, the one waiting longest first; and how many are at work", () => {
  assert.ok(cases.length > 0);
  for (const c of cases) {
    assert.deepEqual(needsOf(c.held, c.statuses, c.plans, machines, (tile) => (c.decides ?? []).includes(tile)), c.needs, c.about);
    assert.equal(workingIn(c.held, c.statuses), c.working, c.about);
  }
});

test("a participant's computer is named for whose it is: the person on a workspace's list who showed a certificate for it, by the name they gave; a device on no list is no one's", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "needs-"));
  try {
    const lists = new AccessLists({ dir: path.join(dir, "access"), owner: newSeed() });
    const [api, web] = [newWorkspaceId(), newWorkspaceId()];
    const [priya, sam] = [newSeed(), newSeed()];
    const [hers, his, nobodys] = [idOf(newSeed()), idOf(newSeed()), idOf(newSeed())];
    lists.grant(api, idOf(priya), "edit");
    lists.addDevice(api, certifyDevice(priya, hers));
    lists.remember(api, idOf(priya), { name: "Priya", color: "" });
    // Sam, let into another workspace, gave no name.
    lists.grant(web, idOf(sam), "view");
    lists.addDevice(web, certifyDevice(sam, his));
    assert.deepEqual([hers, his, nobodys].map((device) => participantNamed(lists, device)), ["Priya", "", undefined]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
