// Terminals on the host (terminals.ts): what reaches the session's process for what
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
import { PACED_WINDOW } from "@hivemind/agent-host/session-relay";
import { SessionManager } from "@hivemind/agent-host/pty-session-manager";
import { PAUSE_MAX_MS, REPAINT_AFTER_MS, Terminals, type SessionOutput } from "../src/terminals.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-terminals-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let logs = 0;

function host(opts: { hidden?: () => boolean; screen?: string } = {}) {
  const calls: string[] = [];
  const outputs = new Map<string, SessionOutput>();
  const file = path.join(tmp, `audit-${logs++}.jsonl`);
  const terminals = new Terminals({
    intents: new Intents(new AuditLog({ file })),
    relay: { record: () => {}, screenPrefix: "", hidden: opts.hidden },
    backend: {
      start: async (o, out) => { calls.push(`start ${o.tileId}`); outputs.set(o.tileId, out); return { pid: 7 }; },
      write: (t, d) => calls.push(`write ${t} ${d}`),
      echoes: () => true,
      resize: (t, c, r) => calls.push(`resize ${t} ${c}x${r}`),
      repaint: (t) => calls.push(`repaint ${t}`),
      pause: (t) => calls.push(`pause ${t}`),
      resume: (t) => calls.push(`resume ${t}`),
      kill: (t) => calls.push(`kill ${t}`),
      detach: (t) => calls.push(`detach ${t}`),
      screen: (_, lines) => (opts.screen === undefined ? null : (cb) => { cb(lines === undefined ? opts.screen! : `${opts.screen} with ${lines} lines`); return true; }),
    },
  });
  const server = new WorkspaceServer([terminals.domain], new Intents(new AuditLog({ file })));
  const client = (actor: Connection["actor"] = { kind: "person" }) => {
    const closing = new AbortController();
    const received: EventMessage[] = [];
    const c: Connection & { received: EventMessage[]; close(): void } = {
      actor, received, send: (m) => received.push(m), closed: closing.signal, close: () => closing.abort(),
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

test("starting a session is its opener's intent; showing one the host holds is not", async () => {
  const h = host();
  const a = h.client();
  await h.open(a, "hm:t1");
  await h.open(a, "hm:t2", { attachOnly: true });
  assert.deepEqual(h.audited(), ["terminal.open t1 ok"]);
  assert.deepEqual(h.calls, ["start hm:t1", "start hm:t2"]);
});

test("showing a session need not say where or what it runs; opening one to start it must", async () => {
  const h = host();
  const a = h.client();
  await h.open(a, "hm:t1", { attachOnly: true, cwd: undefined, cmd: undefined });
  await assert.rejects(h.open(a, "hm:t2", { cwd: undefined }), /opts\.cwd/);
  await assert.rejects(h.open(a, "hm:t3", { cmd: undefined }), /opts\.cmd/);
  assert.deepEqual(h.calls, ["start hm:t1"]);
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

test("a mouse moved, a click or a window focused over a program that hears them reaches it but keeps the size whose it is; a key typed takes it", async () => {
  const h = host();
  const [a, b] = [h.client(), h.client()];
  await h.open(a, "hm:t1");
  await h.open(b, "hm:t1");
  h.notice(a, "terminal.resize", "hm:t1", 120, 40);
  h.notice(b, "terminal.resize", "hm:t1", 90, 20);
  h.notice(a, "terminal.write", "hm:t1", "ls\r");
  for (const report of ["\x1b[I", "\x1b[O", "\x1b[<35;6;2M\x1b[<35;7;2M", "\x1b[<0;3;4M\x1b[<0;3;4m", "\x1b[M #!", "\x1b[12;40R", "\x1b[?62;22c", "\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\"]) {
    h.notice(b, "terminal.write", "hm:t1", report);
  }
  assert.equal(h.calls.filter((c) => c.startsWith("write")).length, 9, "every report reaches the program");
  assert.deepEqual(h.calls.filter((c) => c.startsWith("resize")), ["resize hm:t1 120x40"]);
  h.notice(b, "terminal.write", "hm:t1", "x");
  h.notice(b, "terminal.write", "hm:t1", "\x1b[Ix");
  assert.deepEqual(h.calls.filter((c) => c.startsWith("resize")), ["resize hm:t1 120x40", "resize hm:t1 90x20"]);
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

test("while every window here is hidden a session's output waits longer, but not while someone watches it from another device: they are sent it as it comes", async () => {
  const h = host({ hidden: () => true });
  const window = h.client();
  await h.open(window, "hm:t1");
  const pushed = async (data: string, to: { received: EventMessage[] }) => {
    const before = output(to).length;
    const at = Date.now();
    h.outputs.get("hm:t1")!.data(data);
    while (output(to).length === before && Date.now() - at < 1_000) await new Promise((r) => setTimeout(r, 2));
    return Date.now() - at;
  };
  assert.ok(await pushed("unseen", window) >= 150, "held while nobody can see it");
  const phone = h.client({ kind: "peer", person: "p".repeat(64), device: "d".repeat(64), access: "owner" });
  await h.open(phone, "hm:t1", { attachOnly: true });
  assert.ok(await pushed("watched", phone) < 150, "the phone watching is sent it at once");
  phone.close();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(await pushed("unseen again", window) >= 150, "held again once the phone went");
});

test("a phone fits a session to its screen until it lets go or goes, and the session takes back the size it had; once a window here sizes it, that size stays", async () => {
  const h = host();
  const window = h.client();
  const phone = () => h.client({ kind: "peer", person: "p".repeat(64), device: "d".repeat(64), access: "owner" });
  await h.open(window, "hm:t1");
  h.notice(window, "terminal.resize", "hm:t1", 120, 40);
  const [a, b, c] = [phone(), phone(), phone()];
  for (const p of [a, b, c]) await h.open(p, "hm:t1", { attachOnly: true });
  h.notice(a, "terminal.fit", "hm:t1", 48, 30);
  a.close();
  h.notice(b, "terminal.fit", "hm:t1", 50, 20);
  const sizes = () => h.calls.filter((call) => call.startsWith("resize")).map((call) => call.split(" ")[2]);
  h.notice(c, "terminal.fit", "hm:t1"); // not its fit
  assert.equal(sizes().at(-1), "50x20");
  h.notice(b, "terminal.fit", "hm:t1");
  h.notice(c, "terminal.fit", "hm:t1", 40, 20);
  h.notice(window, "terminal.resize", "hm:t1", 100, 30);
  c.close();
  assert.deepEqual(sizes(), ["120x40", "48x30", "120x40", "50x20", "120x40", "40x20", "100x30"]);
});

test("a session takes the size of whoever types, at their first key: a phone's size counts only once it types; when they go, the one who typed before them sizes it again", async () => {
  const h = host();
  const window = h.client();
  const phone = h.client({ kind: "peer", person: "p".repeat(64), device: "d".repeat(64), access: "owner" });
  const sizes = () => h.calls.filter((call) => call.startsWith("resize")).map((call) => call.split(" ")[2]);
  await h.open(window, "hm:t1");
  h.notice(window, "terminal.resize", "hm:t1", 120, 40);
  await h.open(phone, "hm:t1", { attachOnly: true });
  h.notice(phone, "terminal.resize", "hm:t1", 48, 30); // shown on the phone: nothing changes yet
  assert.deepEqual(sizes(), ["120x40"]);
  h.notice(window, "terminal.write", "hm:t1", "ls\r");
  h.notice(phone, "terminal.write", "hm:t1", "y");
  assert.deepEqual(sizes(), ["120x40", "48x30"], "the phone typed");
  h.notice(phone, "terminal.write", "hm:t1", "\r");
  h.notice(window, "terminal.write", "hm:t1", "q");
  assert.deepEqual(sizes(), ["120x40", "48x30", "120x40"], "the window's first key gives its size back");
  h.notice(phone, "terminal.write", "hm:t1", "z");
  phone.close();
  assert.deepEqual(sizes(), ["120x40", "48x30", "120x40", "48x30", "120x40"], "the phone went");
});

test("a phone's fit is its own size: its keys keep the fit, so leaving gives back the size it had; once a window types, its next key fits it again; let go, its keys size nothing", async () => {
  const h = host();
  const window = h.client();
  const phone = () => h.client({ kind: "peer", person: "p".repeat(64), device: "d".repeat(64), access: "owner" });
  const sizes = () => h.calls.filter((call) => call.startsWith("resize")).map((call) => call.split(" ")[2]);
  await h.open(window, "hm:t1");
  h.notice(window, "terminal.resize", "hm:t1", 120, 40);
  const a = phone();
  await h.open(a, "hm:t1", { attachOnly: true });
  h.notice(a, "terminal.fit", "hm:t1", 48, 30);
  h.notice(a, "terminal.write", "hm:t1", "y");
  a.close();
  assert.deepEqual(sizes(), ["120x40", "48x30", "120x40"], "the phone typed, then went");
  const b = phone();
  await h.open(b, "hm:t1", { attachOnly: true });
  h.notice(b, "terminal.fit", "hm:t1", 50, 20);
  h.notice(window, "terminal.write", "hm:t1", "q");
  h.notice(b, "terminal.write", "hm:t1", "z");
  assert.deepEqual(sizes().slice(3), ["50x20", "120x40", "50x20"], "the window's key, then the phone's");
  h.notice(window, "terminal.write", "hm:t1", "q");
  h.notice(b, "terminal.fit", "hm:t1");
  h.notice(b, "terminal.write", "hm:t1", "z");
  assert.deepEqual(sizes().slice(6), ["120x40"], "let go, the phone's keys size nothing");
  b.close();
  const c = phone();
  await h.open(c, "hm:t1", { attachOnly: true });
  h.notice(c, "terminal.fit", "hm:t1", 40, 20);
  h.notice(window, "terminal.write", "hm:t1", "q");
  h.notice(c, "terminal.write", "hm:t1", "z");
  h.notice(window, "terminal.resize", "hm:t1", 100, 30);
  c.close();
  assert.deepEqual(sizes().slice(7), ["40x20", "120x40", "40x20", "100x30"], "a window typed over the fit: the window's size now, not the one before the fit");
});

test("the last to fit or type sizes a session; when it lets go or goes, the one before it that still holds a size takes it back", async () => {
  const h = host();
  const window = h.client();
  const phone = () => h.client({ kind: "peer", person: "p".repeat(64), device: "d".repeat(64), access: "owner" });
  const sizes = () => h.calls.filter((call) => call.startsWith("resize")).map((call) => call.split(" ")[2]);
  await h.open(window, "hm:t1");
  h.notice(window, "terminal.resize", "hm:t1", 120, 40);
  const [a, b] = [phone(), phone()];
  for (const p of [a, b]) await h.open(p, "hm:t1", { attachOnly: true });
  h.notice(a, "terminal.fit", "hm:t1", 48, 30);
  h.notice(b, "terminal.fit", "hm:t1", 50, 20);
  h.notice(b, "terminal.fit", "hm:t1");
  assert.deepEqual(sizes(), ["120x40", "48x30", "50x20", "48x30"], "the later phone let go: the earlier one still fits it");
  b.close();
  h.notice(window, "terminal.write", "hm:t1", "q");
  h.notice(a, "terminal.write", "hm:t1", "y");
  h.notice(a, "terminal.fit", "hm:t1");
  assert.deepEqual(sizes().slice(4), ["120x40", "48x30", "120x40"], "the window typed, the phone typed, then let go: the window's size");
  h.notice(a, "terminal.fit", "hm:t1", 48, 30);
  h.notice(window, "terminal.write", "hm:t1", "q");
  h.notice(a, "terminal.write", "hm:t1", "y");
  a.close();
  assert.deepEqual(sizes().slice(7), ["48x30", "120x40", "48x30", "120x40"], "the same, and the phone went");
});

test("a window here that asks for its own size takes it back from a fitted phone, until the phone fits it again", async () => {
  const h = host();
  const window = h.client();
  const phone = h.client({ kind: "peer", person: "p".repeat(64), device: "d".repeat(64), access: "owner" });
  const sizes = () => h.calls.filter((call) => call.startsWith("resize")).map((call) => call.split(" ")[2]);
  await h.open(window, "hm:t1");
  h.notice(window, "terminal.resize", "hm:t1", 120, 40);
  await h.open(phone, "hm:t1", { attachOnly: true });
  h.notice(phone, "terminal.fit", "hm:t1", 48, 30);
  h.notice(window, "terminal.fit", "hm:t1", 110, 36);
  h.notice(window, "terminal.resize", "hm:t1", 100, 36);
  h.notice(phone, "terminal.fit", "hm:t1", 48, 30);
  assert.deepEqual(sizes(), ["120x40", "48x30", "110x36", "100x36", "48x30"]);
});

test("a client that acknowledges what it takes is paced by it: past its window it is sent nothing until it has taken all, then the host's screen", async () => {
  const h = host({ screen: "SCREEN" });
  await h.open(h.client(), "hm:t1");
  const phone = h.client({ kind: "peer", person: "p".repeat(64), device: "d".repeat(64), access: "owner" });
  await h.open(phone, "hm:t1", { attachOnly: true, acks: true });
  const flushed = () => new Promise((r) => setTimeout(r, 50));
  await flushed();
  const sent = () => output(phone).map((m) => String(m.params[1]));
  const taken = sent().join("").length;
  for (const data of ["x".repeat(PACED_WINDOW), "late", "later"]) {
    h.outputs.get("hm:t1")!.data(data);
    await flushed();
  }
  assert.equal(sent().slice(1).join("").length, PACED_WINDOW, "the window, and nothing past it");
  h.notice(phone, "terminal.ack", "hm:t1", taken + PACED_WINDOW);
  await flushed();
  assert.equal(sent().at(-1), "SCREEN");
});

// A program that repaints only what changed draws against the screen it thinks is there. Shown a
// copy instead (a replay on attaching, the host's screen for one that joins), it patches the copy
// wherever the two differ, and text runs into text: it is made to repaint all of it, once, its size
// never changed (a screen a row shorter, read meanwhile, cuts what its last row says).
test("a session whose screen a client is shown from a copy repaints all of it, once, never resized; live output does not", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = host();
  const a = h.client();
  await h.open(a, "hm:t1");
  const asked = () => h.calls.filter((c) => c.startsWith("resize") || c.startsWith("repaint"));
  h.outputs.get("hm:t1")!.data("live bytes");
  t.mock.timers.tick(REPAINT_AFTER_MS * 2);
  assert.deepEqual(asked(), []);
  // The screen again on attaching, twice in a row: one repaint.
  h.outputs.get("hm:t1")!.data("\x1b[H screen", true);
  h.outputs.get("hm:t1")!.data("\x1b[H screen", true);
  assert.deepEqual(asked(), [], "the copy is drawn first");
  t.mock.timers.tick(REPAINT_AFTER_MS);
  assert.deepEqual(asked(), ["repaint hm:t1"]);
});

test("a client that joins a running session is shown the host's screen, and the session repaints all of it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = host({ screen: "the host's screen" });
  await h.open(h.client(), "hm:t1");
  const b = h.client();
  await h.open(b, "hm:t1");
  assert.ok(output(b).some((m) => JSON.stringify(m.params).includes("the host's screen")));
  t.mock.timers.tick(REPAINT_AFTER_MS);
  assert.deepEqual(h.calls.filter((c) => c.startsWith("resize") || c.startsWith("repaint")), ["repaint hm:t1"]);
});

test("a phone that asks for some of a session's history is sent the screen with that much of it on joining, and with more as it asks, alone", async () => {
  const h = host({ screen: "SCREEN" });
  const window = h.client();
  await h.open(window, "hm:t1");
  const phone = h.client({ kind: "peer", person: "p".repeat(64), device: "d".repeat(64), access: "owner" });
  await h.open(phone, "hm:t1", { attachOnly: true, acks: true, history: 200 });
  const sent = (c: { received: EventMessage[] }) => output(c).map((m) => String(m.params[1]));
  assert.deepEqual(sent(phone), ["SCREEN with 200 lines"]);
  h.notice(phone, "terminal.history", "hm:t1", 2000);
  assert.deepEqual(sent(phone), ["SCREEN with 200 lines", "SCREEN with 2000 lines"]);
  assert.deepEqual(sent(window), []);
  // Fallen behind its window, it is sent the screen with what it last asked for.
  for (const data of ["x".repeat(PACED_WINDOW), "late"]) {
    h.outputs.get("hm:t1")!.data(data);
    await new Promise((r) => setTimeout(r, 50));
  }
  h.notice(phone, "terminal.ack", "hm:t1", sent(phone).join("").length);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent(phone).at(-1), "SCREEN with 2000 lines");
  // A window that joins asks for none: all the host keeps.
  const other = h.client();
  await h.open(other, "hm:t1");
  assert.deepEqual(sent(other), ["SCREEN"]);
});

test("a window that sizes a session while the host is still starting it gets that size once it runs, the size it was told", async (t) => {
  // The daemon's own session manager, which sizes only a session it holds, and a process that keeps
  // the size its terminal is given.
  let ptySize = "";
  const manager = new SessionManager((spec) => {
    ptySize = `${spec.cols}x${spec.rows}`;
    return { pid: 9, write: () => {}, resize: (c, r) => { ptySize = `${c}x${r}`; }, kill: () => {}, onData: () => {}, onExit: () => {} };
  });
  t.after(() => manager.killAll());
  let spawn!: () => void;
  const spawning = new Promise<void>((r) => { spawn = r; });
  const file = path.join(tmp, `audit-${logs++}.jsonl`);
  let server: WorkspaceServer | undefined;
  const terminals = new Terminals({
    intents: new Intents(new AuditLog({ file })),
    relay: { record: () => {}, screenPrefix: "" },
    publish: (event, ...params) => server?.publish(event, ...params),
    backend: {
      start: async (o, out) => {
        await spawning;
        const r = await manager.createOrAttach(o.tileId, { cwd: o.cwd!, cmd: o.cmd!, args: o.args ?? [], cols: o.cols, rows: o.rows }, { onData: (d) => out.data(d), onExit: (c) => out.exit(c) });
        return { pid: r.pid };
      },
      write: () => {}, echoes: () => true, repaint: () => {}, pause: () => {}, resume: () => {}, kill: () => {}, detach: () => {},
      resize: (tile, cols, rows) => manager.resize(tile, cols, rows),
      screen: () => null,
    },
  });
  server = new WorkspaceServer([terminals.domain], new Intents(new AuditLog({ file })));
  const window: Connection & { received: EventMessage[] } = { actor: { kind: "person" }, received: [], send: (m) => window.received.push(m), closed: new AbortController().signal };
  server.connect(window);
  // The control plane starts it at the host's default size, and the window showing the tile asks
  // for its own before the process is there.
  const started = terminals.own({ tileId: "hm:t1", cwd: tmp, cmd: "claude", args: [], cols: 120, rows: 36 }, { data: () => {}, exit: () => {} });
  const opened = server.answer("terminal.open", [{ tileId: "hm:t1", cwd: tmp, cmd: "claude", cols: 119, rows: 26 }], window);
  server.notice("terminal.resize", ["hm:t1", 119, 26], window);
  spawn();
  await started;
  await opened;
  const told = window.received.filter((m) => m.event === "terminal.size").at(-1)?.params;
  assert.deepEqual(told, ["hm:t1", 119, 26]);
  assert.equal(ptySize, "119x26", "the process draws at the size the window draws it");
});
