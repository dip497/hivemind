// What waits on the person (needs.ts, spec/needs.md), held to conformance/needs.json's cases for a
// device: its boards, its agents' statuses and what they wait on an answer for, the machines it knows and
// which waits each agent says the keys for, in; the list its owner's phone is answered, each agent
// with the machine it runs on, and how many agents are at work, out. The phone's side is held to
// the same file in crates/hive-phone. A participant's computer is named for whose it is, as the
// device's lists have them. And the keys for what an agent waits on are its manifest's.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AccessLists } from "@hivemind/workspace-host/access";
import { certifyDevice, idOf, newSeed, newWorkspaceId } from "@hivemind/workspace-host/identity";
import { AGENT_MANIFEST_VERSION, defFromManifest, setCatalog } from "@hivemind/agents";
import { agentOf, answerKeys, heldBoards, manifestOf, needsOf, participantNamed, workingIn, type HeldBoard, type WaitingStatus } from "../src/needs.ts";
import { WorkspaceStore } from "@hivemind/workspace-host/store";
import type { Wait } from "../src/waits.ts";
import type { KnownMachines } from "@hivemind/core/remote-uri";
import type { ToolAsked } from "@hivemind/workspace-api/agents";

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../conformance/needs.json");
const { known, computer: cases } = JSON.parse(fs.readFileSync(file, "utf8")) as {
  known: { self: { device: string; name: string }; mine: Record<string, string>; whose: Record<string, string>; saved: Record<string, string> };
  computer: Array<{ about: string; held: HeldBoard[]; statuses: WaitingStatus[]; waits: Record<string, Wait>; keys?: Record<string, string[]>; asking?: Record<string, ToolAsked>; choose?: string[]; needs: unknown[]; working: number }>;
};
/** Whether the agent of a tile says the keys for what it waits on, by the wait's name, as the case
 *  lists them. */
const answeredBy = (keys: Record<string, string[]> = {}) => (tile: string, status: { kind?: string; says?: string }): boolean =>
  (keys[tile] ?? []).includes((status.says ?? status.kind)!);
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
    const facts = { decides: answeredBy(c.keys), wait: (tile: string) => c.waits[tile], asking: (tile: string) => c.asking?.[tile], chooses: (tile: string) => !!c.choose?.includes(tile) };
    assert.deepEqual(needsOf(c.held, c.statuses, machines, facts), c.needs, c.about);
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

test("the keys for a permission an agent asks are its manifest's for what its screen says it is, else for a permission; none for a screen it says none for, another kind, or a tile on no board", () => {
  const permission = { allow: ["1"], deny: ["escape"] };
  const trust = { allow: ["down", "enter"], deny: ["escape"] };
  setCatalog([defFromManifest({
    manifestVersion: AGENT_MANIFEST_VERSION, id: "acme", label: "Acme", bin: "acme",
    caps: { promptDelivery: "typed", turnSignal: false, resume: "none", supervise: "human", blockedDetection: false },
    answer: { permission, trust },
  })]);
  try {
    const held: HeldBoard[] = [{ workspace: "a".repeat(32), name: "api", repo: "/home/p/api", core: { frames: [], tiles: [{ id: "t1", kind: "acme", label: "Acme", cmd: "acme" }] } } as HeldBoard];
    assert.deepEqual(answerKeys(held, "hm:t1", { kind: "permission" }), permission);
    assert.deepEqual(answerKeys(held, "t1", { kind: "permission", says: "trust" }), trust);
    assert.equal(answerKeys(held, "t1", { kind: "permission", says: "settings" }), undefined);
    assert.equal(answerKeys(held, "t1", { kind: "question" }), undefined);
    assert.equal(answerKeys(held, "t1", { kind: "question", says: "trust" }), undefined, "only a permission is allowed or denied");
    assert.equal(answerKeys(held, "t2", { kind: "permission" }), undefined);
  } finally {
    setCatalog([]);
  }
});

test("the boards held are the store's as it is now, after every kind of change: a tile's program, a workspace made, one whose owner arrives with a replica's import, one forgotten; and the same list while nothing changed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "needs-held-"));
  setCatalog(["acme", "zeta"].map((id) => defFromManifest({
    manifestVersion: AGENT_MANIFEST_VERSION, id, label: id, bin: id,
    caps: { promptDelivery: "typed", turnSignal: false, resume: "none", supervise: "human", blockedDetection: false },
  })));
  try {
    const host = new WorkspaceStore({ dir: path.join(dir, "host"), person: newSeed() });
    const layout = (cmd: string) => ({ frames: [], tiles: [{ id: "t1", kind: "claude", label: "Agent", cmd }] });
    host.setCore("/w/api", layout("acme"));
    const first = heldBoards(host);
    assert.equal(manifestOf(first, "hm:t1")?.id, "acme");
    assert.equal(heldBoards(host), first, "nothing changed: the same list");
    host.setCore("/w/api", layout("zeta"));
    assert.equal(manifestOf(heldBoards(host), "t1")?.id, "zeta", "the tile's program changed");
    host.setCore("/w/web", { frames: [], tiles: [{ id: "t2", kind: "claude", label: "Web", cmd: "acme" }] });
    assert.deepEqual(heldBoards(host).map((b) => b.name), ["api", "web"]);
    assert.equal(agentOf(heldBoards(host), "t2")?.workspace, host.ownership("/w/web")!.workspaceId);

    // A replica keeps no person: its copy says whose it is only once the host's document is in.
    const replica = new WorkspaceStore({ dir: path.join(dir, "replica") });
    assert.equal(replica.getCore("/w/api"), null);
    assert.deepEqual(heldBoards(replica), [], "no owner yet: not held");
    replica.importFrom("/w/api", host.exportSince("/w/api", null));
    assert.deepEqual(heldBoards(replica).map((b) => [b.workspace, b.name]), [[host.ownership("/w/api")!.workspaceId, "api"]]);

    host.forget("/w/web");
    assert.deepEqual(heldBoards(host).map((b) => b.name), ["api"]);
    assert.equal(agentOf(heldBoards(host), "t2"), null);
  } finally {
    setCatalog([]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
