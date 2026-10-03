// Who is in a workspace (people.ts, M3): its owner sees who is on its list and who is here now,
// changes a role (their connections close, so they work under it at once; driving agents only for
// someone here), takes someone off (their connections close and the gate is told), and makes a
// link that says where the host is, whose workspace it is, its key, and on a closed network a
// voucher. Someone asking to join is asked about at each of the owner's clients, the first answer
// counting. Each change is the asker's intent. Nobody but the owner may ask.
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccessLists, ROLES } from "@hivemind/workspace-host/access";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { Intents } from "@hivemind/workspace-host/intents";
import { idOf, newSeed, workspaceSeed } from "@hivemind/workspace-host/identity";
import { parseJoinLink } from "@hivemind/workspace-host/join-link";
import { WorkspaceServer, type Connection } from "@hivemind/workspace-api/server";
import type { EventMessage } from "@hivemind/workspace-api/protocol";
import type { Actor } from "@hivemind/workspace-host/intents";
import { mayCall } from "@hivemind/workspace-api/roles";
import { ANSWER_WITHIN_MS, People } from "../src/people.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-people-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let made = 0;
const WS = "ab".repeat(16);
const REPO = "/work/api";
const PRIYA = "b".repeat(64);
const SAM = "c".repeat(64);
const HOST = "d".repeat(64);

function host(network: { access?: { url: string; policy: "open" | "closed" } } = {}) {
  const dir = path.join(tmp, String(made++));
  const owner = newSeed();
  const lists = new AccessLists({ dir: path.join(dir, "access"), owner, devices: () => [] });
  lists.grant(WS, PRIYA, "edit");
  lists.grant(WS, SAM, "view");
  const here = new Set([PRIYA]);
  const closed: string[] = [];
  let admitted = 0;
  const vouchers: unknown[] = [];
  const file = path.join(dir, "audit.jsonl");
  let ownerHere = true;
  const phoned: unknown[] = [];
  let phones = false;
  let waitsAway = false;
  let server!: WorkspaceServer;
  const ppl = new People({
    lists: () => lists,
    workspaceOf: (repo) => (repo === REPO ? WS : null),
    connected: () => here,
    disconnect: (ws, person, reason) => closed.push(`${ws === WS ? "api" : ws} ${person.slice(0, 1)} ${reason}`),
    admit: () => { admitted++; },
    network: async () => ({
      ready: { id: HOST, addrs: ["10.0.0.5:4433"], relay: null, lookup: "https://lookup.example" },
      profiles: {
        active: async () => ({ profile: { access: network.access } }) as never,
        voucher: async (opts) => { vouchers.push(opts); return { voucher: "for a guest" }; },
      },
    }),
    owner: async () => "Adarsh",
    keyOf: (ws) => idOf(workspaceSeed(owner, ws)),
    publishTo: (to, event, ...params) => server.publishTo(to, event, ...params),
    ownerHere: () => ownerHere,
    phones: (repo, question) => { if (phones) phoned.push([repo, question]); return phones; },
    get waitsAway() { return waitsAway; },
  });
  server = new WorkspaceServer([ppl.domain], new Intents(new AuditLog({ file })));
  const client = (actor: Actor) => {
    const received: EventMessage[] = [];
    const c: Connection & { received: EventMessage[] } = { actor, received, send: (m) => received.push(m), closed: new AbortController().signal };
    server.connect(c);
    return c;
  };
  const window = client({ kind: "person" });
  const call = async (method: string, ...params: unknown[]) => {
    const answer = await server.answer(method, params, window);
    if ("error" in answer) throw new Error(answer.error.message);
    return answer.result;
  };
  const audited = () => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { const { verb, target, detail, outcome } = JSON.parse(l); return `${verb} ${target} ${detail ?? ""} ${outcome}`.trim(); });
  const away = (o: { phones?: boolean; waits?: boolean } = {}) => { ownerHere = false; phones = !!o.phones; waitsAway = !!o.waits; };
  return { lists, here, closed, admitted: () => admitted, vouchers, call, audited, owner, ppl, server, client, window, away, phoned };
}

test("its owner sees who is on the list and who is here; a new role closes their connections, and driving agents goes only to someone here", async () => {
  const h = host();
  const listed = await h.call("people.list", REPO) as Array<{ person: string; role: string; present: boolean }>;
  assert.deepEqual(listed.map((p) => [p.person, p.role, p.present]), [[PRIYA, "edit", true], [SAM, "view", false]]);

  await h.call("people.role", REPO, SAM, "terminals");
  assert.equal(h.lists.people(WS).find((p) => p.person === SAM)?.role, "terminals");
  assert.deepEqual(h.closed, ["api c role changed"]);
  await assert.rejects(h.call("people.role", REPO, SAM, "agents"), /given only to someone here now/);
  await h.call("people.role", REPO, PRIYA, "agents");
  assert.equal(h.lists.people(WS).find((p) => p.person === PRIYA)?.role, "agents");
  await assert.rejects(h.call("people.role", REPO, "e".repeat(64), "view"), /not on this workspace's list/);
  // A workspace that does not say whose it is yet has nobody on a list, and no link to it is made.
  assert.deepEqual(await h.call("people.list", "/work/elsewhere"), []);
  await assert.rejects(h.call("people.invite", "/work/elsewhere", "view", 60_000, false), /does not say whose it is/);
});

test("taken off, their connections close and the gate is told", async () => {
  const h = host();
  await h.call("people.remove", REPO, PRIYA);
  assert.deepEqual(h.lists.people(WS).map((p) => p.person), [SAM]);
  assert.deepEqual(h.closed, ["api b removed"]);
  assert.equal(h.admitted(), 1);
});

test("a link says where the host is, whose workspace it is and its key; its invite offers the role; on a closed network it carries a voucher for the guest", async () => {
  const open = host();
  const link = parseJoinLink(await open.call("people.invite", REPO, "terminals", 3_600_000, false) as string)!;
  assert.deepEqual({ ...link, secret: "" }, {
    host: HOST, workspace: WS, secret: "", where: { addrs: ["10.0.0.5:4433"], relay: null },
    names: { workspace: "api", host: "Adarsh" }, admission: null,
    hosting: { key: idOf(workspaceSeed(open.owner, WS)), lookup: "https://lookup.example" },
  });
  assert.equal(open.lists.offered(WS, link.secret), "terminals");
  await assert.rejects(open.call("people.invite", REPO, "agents", 3_600_000, false), /role/);

  const closed = host({ access: { url: "https://access.example", policy: "closed" } });
  const vouched = parseJoinLink(await closed.call("people.invite", REPO, "view", 3_600_000, true) as string)!;
  assert.deepEqual(vouched.admission, { access: "https://access.example", voucher: { voucher: "for a guest" } });
  assert.deepEqual(closed.vouchers, [{ expiresIn: 3600, uses: 100 }]);
});

test("each change is the asker's intent; nobody but the owner may ask", async () => {
  const h = host();
  await h.call("people.role", REPO, SAM, "edit");
  await h.call("people.remove", REPO, SAM);
  await h.call("people.invite", REPO, "view", 60_000, false);
  await h.call("people.list", REPO);
  assert.deepEqual(h.audited(), [
    `people.role ${REPO} ${SAM.slice(0, 8)}… → edit ok`,
    `people.remove ${REPO} ${SAM.slice(0, 8)} ok`,
    `people.invite ${REPO} view ok`,
  ]);
  await h.call("people.answering", REPO, "invite");
  assert.equal(h.audited().at(-1), `people.answering ${REPO} invite ok`);
  for (const method of ["people.list", "people.role", "people.remove", "people.invite", "people.requests", "people.answering"]) {
    for (const role of ROLES) assert.equal(mayCall(role, method), false, `${role} may not ${method}`);
    assert.equal(mayCall("owner", method), true);
  }
});

const asking = { workspace: WS, repo: REPO, person: "e".repeat(64), device: "f".repeat(64), profile: { name: "Noor", color: "#0a0" }, role: "edit" as const };
/** What a question has come to now: its answer, or that it still waits. */
const now = (asked: Promise<boolean>) => Promise.race([asked, Promise.resolve("still waiting")]);
const told = (c: { received: EventMessage[] }) => c.received.filter((m) => m.event.startsWith("people.")).map((m) => [m.event, ...m.params]);

test("someone asking to join is asked about at each of the owner's clients, the first answer counting and the others told", async () => {
  const h = host();
  const laptop = h.client({ kind: "peer", person: "a".repeat(64), device: "1".repeat(64), access: "owner" });
  const guest = h.client({ kind: "peer", person: PRIYA, device: "2".repeat(64), access: "edit" });
  const allowed = h.ppl.ask(asking);
  const question = { req: 1, workspace: "api", profile: asking.profile, role: "edit" };
  for (const owner of [h.window, laptop]) assert.deepEqual(told(owner), [["people.asked", REPO, question]]);
  assert.deepEqual(told(guest), [], "only the owner is asked");
  assert.deepEqual(await h.server.answer("people.answer", [REPO, 1, true], laptop), { result: { answered: true } });
  assert.equal(await now(allowed), true);
  for (const owner of [h.window, laptop]) assert.deepEqual(told(owner).at(-1), ["people.answered", REPO, 1]);
  // Too late, and an answer naming another workspace: neither counts.
  assert.deepEqual(await h.server.answer("people.answer", [REPO, 1, false], h.window), { result: { answered: false } });
  const denied = h.ppl.ask(asking);
  assert.deepEqual(await h.call("people.answer", "/work/web", 2, true), { answered: false });
  assert.deepEqual(await h.call("people.answer", REPO, 2, false), { answered: true });
  assert.equal(await now(denied), false);
  assert.match(h.audited().join("\n"), /people\.answer \/work\/api allow ok[\s\S]*people\.answer \/work\/api deny ok/);
});

test("with none of the owner's clients here it is no at once, and with none answering in time, no", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const h = host();
    const waited = h.ppl.ask(asking);
    mock.timers.tick(ANSWER_WITHIN_MS);
    assert.equal(await now(waited), false);
    assert.deepEqual(told(h.window).at(-1), ["people.answered", REPO, 1]);
    h.away();
    assert.equal(await now(h.ppl.ask(asking)), false);
    assert.equal(told(h.window).length, 2, "nobody is asked");
  } finally {
    mock.timers.reset();
  }
});

test("with none of the owner's clients here their phones are asked, and a host whose person answers at its command line waits for them", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const h = host();
    h.away({ phones: true });
    const phoned = h.ppl.ask(asking);
    assert.deepEqual(h.phoned, [[REPO, { req: 1, workspace: "api", profile: asking.profile, role: "edit" }]]);
    assert.equal(await now(phoned), "still waiting");
    assert.deepEqual(await h.call("people.answer", REPO, 1, true), { answered: true });
    assert.equal(await now(phoned), true);
    h.away({ waits: true });
    const waiting = h.ppl.ask(asking);
    assert.equal(await now(waiting), "still waiting");
    mock.timers.tick(ANSWER_WITHIN_MS);
    assert.equal(await now(waiting), false);
  } finally {
    mock.timers.reset();
  }
});

test("the questions waiting on the owner are listed by workspace until answered, with how it lets people in", async () => {
  const h = host();
  assert.deepEqual(await h.call("people.requests", REPO), { answering: "ask", asking: [] });
  const asked = h.ppl.ask(asking);
  assert.deepEqual(await h.call("people.requests", REPO), { answering: "ask", asking: [{ req: 1, workspace: "api", profile: asking.profile, role: "edit" }] });
  assert.deepEqual(await h.call("people.requests", "/work/web"), { answering: "ask", asking: [] });
  await h.call("people.answer", REPO, 1, false);
  assert.equal(await asked, false);
  assert.deepEqual(await h.call("people.requests", REPO), { answering: "ask", asking: [] });
});

test("a workspace that lets in anyone with a valid invite lets them in at once, asking nobody", async () => {
  const h = host();
  await h.call("people.answering", REPO, "invite");
  assert.deepEqual(await h.call("people.requests", REPO), { answering: "invite", asking: [] });
  assert.equal(await now(h.ppl.ask(asking)), true);
  assert.deepEqual(told(h.window), [], "nobody is asked");
  await assert.rejects(h.call("people.answering", REPO, "always"), /rule/);
  await h.call("people.answering", REPO, "ask");
  assert.equal(await now(h.ppl.ask(asking)), "still waiting");
});
