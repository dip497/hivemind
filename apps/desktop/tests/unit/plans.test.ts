// Plans agents hand off for review (workspace/plans.ts, M2): every client is told of each one, and
// one that asks later finds those of its workspace waiting; the first answer is the one the agent
// gets, and everyone is told who gave it, while a later one changes nothing and hears who was
// first; an answer about another tile's plan answers nothing; a plan whose agent stops waiting is
// told as answered by nobody; and an answer is the answerer's intent, on the agent's tile.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Intents, type Actor } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { WorkspaceServer, type Connection } from "@hivemind/workspace-api/server";
import type { EventMessage } from "@hivemind/workspace-api/protocol";
import { Plans } from "../../src/main/workspace/plans.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-plans-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let logs = 0;
const PRIYA = "b".repeat(64);
const guestActor: Actor = { kind: "peer", person: PRIYA, device: "d".repeat(64), access: "agents" };

function host() {
  const file = path.join(tmp, `audit-${logs++}.jsonl`);
  let server!: WorkspaceServer;
  const plans = new Plans({
    publish: (event, ...params) => server.publish(event, ...params),
    who: (c) => (c.actor.kind === "peer" ? { person: c.actor.person, name: "Priya" } : { person: "a".repeat(64), name: "Adarsh" }),
    repoOf: (tile) => ({ "tile-agent": "/work/api", "tile-other": "/work/web" } as Record<string, string>)[tile] ?? null,
  });
  server = new WorkspaceServer([plans.domain], new Intents(new AuditLog({ file })));
  const client = (actor: Actor) => {
    const received: EventMessage[] = [];
    const c: Connection & { received: EventMessage[] } = { actor, received, send: (m) => received.push(m), closed: new AbortController().signal };
    server.connect(c);
    return c;
  };
  const replies: string[] = [];
  const ask = (requestId: string, tileId = "hm:tile-agent") => plans.ask({ requestId, tileId, plan: "# Plan", cwd: "/work/api" }, (d, f) => replies.push(`${requestId} ${d}${f ? ` ${f}` : ""}`));
  const call = async (from: Connection, method: string, ...params: unknown[]) => {
    const answer = await server.answer(method, params, from);
    if ("error" in answer) throw new Error(answer.error.message);
    return answer.result;
  };
  const told = (c: { received: EventMessage[] }, event: string) => c.received.filter((m) => m.event === event).map((m) => m.params[0]);
  const audited = () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { const { actor, verb, target, detail } = JSON.parse(l); return `${actor.kind} ${verb} ${target} ${detail}`; }) : []);
  return { plans, client, ask, call, told, replies, audited };
}

test("every client is told of a plan an agent hands off; one that asks later finds those of its workspace waiting", async () => {
  const h = host();
  const [win, guest] = [h.client({ kind: "person" }), h.client(guestActor)];
  h.ask("r1");
  h.ask("r2", "hm:tile-other");
  for (const c of [win, guest]) assert.deepEqual(h.told(c, "plan.review").map((r) => (r as { requestId: string }).requestId), ["r1", "r2"]);
  const later = h.client({ kind: "person" });
  assert.deepEqual((await h.call(later, "plan.list", "/work/api") as Array<{ requestId: string }>).map((r) => r.requestId), ["r1"]);
  assert.deepEqual(await h.call(later, "plan.list", "/work/elsewhere"), []);
});

test("the first answer is the one the agent gets, and everyone is told who gave it; a later one changes nothing and hears who was first", async () => {
  const h = host();
  const [win, guest] = [h.client({ kind: "person" }), h.client(guestActor)];
  h.ask("r1");
  assert.deepEqual(await h.call(guest, "plan.decide", "hm:tile-agent", "r1", "deny", "split step 2"), { answered: true, by: { person: PRIYA, name: "Priya" } });
  assert.deepEqual(await h.call(win, "plan.decide", "tile-agent", "r1", "allow"), { answered: false, by: { person: PRIYA, name: "Priya" } });
  assert.deepEqual(h.replies, ["r1 deny split step 2"]);
  for (const c of [win, guest]) assert.deepEqual(h.told(c, "plan.decided"), [{ requestId: "r1", tileId: "hm:tile-agent", decision: "deny", by: { person: PRIYA, name: "Priya" } }]);
  assert.deepEqual(await h.call(win, "plan.list", "/work/api"), []);
  // Each answer is its answerer's intent, on the agent's tile.
  assert.deepEqual(h.audited(), [`peer plan.decide tile-agent deny`, `person plan.decide tile-agent allow`]);
});

test("an answer about another tile's plan answers nothing", async () => {
  const h = host();
  const win = h.client({ kind: "person" });
  h.ask("r1");
  assert.deepEqual(await h.call(win, "plan.decide", "hm:tile-other", "r1", "allow"), { answered: false, by: null });
  assert.deepEqual(h.replies, []);
  assert.equal((await h.call(win, "plan.list", "/work/api") as unknown[]).length, 1);
});

test("a plan whose agent stops waiting is told as answered by nobody, and is waiting no more", async () => {
  const h = host();
  const win = h.client({ kind: "person" });
  h.ask("r1");
  h.plans.drop("r1");
  assert.deepEqual(h.told(win, "plan.decided"), [{ requestId: "r1", tileId: "hm:tile-agent", decision: null, by: null }]);
  assert.deepEqual(await h.call(win, "plan.decide", "hm:tile-agent", "r1", "allow"), { answered: false, by: null });
  assert.deepEqual(h.replies, []);
  assert.deepEqual(await h.call(win, "plan.list", "/work/api"), []);
});
