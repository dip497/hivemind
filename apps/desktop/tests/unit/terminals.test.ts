// Terminals on the host (workspace/terminals.ts): what reaches the session's process for what
// each client asks, which starts and ends are recorded as someone's intent, and what a client
// that goes lets go of. The backend here stands in for the process layer and records each call.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Intents } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { WorkspaceServer, type Connection } from "@hivemind/workspace-api/server";
import type { EventMessage } from "@hivemind/workspace-api/protocol";
import { PAUSE_MAX_MS, Terminals, type SessionOutput } from "../../src/main/workspace/terminals.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-terminals-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let logs = 0;

function host(opts: { askedByHost?: (bare: string) => boolean } = {}) {
  const calls: string[] = [];
  const outputs = new Map<string, SessionOutput>();
  const file = path.join(tmp, `audit-${logs++}.jsonl`);
  const terminals = new Terminals({
    intents: new Intents(new AuditLog({ file })),
    relay: { record: () => {}, screenPrefix: "" },
    askedByHost: opts.askedByHost,
    backend: {
      start: async (o, out) => { calls.push(`start ${o.tileId}`); outputs.set(o.tileId, out); return { pid: 7 }; },
      write: (t, d) => calls.push(`write ${t} ${d}`),
      echoes: () => true,
      resize: (t, c, r) => calls.push(`resize ${t} ${c}x${r}`),
      pause: (t) => calls.push(`pause ${t}`),
      resume: (t) => calls.push(`resume ${t}`),
      kill: (t) => calls.push(`kill ${t}`),
      detach: (t) => calls.push(`detach ${t}`),
      screen: () => null,
    },
  });
  const server = new WorkspaceServer([terminals.domain], new Intents(new AuditLog({ file })));
  const client = () => {
    const closing = new AbortController();
    const received: EventMessage[] = [];
    const c: Connection & { received: EventMessage[]; close(): void } = {
      actor: { kind: "person" }, received, send: (m) => received.push(m), closed: closing.signal, close: () => closing.abort(),
    };
    server.connect(c);
    return c;
  };
  const audited = () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { const { verb, target, outcome } = JSON.parse(l); return `${verb} ${target} ${outcome}`; }) : []);
  const open = async (from: Connection, tileId: string, extra: object = {}) => {
    const answer = await server.answer("terminal.open", [{ tileId, cwd: tmp, cmd: "/bin/sh", cols: 80, rows: 24, ...extra }], from);
    if ("error" in answer) throw new Error(answer.error.message);
    return answer.result as { pid: number; joined: boolean };
  };
  const notice = (from: Connection, method: string, ...params: unknown[]) => server.notice(method, params, from);
  return { terminals, calls, outputs, client, audited, open, notice };
}
/** What a client was sent of its sessions' output and exits (the session's size aside). */
const output = (c: { received: EventMessage[] }) => c.received.filter((m) => m.event === "terminal.data" || m.event === "terminal.exit");

test("a session is started once, by the first client to open it; every client showing it is sent its output and its exit", async () => {
  const h = host();
  const [a, b] = [h.client(), h.client()];
  assert.deepEqual(await h.open(a, "hm:t1"), { pid: 7, joined: false });
  assert.deepEqual(await h.open(b, "hm:t1"), { pid: 7, joined: true });
  h.outputs.get("hm:t1")!.data("hello");
  h.outputs.get("hm:t1")!.exit(0);
  await new Promise((r) => setTimeout(r, 50)); // the relay's batching
  for (const c of [a, b]) {
    assert.deepEqual(output(c), [
      { event: "terminal.data", params: ["hm:t1", "hello"] },
      { event: "terminal.exit", params: ["hm:t1", { code: 0, signal: undefined }] },
    ]);
  }
  assert.deepEqual(h.calls, ["start hm:t1"]);
});

test("starting a session is its opener's intent; showing one the host holds, or one the host asked for, is not", async () => {
  const h = host({ askedByHost: (bare) => bare === "t3" });
  const a = h.client();
  await h.open(a, "hm:t1");
  await h.open(a, "hm:t2", { attachOnly: true });
  await h.open(a, "hm:t3");
  assert.deepEqual(h.audited(), ["terminal.open t1 ok"]);
  assert.deepEqual(h.calls, ["start hm:t1", "start hm:t2", "start hm:t3"]);
});

test("closing a session ends it and is the closer's intent; a close after it ended ends nothing more of anyone's", async () => {
  const h = host();
  const [a, b] = [h.client(), h.client()];
  await h.open(a, "hm:t1");
  await h.open(b, "hm:t1");
  await h.open(a, "hm:t2");
  h.notice(a, "terminal.close", "hm:t1");
  await new Promise((r) => setTimeout(r, 10));
  h.notice(b, "terminal.close", "hm:t1"); // the other client follows the first one's end
  h.terminals.end("hm:t2"); // the host's own end (the control plane closing the tile)
  h.notice(a, "terminal.close", "hm:t2");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(h.audited(), ["terminal.open t1 ok", "terminal.open t2 ok", "terminal.close t1 ok"]);
  assert.deepEqual(h.calls.filter((c) => c.startsWith("kill")), ["kill hm:t1", "kill hm:t1", "kill hm:t2", "kill hm:t2"]);
});

test("while several clients show a session only the one that typed last sizes it, and one leaving lets go of nothing; one client alone always sizes it", async () => {
  const h = host();
  const [a, b] = [h.client(), h.client()];
  await h.open(a, "hm:t1");
  h.notice(b, "terminal.resize", "hm:t1", 100, 30); // before anyone typed: sized
  await h.open(b, "hm:t1");
  h.notice(a, "terminal.write", "hm:t1", "ls\r");
  h.notice(b, "terminal.resize", "hm:t1", 90, 20); // a typed last: ignored
  h.notice(a, "terminal.resize", "hm:t1", 120, 40);
  h.notice(b, "terminal.write", "hm:t1", "x");
  h.notice(b, "terminal.resize", "hm:t1", 90, 20);
  h.notice(a, "terminal.detach", "hm:t1");
  assert.ok(!h.calls.includes("detach hm:t1"), "b still shows it");
  h.notice(a, "terminal.resize", "hm:t1", 70, 10); // a no longer shows it, but b is alone: any size goes
  assert.deepEqual(h.calls.filter((c) => c.startsWith("resize")), ["resize hm:t1 100x30", "resize hm:t1 120x40", "resize hm:t1 90x20", "resize hm:t1 70x10"]);
});

test("a pause lasts a moment unless it is asked for again; a resume ends it at once", async () => {
  const h = host();
  const a = h.client();
  await h.open(a, "hm:t1");
  h.notice(a, "terminal.flow", "hm:t1", true);
  await new Promise((r) => setTimeout(r, PAUSE_MAX_MS + 60));
  h.notice(a, "terminal.flow", "hm:t1", true);
  h.notice(a, "terminal.flow", "hm:t1", false);
  await new Promise((r) => setTimeout(r, PAUSE_MAX_MS + 60));
  assert.deepEqual(h.calls.filter((c) => /^(pause|resume)/.test(c)), ["pause hm:t1", "resume hm:t1", "pause hm:t1", "resume hm:t1"]);
});

test("a client that goes lets go of what it showed: a session nobody else shows is detached, one another shows runs on", async () => {
  const h = host();
  const [a, b] = [h.client(), h.client()];
  await h.open(a, "hm:t1");
  await h.open(a, "hm:t2");
  await h.open(b, "hm:t2");
  a.close();
  assert.deepEqual(h.calls.filter((c) => c.startsWith("detach")), ["detach hm:t1"]);
  h.outputs.get("hm:t2")!.data("still here");
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(output(b), [{ event: "terminal.data", params: ["hm:t2", "still here"] }]);
  assert.deepEqual(output(a), []);
});
