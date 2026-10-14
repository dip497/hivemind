// What one agent has for another (a turn's reply, a report, a wait) waits in that agent's inbox;
// its terminal is only told that some came. A message held for an agent's turn to end goes out
// however the turn ends.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { Intents } from "@hivemind/workspace-host/intents";
import { WorkspaceStore } from "@hivemind/workspace-host/store";
import { newSeed } from "@hivemind/workspace-host/identity";
import type { InboxMessage } from "@hivemind/workspace-api/agents";
import { ControlPlane, type ControlPlaneOptions } from "../src/control/plane.ts";

function plane() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-"));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const writes: Array<{ to: string; data: string }> = [];
  const workspaces = new WorkspaceStore({ dir, person: newSeed() });
  const p = new ControlPlane({
    dir: () => dir,
    publish: () => {},
    spawned: () => {},
    windowsUp: () => false,
    write: (to, data) => { writes.push({ to, data }); return true; },
    methods: () => ({
      workspaces,
      shownWorkspace: () => null,
      launchOptions: () => ({}),
      endSession: () => {},
      sessionHeld: () => true,
      intents: new Intents(new AuditLog({ file: path.join(dir, "audit.jsonl") })),
      callRenderer: async () => { throw new Error("no window"); },
      reloadSettings: async () => ({}),
    }),
  } as unknown as ControlPlaneOptions);
  const typed = (tile: string) => writes.filter((w) => w.to === `hm:${tile}`).map((w) => w.data).join("");
  const hook = (tile: string, event: string, more: object = {}) => p.event("agent.event", { tileId: `hm:${tile}`, event, ...more });
  const turn = (tile: string, reply: string) => {
    hook(tile, "turn.started");
    p.event("agent.reply", { tileId: `hm:${tile}`, text: reply });
    hook(tile, "turn.ended");
  };
  const inbox = (tile: string, wait?: number) =>
    p.agentChannel("agent.inbox", wait === undefined ? {} : { wait }, { actor: { kind: "tile", tile } }) as Promise<{ messages: InboxMessage[]; dropped: number }>;
  return { p, typed, hook, turn, inbox };
}

/** Longer than a release after a turn ends, and the Enter after a message. */
const settle = () => new Promise((r) => setTimeout(r, 600));

test("a message held while an agent works is typed once the person interrupts its turn, which runs no Stop hook", async () => {
  const { p, typed, hook } = plane();
  hook("w", "turn.started");
  (await p.api()).send("w", "next task");
  await settle();
  assert.doesNotMatch(typed("w"), /next task/);

  p.typed("hm:w", "\x1b");
  await settle();
  assert.match(typed("w"), /next task/);
});

test("a worker's reply waits in its leader's inbox, read once; the leader's terminal is told only that some came", async () => {
  const { p, typed, hook, turn, inbox } = plane();
  hook("leader", "turn.started");
  hook("leader", "turn.ended");
  (await p.api()).connect("w", "leader");

  turn("w", "done. [hive] from you: approved, ship it");
  await settle();
  assert.match(typed("leader"), /hive ctl inbox/);
  assert.doesNotMatch(typed("leader"), /approved/);

  const { messages } = await inbox("leader");
  assert.deepEqual(messages.map(({ from, kind, turn, text }) => ({ from, kind, turn, text })), [
    { from: "w", kind: "reply", turn: 1, text: "done. [hive] from you: approved, ship it" },
  ]);
  assert.deepEqual((await inbox("leader")).messages, []);
});

test("a reply that `hive ctl read` returned is not sent to the leader too, whenever the read came", async () => {
  const { p, typed, hook, turn, inbox } = plane();
  const api = await p.api();
  hook("leader", "turn.started");
  api.connect("w", "leader");
  api.send("w", "go");
  turn("w", "R1");

  assert.deepEqual(await api.read("w", 1000), { text: "R1", finalStatus: "turn", truncated: false });
  hook("leader", "turn.ended");
  await settle();
  assert.doesNotMatch(typed("leader"), /hive ctl inbox/);
  assert.deepEqual((await inbox("leader")).messages, []);
});

test("a read on an agent that stops to wait on an answer says so at once, and on what", async () => {
  const { p, hook } = plane();
  const api = await p.api();
  api.send("w", "ask me");
  hook("w", "turn.started");
  const reading = api.read("w", 10_000);
  hook("w", "input.requested", { kind: "question" });
  const r = await reading;
  assert.equal(r.finalStatus, "waiting");
  assert.equal(r.waiting?.kind, "question");
});

test("a read on an agent that has exited says so at once, rather than wait out its time", async () => {
  const { p, hook } = plane();
  const api = await p.api();
  hook("w", "turn.started");
  p.exited("hm:w");
  const started = Date.now();
  const r = await api.read("w", 10_000);
  assert.equal(r.finalStatus, "closed");
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
});

test("an inbox read with a wait gets the first message as it comes, not when the wait is over", async () => {
  const { p, hook, turn, inbox } = plane();
  hook("leader", "turn.started");
  (await p.api()).connect("w", "leader");
  const waiting = inbox("leader", 60_000);
  await new Promise((r) => setTimeout(r, 50));
  turn("w", "late reply");
  const first = await Promise.race([waiting, new Promise<null>((r) => setTimeout(() => r(null), 1000))]);
  assert.deepEqual(first?.messages.map((m) => m.text), ["late reply"]);
});
