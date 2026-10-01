// One keyboard per terminal (keyboard.ts through terminals.ts, M2): until the
// host gives it away its own windows type, as does a device of its owner's (R14: at `hive host`
// there is no window), and a guest's keys never reach the session; a guest who
// asks is heard by the host's windows showing it; given the keyboard, the guest alone types and
// sizes the session, and everyone is told who holds it; it comes back to the host when taken,
// after five idle minutes, and when its holder goes; and everyone is told a session's size. Whoever
// types is named to the others showing it (R4), and a guest's typing is marked in the audit log.
// A terminal on a participant's machine (M4) is theirs: nobody here types into it or sizes it,
// until they lend its keyboard, and then it goes as the host's own do; sized there either way.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Intents } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { WorkspaceServer, type Connection } from "@hivemind/workspace-api/server";
import type { EventMessage } from "@hivemind/workspace-api/protocol";
import type { Actor } from "@hivemind/workspace-host/intents";
import { TYPED_BURST_MS, TYPING_EVERY_MS, Terminals } from "../src/terminals.ts";
import { participantAt } from "../src/device-sessions.ts";
import type { Grant } from "../src/machine-share.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-keyboard-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const PRIYA = "b".repeat(64);
let made = 0;

/** A host; with `machine`, one whose terminals in `machine://` frames run on Priya's machine, which
 *  says each one's size as it opens, and lends their keyboards while `lends` is set (from when one
 *  starts, with `lentOnceStarted`: its workspace here holds it only then). */
function host({ machine = false, lentOnceStarted = false } = {}) {
  const calls: string[] = [];
  const lending = { lends: false };
  let server!: WorkspaceServer;
  const audit = path.join(tmp, `audit-${made++}.jsonl`);
  const terminals = new Terminals({
    intents: new Intents(new AuditLog({ file: audit })),
    relay: { record: () => {}, screenPrefix: "" },
    publish: (event, ...params) => server.publish(event, ...params),
    who: (c) => (c.actor.kind === "peer" ? { person: c.actor.person, name: "Priya" } : { person: "a".repeat(64), name: "Adarsh" }),
    ...(machine ? { machineOf: (o: { cwd: string }) => (o.cwd.startsWith("machine://") ? { who: PRIYAS_MACHINE, lends: () => lending.lends } : null) } : {}),
    backend: {
      start: async (o, out) => {
        if (machine && o.cwd.startsWith("machine://")) out.size?.(120, 40);
        if (lentOnceStarted) lending.lends = true;
        return { pid: 7 };
      },
      write: (t, d) => calls.push(`write ${d}`),
      echoes: () => false,
      resize: (t, c, r) => calls.push(`resize ${c}x${r}`),
      pause: () => {}, resume: () => {}, kill: () => {}, detach: () => {},
      screen: () => null,
    },
  });
  server = new WorkspaceServer([terminals.domain], new Intents(new AuditLog({ file: path.join(tmp, "audit.jsonl") })));
  const client = (actor: Actor) => {
    const closing = new AbortController();
    const received: EventMessage[] = [];
    const c: Connection & { received: EventMessage[]; close(): void } = { actor, received, send: (m) => received.push(m), closed: closing.signal, close: () => closing.abort() };
    server.connect(c);
    return c;
  };
  const open = (from: Connection, starts = false, cwd = tmp) => server.answer("terminal.open", [{ tileId: "hm:t1", cwd, cmd: "/bin/sh", cols: 80, rows: 24, ...(starts ? {} : { attachOnly: true }) }], from);
  const notice = (from: Connection, method: string, ...params: unknown[]) => server.notice(method, params, from);
  const told = (c: { received: EventMessage[] }, event: string) => c.received.filter((m) => m.event === event).map((m) => m.params);
  const audited = () => (fs.existsSync(audit) ? fs.readFileSync(audit, "utf8") : "").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { verb: string; target?: string; actor: Actor; outcome: string });
  return { calls, client, open, notice, told, audited, terminals, lending };
}
const guestActor: Actor = { kind: "peer", person: PRIYA, device: "d".repeat(64), access: "terminals" };
const PRIYAS_MACHINE = { id: `peer:${"d".repeat(64)}`, person: PRIYA, name: "Priya" };

test("a terminal on a participant's machine is theirs (M4): whoever opens it is told its machine's person holds its keyboard, and the size it has there; nobody here types into it or sizes it, nor asks for, gives or takes its keyboard", async () => {
  const h = host({ machine: true });
  const [win, laptop, guest] = [h.client({ kind: "person" }), h.client({ kind: "peer", person: "a".repeat(64), device: "e".repeat(64), access: "owner" }), h.client({ ...guestActor, access: "agents" })];
  const there = `machine://${"d".repeat(64)}/home/priya/api`;
  await h.open(win, true, there);
  await h.open(laptop, false, there);
  await h.open(guest, false, there);
  for (const c of [win, laptop, guest]) assert.deepEqual(h.told(c, "terminal.keyboard"), [["hm:t1", PRIYAS_MACHINE]]);
  assert.deepEqual(h.told(win, "terminal.size"), [["hm:t1", 120, 40]], "its size there, never the opener's");
  assert.deepEqual(h.told(guest, "terminal.size").at(-1), ["hm:t1", 120, 40]);

  for (const c of [win, laptop, guest]) {
    h.notice(c, "terminal.write", "hm:t1", "ls\r");
    h.notice(c, "terminal.resize", "hm:t1", 100, 30);
  }
  h.notice(guest, "terminal.keyboard.ask", "hm:t1");
  h.notice(win, "terminal.keyboard.give", "hm:t1", `peer:${"d".repeat(64)}`);
  h.notice(win, "terminal.keyboard.take", "hm:t1");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(h.calls, [], "no keys, no size");
  assert.deepEqual(h.told(win, "terminal.keyboard.asked"), [], "nobody here to ask");
  for (const c of [win, laptop, guest]) assert.equal(h.told(c, "terminal.keyboard").length, 1, "it never moves");
});

test("one on a participant's machine whose person lends its keyboard goes as the host's own do: the host's windows type, a guest asks the host; never sized from here; kept again, whoever held it gives it up", async () => {
  const h = host({ machine: true });
  const [win, guest] = [h.client({ kind: "person" }), h.client(guestActor)];
  const there = `machine://${"d".repeat(64)}/home/priya/api`;
  await h.open(win, true, there);
  await h.open(guest, false, there);
  h.lending.lends = true;
  h.terminals.machineChanged(PRIYAS_MACHINE.id);
  for (const c of [win, guest]) assert.deepEqual(h.told(c, "terminal.keyboard").at(-1), ["hm:t1", null], "the host's now");
  h.notice(win, "terminal.write", "hm:t1", "ls\r");
  h.notice(guest, "terminal.write", "hm:t1", "rm -rf ~\r");
  h.notice(win, "terminal.resize", "hm:t1", 100, 30);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(h.calls, ["write ls\r"], "the host's window types; nobody sizes it from here");

  h.notice(guest, "terminal.keyboard.ask", "hm:t1");
  const asker = (h.told(win, "terminal.keyboard.asked")[0] as [string, { id: string }])[1];
  h.notice(win, "terminal.keyboard.give", "hm:t1", asker.id);
  h.notice(guest, "terminal.write", "hm:t1", "guest keys\r");
  assert.deepEqual(h.calls.at(-1), "write guest keys\r");

  // Kept again: the guest's lease ends, and it is the machine's person's.
  h.lending.lends = false;
  h.terminals.machineChanged(PRIYAS_MACHINE.id);
  for (const c of [win, guest]) assert.deepEqual(h.told(c, "terminal.keyboard").at(-1), ["hm:t1", PRIYAS_MACHINE]);
  h.calls.length = 0;
  h.notice(guest, "terminal.write", "hm:t1", "still guest\r");
  h.notice(win, "terminal.write", "hm:t1", "host\r");
  assert.deepEqual(h.calls, []);
  // Lent again, it is the host's, not the guest's of before.
  h.lending.lends = true;
  h.terminals.machineChanged(PRIYAS_MACHINE.id);
  assert.deepEqual(h.told(guest, "terminal.keyboard").at(-1), ["hm:t1", null]);
  h.notice(guest, "terminal.write", "hm:t1", "old lease\r");
  assert.deepEqual(h.calls, []);
});

test("one on a participant's machine that a window opens as it places it, before the host's copy of its workspace holds it, is told lent once it runs, its person lending it: the window types", async () => {
  const h = host({ machine: true, lentOnceStarted: true });
  const win = h.client({ kind: "person" });
  await h.open(win, true, `machine://${"d".repeat(64)}/home/priya/api`);
  assert.deepEqual(h.told(win, "terminal.keyboard"), [["hm:t1", PRIYAS_MACHINE], ["hm:t1", null]], "told again once it runs");
  h.notice(win, "terminal.write", "hm:t1", "ls\r");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(h.calls, ["write ls\r"]);
});

test("whose machine a terminal in a frame on a participant's machine is on, and whether it lends its keyboard: as that machine grants, once this host's copy of the tile's workspace holds it", () => {
  let held = false;
  let granted: Grant = "terminals";
  const at = (cwd: string) => participantAt({ tileId: "hm:t1", tile: "t1", cwd, cmd: "/bin/sh", cols: 80, rows: 24 }, {
    self: "c".repeat(64),
    mine: (device) => device === "e".repeat(64),
    lists: { workspaces: () => ["w"], personOf: (_w, device) => (device === "d".repeat(64) ? PRIYA : null) },
    nameOf: () => "Priya",
    shown: () => (held ? { key: "k", open: () => null, grant: () => granted } : null),
  });
  const machine = at(`machine://${"d".repeat(64)}/home/priya/api`);
  assert.deepEqual(machine?.who, PRIYAS_MACHINE);
  assert.equal(machine?.lends(), false, "not while its workspace here does not hold it");
  held = true;
  assert.equal(machine?.lends(), true, "then as granted");
  granted = "watch";
  assert.equal(machine?.lends(), false, "and taken back");
  assert.equal(at(`machine://${"c".repeat(64)}/home/me`), null, "a frame on this machine");
  assert.equal(at(`machine://${"e".repeat(64)}/home/me`), null, "on one of the person's own devices");
  assert.equal(at("/home/me/api"), null);
});

test("a device of the owner's types as the host's own windows do, and a guest's keys still never reach the session", async () => {
  const h = host();
  const [laptop, guest] = [h.client({ kind: "peer", person: "a".repeat(64), device: "e".repeat(64), access: "owner" }), h.client(guestActor)];
  await h.open(laptop, true);
  await h.open(guest);
  h.notice(laptop, "terminal.write", "hm:t1", "ls\r");
  h.notice(guest, "terminal.write", "hm:t1", "rm -rf ~\r");
  h.notice(laptop, "terminal.resize", "hm:t1", 100, 30);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(h.calls, ["write ls\r", "resize 100x30"]);
});

test("until the host gives it away, its windows type and a guest's keys never reach the session; given it, the guest alone types and sizes it", async () => {
  const h = host();
  const [win, guest] = [h.client({ kind: "person" }), h.client(guestActor)];
  await h.open(win);
  await h.open(guest);
  h.notice(win, "terminal.write", "hm:t1", "ls\r");
  h.notice(guest, "terminal.write", "hm:t1", "rm -rf ~\r");
  assert.deepEqual(h.calls, ["write ls\r"]);

  // The guest asks: the host's window showing it hears who asks.
  h.notice(guest, "terminal.keyboard.ask", "hm:t1");
  const [[tile, asker]] = h.told(win, "terminal.keyboard.asked") as [[string, { id: string; person: string; name: string }]];
  assert.deepEqual([tile, asker.person, asker.name], ["hm:t1", PRIYA, "Priya"]);
  // Given it: everyone is told; only the guest types now, and the guest's size is the session's.
  h.notice(win, "terminal.keyboard.give", "hm:t1", asker.id);
  for (const c of [win, guest]) assert.deepEqual(h.told(c, "terminal.keyboard"), [["hm:t1", null], ["hm:t1", asker]]);
  h.calls.length = 0;
  h.notice(win, "terminal.resize", "hm:t1", 200, 50);
  h.notice(win, "terminal.write", "hm:t1", "host keys\r");
  h.notice(guest, "terminal.write", "hm:t1", "guest keys\r");
  h.notice(guest, "terminal.resize", "hm:t1", 100, 30);
  assert.deepEqual(h.calls, ["write guest keys\r", "resize 100x30"]);
  // Everyone is told the session's size.
  for (const c of [win, guest]) assert.deepEqual(h.told(c, "terminal.size"), [["hm:t1", 100, 30]]);

  // The host takes it back; the guest cannot, and cannot give what it does not hold.
  h.notice(win, "terminal.keyboard.take", "hm:t1");
  assert.deepEqual(h.told(guest, "terminal.keyboard").at(-1), ["hm:t1", null]);
  h.calls.length = 0;
  h.notice(guest, "terminal.write", "hm:t1", "still guest\r");
  h.notice(win, "terminal.write", "hm:t1", "host again\r");
  assert.deepEqual(h.calls, ["write host again\r"]);
});

test("a keyboard left idle for five minutes, or whose holder goes, comes back to the host", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = host();
  const [win, guest] = [h.client({ kind: "person" }), h.client(guestActor)];
  await h.open(win);
  await h.open(guest);
  const give = () => {
    h.notice(guest, "terminal.keyboard.ask", "hm:t1");
    const asker = (h.told(win, "terminal.keyboard.asked").at(-1) as [string, { id: string }])[1];
    h.notice(win, "terminal.keyboard.give", "hm:t1", asker.id);
  };
  give();
  t.mock.timers.tick(4 * 60_000);
  h.notice(guest, "terminal.write", "hm:t1", "x"); // typing keeps it
  t.mock.timers.tick(4 * 60_000);
  assert.notEqual(h.told(win, "terminal.keyboard").at(-1)![1], null);
  t.mock.timers.tick(60_000 + 1);
  assert.deepEqual(h.told(win, "terminal.keyboard").at(-1), ["hm:t1", null]);

  give();
  assert.notEqual(h.told(win, "terminal.keyboard").at(-1)![1], null);
  guest.close();
  assert.deepEqual(h.told(win, "terminal.keyboard").at(-1), ["hm:t1", null]);
});

test("whoever opens a session is told who holds its keyboard and its size; back with the host, the host's windows size it again", async () => {
  const h = host();
  const win = h.client({ kind: "person" });
  await h.open(win, true);
  // A guest who opens it later is told the size the host started it at, and that the host holds
  // its keyboard: one coming back may have missed it being taken back.
  const guest = h.client(guestActor);
  await h.open(guest);
  assert.deepEqual(h.told(guest, "terminal.size"), [["hm:t1", 80, 24]]);
  assert.deepEqual(h.told(guest, "terminal.keyboard"), [["hm:t1", null]]);

  h.notice(guest, "terminal.keyboard.ask", "hm:t1");
  const asker = (h.told(win, "terminal.keyboard.asked")[0] as [string, { id: string }])[1];
  h.notice(win, "terminal.keyboard.give", "hm:t1", asker.id);
  h.notice(guest, "terminal.write", "hm:t1", "x");
  h.notice(guest, "terminal.resize", "hm:t1", 100, 30);
  // One who opens it now is told who holds it, and the size they gave it.
  const late = h.client({ ...guestActor, device: "e".repeat(64) });
  await h.open(late);
  assert.deepEqual(h.told(late, "terminal.keyboard"), [["hm:t1", asker]]);
  assert.deepEqual(h.told(late, "terminal.size"), [["hm:t1", 100, 30]]);

  // Taken back, the host's window sizes it again, though the guest typed last and still shows it.
  h.notice(win, "terminal.keyboard.take", "hm:t1");
  h.calls.length = 0;
  h.notice(win, "terminal.resize", "hm:t1", 120, 40);
  assert.deepEqual(h.calls, ["resize 120x40"]);
});


test("whoever types is named to the others showing the session, again only after a second while they type on; a guest's typing is marked in the audit log once a burst, never what was typed", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const h = host();
  const [win, guest, elsewhere] = [h.client({ kind: "person" }), h.client(guestActor), h.client({ kind: "person" })];
  await h.open(win);
  await h.open(guest);
  h.notice(guest, "terminal.keyboard.ask", "hm:t1");
  const asker = (h.told(win, "terminal.keyboard.asked")[0] as [string, { id: string }])[1];
  h.notice(win, "terminal.keyboard.give", "hm:t1", asker.id);
  const settled = () => new Promise((r) => setImmediate(r));

  // The guest types: the host's window showing it is told who; the guest is not, nor a client that
  // does not show it; typing on within the second tells nobody again.
  h.notice(guest, "terminal.write", "hm:t1", "echo secret");
  h.notice(guest, "terminal.write", "hm:t1", "\r");
  assert.deepEqual(h.told(win, "terminal.typing"), [["hm:t1", asker]]);
  assert.deepEqual(h.told(guest, "terminal.typing"), []);
  assert.deepEqual(h.told(elsewhere, "terminal.typing"), []);
  t.mock.timers.tick(TYPING_EVERY_MS);
  h.notice(guest, "terminal.write", "hm:t1", "ls\r");
  assert.equal(h.told(win, "terminal.typing").length, 2);

  // Marked once for the burst, as the guest's; again after a quiet spell; never what was typed.
  await settled();
  const marks = () => h.audited().filter((r) => r.verb === "terminal.write");
  assert.deepEqual(marks().map((r) => [r.target, r.actor, r.outcome]), [["t1", guestActor, "ok"]]);
  t.mock.timers.tick(TYPED_BURST_MS);
  h.notice(guest, "terminal.write", "hm:t1", "pwd\r");
  await settled();
  assert.equal(marks().length, 2);
  assert.doesNotMatch(JSON.stringify(h.audited()), /secret|pwd/);

  // The host's own typing is named to the guest, and is not marked.
  h.notice(win, "terminal.keyboard.take", "hm:t1");
  h.notice(win, "terminal.write", "hm:t1", "exit\r");
  await settled();
  assert.deepEqual((h.told(guest, "terminal.typing").at(-1) as [string, { person: string; name: string }])[1].name, "Adarsh");
  assert.equal(marks().length, 2);
});
