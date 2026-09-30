// One keyboard per terminal (workspace/keyboard.ts through workspace/terminals.ts, M2): until the
// host gives it away its own windows type and a guest's keys never reach the session; a guest who
// asks is heard by the host's windows showing it; given the keyboard, the guest alone types and
// sizes the session, and everyone is told who holds it; it comes back to the host when taken,
// after five idle minutes, and when its holder goes; and everyone is told a session's size.
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
import { Terminals } from "../../src/main/workspace/terminals.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-keyboard-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const PRIYA = "b".repeat(64);

function host() {
  const calls: string[] = [];
  let server!: WorkspaceServer;
  const terminals = new Terminals({
    intents: new Intents(new AuditLog({ file: path.join(tmp, "audit.jsonl") })),
    relay: { record: () => {}, screenPrefix: "" },
    publish: (event, ...params) => server.publish(event, ...params),
    who: (c) => (c.actor.kind === "peer" ? { person: c.actor.person, name: "Priya" } : { person: "a".repeat(64), name: "Adarsh" }),
    backend: {
      start: async () => ({ pid: 7 }),
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
  const open = (from: Connection, starts = false) => server.answer("terminal.open", [{ tileId: "hm:t1", cwd: tmp, cmd: "/bin/sh", cols: 80, rows: 24, ...(starts ? {} : { attachOnly: true }) }], from);
  const notice = (from: Connection, method: string, ...params: unknown[]) => server.notice(method, params, from);
  const told = (c: { received: EventMessage[] }, event: string) => c.received.filter((m) => m.event === event).map((m) => m.params);
  return { calls, client, open, notice, told };
}
const guestActor: Actor = { kind: "peer", person: PRIYA, device: "d".repeat(64), access: "terminals" };

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

