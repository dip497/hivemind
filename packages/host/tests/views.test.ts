// Community views on a remote screen (views.ts, spec/workspace-api.md "Views on a remote screen"):
// the views installed here that say they work on a phone are offered, and their files, inside the
// package and 4 MiB at most; a view opened on a workspace here is told, once it is ready, what the
// window would tell it, as a phone's screen, to its caller alone; what it does is done on the board
// as its caller, and recorded, and what its caller may not do is refused; its tiles' statuses follow
// it; and its session ends when its caller closes it or goes, or when its host disables it, told why.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setCatalog, type AgentProviderDef } from "@hivemind/agents";
import { StatusStore, type SessionStatus } from "@hivemind/agent-host/status-store";
import { listInstalledViews } from "@hivemind/core/views";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { newSeed } from "@hivemind/workspace-host/identity";
import { Intents } from "@hivemind/workspace-host/intents";
import { WorkspaceStore } from "@hivemind/workspace-host/store";
import { WorkspaceServer, type Connection } from "@hivemind/workspace-api/server";
import type { EventMessage } from "@hivemind/workspace-api/protocol";
import { views } from "../src/views.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-views-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let made = 0;
setCatalog([{ id: "claude", label: "Claude Code", bin: "claude", enabled: true } as unknown as AgentProviderDef]);

/** A view package in this device's views, its manifest `manifest` and its files `files`. */
function installed(id: string, manifest: object, files: Record<string, string | Buffer> = {}) {
  const dir = path.join(process.env.XDG_CONFIG_HOME!, "hivemind", "views", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "hivemind-view.json"), JSON.stringify({ id, version: "1.0.0", entry: "index.html", protocol: 1, ...manifest }));
  fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html><title>${id}</title>`);
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}
beforeEach(() => { process.env.XDG_CONFIG_HOME = path.join(tmp, `xdg-${made++}`); });

/** Priya's phone, her own device. */
const PHONE = { kind: "peer", person: "p".repeat(64), device: "d".repeat(64), access: "owner" } as const;

const priyaStatus = (more: Partial<SessionStatus> = {}): SessionStatus =>
  ({ state: "waiting", kind: "permission", subagents: [], background: 0, compacting: false, source: "hooks", since: 1, title: "Fixing the nav", ...more });

/** Priya's computer: the workspace `api` with an agent in a frame on it and a shell in a frame on
 *  her build box; a view server whose agents are started and closed as `started` and `closed` say;
 *  and how to connect a caller to it. */
function computer() {
  const dir = path.join(tmp, `computer-${made++}`);
  const repo = path.join(dir, "api");
  const status = new StatusStore();
  let links = { pipes: [] as Array<{ src: string; dst: string }>, spawns: [] as Array<{ parent: string; child: string }> };
  const started: Array<{ repo: string; start: object }> = [];
  const closed: string[] = [];
  const intents = new Intents(new AuditLog({ file: path.join(dir, "audit.jsonl") }));
  const store: WorkspaceStore = new WorkspaceStore({
    dir: path.join(dir, "workspaces"), person: newSeed(),
    onChange: (change) => server.publish("store.changed", { repo: change.repo, part: change.part }),
  });
  const server: WorkspaceServer = new WorkspaceServer([views({
    installed: () => listInstalledViews(),
    store: () => store,
    server: () => server,
    status: (tile) => status.get(tile),
    links: () => links,
    start: async (at, start) => {
      started.push({ repo: at, start });
      store.addTile(at, { id: "t3", kind: "claude", label: "Claude #2", cmd: "claude" });
      return "t3";
    },
    close: async (tile) => { closed.push(tile); return store.removeTile(tile) !== null; },
    machines: { self: () => ({ device: "d1", name: "desk" }), mine: () => undefined, whose: () => undefined, saved: (id) => (id === "m1" ? "build box" : undefined) },
    intents,
    onWarn: () => {},
  })], intents);
  store.setCore(repo, {
    frames: [
      { id: "f1", title: "api", workspacePath: repo, color: "oklch(0.72 0.075 240)" },
      { id: "f2", title: "build box", workspacePath: "machine://m1/srv/api", color: "#ABC" },
    ],
    tiles: [{ id: "t1", kind: "claude", label: "Claude #1", cmd: "claude" }, { id: "t2", kind: "shell", label: "Shell #1" }],
    frameOf: { t1: "f1", t2: "f2" },
    tileNames: { t2: "Priya's shell" },
  });
  // As the control plane does: each status change is told every client.
  status.subscribe((change) => server.publish("status.changed", change));
  status.mirror("t1", priyaStatus());
  /** A caller: what it is sent, and how it goes. By default the person's phone; `may`: what its
   *  transport lets it call. */
  const caller = (may?: (method: string) => boolean, actor: Connection["actor"] = PHONE) => {
    const closing = new AbortController();
    const got: EventMessage[] = [];
    const c: Connection & { got: EventMessage[]; go(): void } = { actor, got, send: (m) => got.push(m), closed: closing.signal, go: () => closing.abort(), ...(may ? { may } : {}) };
    server.connect(c);
    return c;
  };
  const call = async (method: string, params: unknown[], from: Connection) => {
    const answer = await server.answer(method, params, from);
    if ("error" in answer) throw Object.assign(new Error(answer.error.message), { code: answer.error.code });
    return answer.result;
  };
  const post = (from: Connection, session: string, message: unknown) => server.notice("view.post", [session, message], from);
  /** What a caller's view has been told in `session`, in order. */
  const said = (c: { got: EventMessage[] }, session: string) =>
    c.got.filter((e) => e.event === "view.said" && e.params[0] === session).map((e) => e.params[1] as Record<string, unknown>);
  const audit = () => fs.readFileSync(path.join(dir, "audit.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  return { dir, repo, store, status, started, closed, caller, call, post, said, audit, setLinks: (l: typeof links) => { links = l; server.publish("link.pipe", { src: "t1", dst: "t2", connected: true }); } };
}
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return (e as { code?: string }).code; } };

test("the views here that say they work on a phone are offered, and their files: inside the package, 4 MiB at most, base64 with their type", async () => {
  const c = computer();
  const dir = installed("priya-board", { name: "Priya's board", phone: true }, { "main.js": "export {};", "big.bin": Buffer.alloc(4 * 1024 * 1024 + 1), "whole.bin": Buffer.alloc(4 * 1024 * 1024) });
  fs.writeFileSync(path.join(tmp, "secret.txt"), "not the view's");
  fs.symlinkSync(path.join(tmp, "secret.txt"), path.join(dir, "leak.txt"));
  installed("desk-only", { name: "Desk only" });
  installed("bad", { name: "Bad", phone: "yes" });
  const phone = c.caller();
  assert.deepEqual(await c.call("view.list", [], phone), [{ id: "priya-board", name: "Priya's board", version: "1.0.0", entry: "index.html" }]);
  assert.deepEqual(await c.call("view.file", ["priya-board", "index.html"], phone), {
    data: Buffer.from("<!doctype html><title>priya-board</title>").toString("base64"), type: "text/html; charset=utf-8",
  });
  assert.deepEqual(await c.call("view.file", ["priya-board", "main.js"], phone), { data: Buffer.from("export {};").toString("base64"), type: "text/javascript; charset=utf-8" });
  assert.equal(((await c.call("view.file", ["priya-board", "whole.bin"], phone)) as { data: string }).data.length, Math.ceil((4 * 1024 * 1024) / 3) * 4);
  for (const [view, file] of [["priya-board", "../desk-only/index.html"], ["priya-board", "leak.txt"], ["priya-board", "big.bin"], ["priya-board", "gone.js"], ["desk-only", "index.html"], ["bad", "index.html"]]) {
    assert.equal(await code(c.call("view.file", [view, file], phone)), "BAD_REQUEST", `${view} ${file}`);
  }
});

test("a view opened on a workspace here is told, once ready, where it is (a phone's screen) and what the board holds, as the window tells a view: its caller alone", async () => {
  const c = computer();
  installed("priya-board", { name: "Priya's board", phone: true, permissions: ["workspace:spawn", "workspace:close", "workspace:edit", "workspace:prompt", "workspace:sessions"] });
  const [phone, other] = [c.caller(), c.caller()];
  assert.equal(await code(c.call("view.open", ["priya-board", path.join(tmp, "elsewhere")], phone)), "BAD_REQUEST");
  const { session } = (await c.call("view.open", ["priya-board", c.repo], phone)) as { session: string };
  assert.deepEqual(c.said(phone, session), [], "nothing before the view says it is ready");
  c.post(phone, session, { type: "ready", v: 1 });
  assert.deepEqual(c.said(phone, session), [
    {
      type: "hello", v: 1, pluginId: "priya-board", capabilities: ["workspace:spawn", "workspace:close", "workspace:edit"], theme: { colors: {} },
      layout: null, viewport: { w: 0, h: 0 }, visible: true, features: ["agentStatus"], device: { touch: true, compact: true },
    },
    {
      type: "structure",
      frames: [
        { id: "f1", title: "api", color: "#79abcf", folder: { name: "api", kind: "folder" } },
        { id: "f2", title: "build box", color: "#aabbcc", machine: { name: "build box", state: "idle" }, folder: { name: "api", kind: "folder" } },
      ],
      tiles: [{ id: "t1", frameId: "f1", kind: "claude", name: "Fixing the nav", agent: "claude" }, { id: "t2", frameId: "f2", kind: "shell", name: "Priya's shell" }],
      links: { pipes: [], spawns: [] },
    },
    { type: "names", names: { t1: "Fixing the nav", t2: "Priya's shell" } },
    { type: "selection", tileId: null, frameId: null, fresh: false },
  ]);
  assert.deepEqual(other.got, []);

  // The board changes: told what changed, and only that.
  const before = c.said(phone, session).length;
  c.status.mirror("t1", priyaStatus({ title: "Testing the nav" }));
  c.status.mirror("t1", priyaStatus({ title: "Testing the nav", state: "working", kind: undefined }));
  c.setLinks({ pipes: [{ src: "t1", dst: "t2" }], spawns: [] });
  const told = c.said(phone, session).slice(before);
  assert.deepEqual(told.map((m) => m.type), ["structure", "names", "structure"]);
  assert.deepEqual((told[0]!.tiles as Array<{ name: string }>).map((t) => t.name), ["Testing the nav", "Priya's shell"]);
  assert.deepEqual(told[1]!.names, { t1: "Testing the nav", t2: "Priya's shell" });
  assert.deepEqual(told[2]!.links, { pipes: [{ src: "t1", dst: "t2" }], spawns: [] });
});

test("what the view does is done on the board as its caller, and recorded; what its caller may not do, it may not either", async () => {
  const c = computer();
  installed("priya-board", { name: "Priya's board", phone: true, permissions: ["workspace:spawn", "workspace:close", "workspace:edit"] });
  // The person's phone: it may start an agent and nothing else of these.
  const phone = c.caller((method) => method === "agent.start");
  const { session } = (await c.call("view.open", ["priya-board", c.repo], phone)) as { session: string };
  c.post(phone, session, { type: "ready", v: 1 });
  assert.deepEqual(c.said(phone, session)[0]!.capabilities, ["workspace:spawn"]);
  c.post(phone, session, { type: "command", name: "renameTile", args: ["t1", "Priya's agent"] });
  c.post(phone, session, { type: "command", name: "closeTile", args: ["t2"] });
  c.post(phone, session, { type: "command", name: "spawnAgent", args: ["claude", "f1", { name: "reviewer" }] });
  c.post(phone, session, { type: "command", name: "selectTile", args: ["t2"] });
  const audited = () => fs.existsSync(path.join(c.dir, "audit.jsonl"));
  for (let t = 0; t < 2_000 && !audited(); t += 20) await wait(20);
  assert.ok(c.said(phone, session).some((m) => m.type === "structure" && (m.tiles as unknown[]).length === 3), "it hears the agent it started");
  assert.deepEqual(c.started, [{ repo: c.repo, start: { program: "claude", frame: "f1", name: "reviewer" } }]);
  assert.deepEqual(c.closed, []);
  assert.equal(c.store.getCore(c.repo)!.tileNames?.t1, undefined);
  const recorded = () => c.audit().map(({ actor, verb, target, detail, outcome }) => ({ actor, verb, target, detail, outcome }));
  assert.deepEqual(recorded(), [{ actor: PHONE, verb: "agent.start", target: "t3", detail: "view priya-board", outcome: "ok" }]);
  assert.deepEqual(c.said(phone, session).filter((m) => m.type === "selection").at(-1), { type: "selection", tileId: "t2", frameId: null, fresh: true });

  // At the person's computer, every permission the view asks: it renames and closes, and hears it.
  const desk = c.caller(undefined, { kind: "person" });
  const { session: s2 } = (await c.call("view.open", ["priya-board", c.repo], desk)) as { session: string };
  c.post(desk, s2, { type: "ready", v: 1 });
  c.post(desk, s2, { type: "command", name: "selectTile", args: ["t2"] });
  c.post(desk, s2, { type: "command", name: "renameTile", args: ["t1", "Priya's agent"] });
  c.post(desk, s2, { type: "command", name: "closeTile", args: ["t2"] });
  for (let t = 0; t < 2_000 && recorded().length < 2; t += 20) await wait(20);
  assert.deepEqual(c.closed, ["t2"]);
  const told = c.said(desk, s2);
  assert.deepEqual(told.filter((m) => m.type === "names").at(-1)!.names, { t1: "Priya's agent", t3: "Claude #2" });
  assert.deepEqual((told.filter((m) => m.type === "structure").at(-1)!.tiles as Array<{ id: string }>).map((t) => t.id), ["t1", "t3"]);
  // What it had selected is gone, and it is told so.
  assert.deepEqual(told.filter((m) => m.type === "selection").at(-1), { type: "selection", tileId: null, frameId: null, fresh: true });
  assert.deepEqual(recorded().at(-1), { actor: { kind: "person" }, verb: "agent.close", target: "t2", detail: "view priya-board", outcome: "ok" });
});

test("a tile's status follows the view that asks: its bucket and its agent's, now and as it changes, until it stops asking", async () => {
  const c = computer();
  installed("priya-board", { name: "Priya's board", phone: true });
  const phone = c.caller();
  const { session } = (await c.call("view.open", ["priya-board", c.repo], phone)) as { session: string };
  c.post(phone, session, { type: "ready", v: 1 });
  c.post(phone, session, { type: "subscribeStatus", tileId: "t1" });
  c.status.mirror("t1", priyaStatus({ state: "working", kind: undefined }));
  c.post(phone, session, { type: "unsubscribeStatus", tileId: "t1" });
  c.status.mirror("t1", priyaStatus({ state: "idle", kind: undefined }));
  const statuses = c.said(phone, session).filter((m) => m.type === "status").map((m) => `${String(m.status)}/${(m.agent as { state: string } | undefined)?.state}`);
  assert.deepEqual(statuses, ["blocked/undefined", "blocked/waiting", "working/waiting", "working/working"]);
});

test("a session ends when its caller closes it or goes, or when its host disables the view, told why: nothing is said in it after", async () => {
  const c = computer();
  installed("priya-board", { name: "Priya's board", phone: true });
  const phone = c.caller();
  const open = async () => {
    const { session } = (await c.call("view.open", ["priya-board", c.repo], phone)) as { session: string };
    c.post(phone, session, { type: "ready", v: 1 });
    c.post(phone, session, { type: "subscribeStatus", tileId: "t1" });
    return session;
  };
  const closing = await open();
  assert.deepEqual(await c.call("view.close", [closing], phone), { closed: true });
  assert.deepEqual(await c.call("view.close", [closing], phone), { closed: false });
  const disabled = await open();
  for (let i = 0; i < 8; i++) c.post(phone, disabled, { type: "nonsense" });
  assert.deepEqual(phone.got.filter((e) => e.event === "view.ended").map((e) => e.params), [[disabled, "8 malformed or unauthorised messages (last: unknown message type \"nonsense\")"]]);
  const change = (state: SessionStatus["state"], name: string) => {
    c.status.mirror("t1", priyaStatus({ state, kind: undefined }));
    c.store.renameTile("t2", name);
  };
  // Every client hears the board change; a view's caller is told nothing in a session that ended.
  const told = () => phone.got.filter((e) => e.event.startsWith("view.")).length;
  let heard = told();
  change("working", "Priya's other shell");
  assert.equal(told(), heard, `nothing more in ${closing} or ${disabled}`);
  const gone = await open();
  phone.go();
  heard = told();
  change("idle", "Priya's last shell");
  assert.equal(told(), heard, `nothing more in ${gone}`);
});
