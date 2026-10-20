// Community views on a remote screen (views.ts, spec/workspace-api.md "Views on a remote screen"):
// the views installed here that say they work on a phone are offered, with the page to load, and
// their files as the app serves them (the SDK, the page that runs a `.js` entry, a page with the
// SDK's import map), each under its policy, inside the package and 4 MiB at most; a view opened on
// a workspace here is told, once it is ready, what the window would tell it, as a phone's screen of
// the size and look its caller says, and what changes of that screen after, to its caller alone;
// what it does is done on the board as its caller, and recorded, and what its caller may not do is
// refused; its tiles' statuses follow it; and its session ends when its caller closes it or goes,
// or when its host disables it, told why.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setCatalog, type AgentProviderDef } from "@hivemind/agents";
import { StatusStore, type SessionStatus } from "@hivemind/agent-host/status-store";
import { listInstalledViews } from "@hivemind/core/views";
import { pluginCsp, withImportMap } from "@hivemind/core/view-files";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { newSeed } from "@hivemind/workspace-host/identity";
import { Intents } from "@hivemind/workspace-host/intents";
import { WorkspaceStore } from "@hivemind/workspace-host/store";
import { WorkspaceServer, type Connection } from "@hivemind/workspace-api/server";
import type { EventMessage } from "@hivemind/workspace-api/protocol";
import { installPackage } from "@hivemind/core/package-install";
import { views } from "../src/views.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-views-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let made = 0;
setCatalog([{ id: "claude", label: "Claude Code", bin: "claude", enabled: true } as unknown as AgentProviderDef]);

/** A view installed on this device, as `hive plugins install` installs one, its manifest
 *  `manifest` and its files `files`; the folder it is installed in. One that cannot be installed
 *  is not there. */
async function installed(id: string, manifest: object, files: Record<string, string | Buffer> = {}): Promise<string> {
  const dir = path.join(process.env.XDG_CONFIG_HOME!, "sources", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "hivemind-view.json"), JSON.stringify({ id, version: "1.0.0", entry: "index.html", protocol: 1, ...manifest }));
  fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html><title>${id}</title>`);
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return installPackage(dir).then((p) => p.members[0]!.dir, () => dir);
}
beforeEach(() => { process.env.XDG_CONFIG_HOME = path.join(tmp, `xdg-${made++}`); });

/** Priya's phone, her own device. */
const PHONE = { kind: "peer", person: "p".repeat(64), device: "d".repeat(64), access: "owner" } as const;

/** The SDK this device serves its views. */
const SDK = "export const connect = async () => ({});";

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
  const slept: string[] = [];
  const woke: string[] = [];
  const pressed: Array<{ id: string; press: unknown }> = [];
  const intents = new Intents(new AuditLog({ file: path.join(dir, "audit.jsonl") }));
  const store: WorkspaceStore = new WorkspaceStore({
    dir: path.join(dir, "workspaces"), person: newSeed(),
    onChange: (change) => server.publish("store.changed", { repo: change.repo, part: change.part }),
  });
  const server: WorkspaceServer = new WorkspaceServer([views({
    installed: () => listInstalledViews(),
    sdk: async () => SDK,
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
    // As the control plane does, once the agent's process has ended or started again.
    sleep: async (at, tile) => { slept.push(`${at}:${tile}`); store.setSleeping(tile, at); },
    wake: async (at, tile) => { woke.push(`${at}:${tile}`); store.setSleeping(tile, null); },
    machines: { self: () => ({ device: "d1", name: "desk" }), mine: () => undefined, whose: () => undefined, saved: (id) => (id === "m1" ? "build box" : undefined) },
    intents,
    widgets: { watch: (_repo, cb) => { cb([]); return () => {}; }, press: (_repo, id, press) => pressed.push({ id, press }) },
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
  const screen = (from: Connection, session: string, shown: unknown) => server.notice("view.screen", [session, shown], from);
  /** What a caller's view has been told in `session`, in order. */
  const said = (c: { got: EventMessage[] }, session: string) =>
    c.got.filter((e) => e.event === "view.said" && e.params[0] === session).map((e) => e.params[1] as Record<string, unknown>);
  const audit = () => fs.readFileSync(path.join(dir, "audit.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  return { pressed,  dir, repo, store, status, started, closed, slept, woke, caller, call, post, screen, said, audit, setLinks: (l: typeof links) => { links = l; server.publish("link.pipe", { src: "t1", dst: "t2", connected: true }); } };
}
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return (e as { code?: string }).code; } };

test("the views here that say they work on a phone are offered with the page to load, and their files as the app serves them: inside the package, 4 MiB at most, base64 with their type and their policy", async () => {
  const c = computer();
  const dir = await installed("priya-board", { name: "Priya's board", phone: true }, { "main.js": "export {};", "big.bin": Buffer.alloc(4 * 1024 * 1024 + 1), "big.html": "<p>".padEnd(4 * 1024 * 1024 + 1, "x"), "whole.bin": Buffer.alloc(4 * 1024 * 1024) });
  fs.writeFileSync(path.join(tmp, "secret.txt"), "not the view's");
  fs.symlinkSync(path.join(tmp, "secret.txt"), path.join(dir, "leak.txt"));
  // A view whose entry is its script: shown through the page that runs it.
  await installed("priya-queue", { name: "Priya's queue", phone: true, entry: "view.js" }, { "view.js": "export {};" });
  await installed("desk-only", { name: "Desk only" });
  await installed("bad", { name: "Bad", phone: "yes" });
  const phone = c.caller();
  assert.deepEqual(await c.call("view.list", [], phone), [
    { id: "priya-board", name: "Priya's board", version: "1.0.0", entry: "index.html", page: "index.html" },
    { id: "priya-queue", name: "Priya's queue", version: "1.0.0", entry: "view.js", page: "__entry.html" },
  ]);
  /** One of a view's files as served: its text and type, and the nonce its policy names, the
   *  policy being the one every view document gets. */
  const file = async (view: string, at: string) => {
    const served = (await c.call("view.file", [view, at], phone)) as { data: string; type: string; csp: string };
    const nonce = served.csp.match(/'nonce-([^']+)'/)![1]!;
    assert.equal(served.csp, pluginCsp(nonce), `${view} ${at}`);
    return { text: Buffer.from(served.data, "base64").toString(), type: served.type, nonce };
  };
  const page = await file("priya-board", "index.html");
  assert.deepEqual([page.text, page.type], [withImportMap("<!doctype html><title>priya-board</title>", page.nonce, "index.html"), "text/html; charset=utf-8"]);
  const script = await file("priya-board", "main.js");
  assert.deepEqual([script.text, script.type], ["export {};", "text/javascript; charset=utf-8"]);
  const sdk = await file("priya-board", "__sdk.js");
  assert.deepEqual([sdk.text, sdk.type], [SDK, "text/javascript; charset=utf-8"]);
  const entry = await file("priya-queue", "__entry.html");
  assert.ok(entry.text.includes(`<script type="module" nonce="${entry.nonce}" src="./view.js"></script>`), entry.text);
  assert.equal(((await c.call("view.file", ["priya-board", "whole.bin"], phone)) as { data: string }).data.length, Math.ceil((4 * 1024 * 1024) / 3) * 4);
  for (const [view, at] of [["priya-board", "../desk-only/index.html"], ["priya-board", "leak.txt"], ["priya-board", "big.bin"], ["priya-board", "big.html"], ["priya-board", "gone.js"], ["priya-board", "__entry.html"], ["desk-only", "index.html"], ["bad", "index.html"]]) {
    assert.equal(await code(c.call("view.file", [view, at], phone)), view === "bad" ? "NOT_FOUND" : "BAD_REQUEST", `${view} ${at}`);
  }
  // A view here that is not for a phone says so; one that is not here says that.
  const said = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return (e as Error).message; } };
  assert.equal(await said(c.call("view.file", ["desk-only", "index.html"], phone)), "no view desk-only here works on a phone");
  assert.equal(await said(c.call("view.file", ["nowhere", "index.html"], phone)), "no view nowhere here");
});

test("a guest desktop can load the host's desktop view without installing it, with view-role commands withheld", async () => {
  const c = computer();
  await installed("desk-only", { name: "Desk only", permissions: ["workspace:spawn", "workspace:edit"] }, { "scene.js": "export const scene = true;" });
  const guest = c.caller(() => false, { ...PHONE, access: "view" });
  const listed = await c.call("view.list", [c.repo, "desktop"], guest) as Array<{ id: string; manifest?: { permissions: string[] } }>;
  assert.deepEqual(listed.map((v) => v.id), ["desk-only"]);
  assert.deepEqual(listed[0]?.manifest?.permissions, ["workspace:spawn", "workspace:edit"]);
  const file = await c.call("view.file", ["desk-only", "scene.js", c.repo], guest) as { data: string };
  assert.equal(Buffer.from(file.data, "base64").toString(), "export const scene = true;");
  assert.equal(await code(c.call("view.open", ["desk-only", c.repo, { w: 400, h: 800, theme: { colors: {} } }], guest)), "BAD_REQUEST", "a phone still gets only phone views");
  const { session } = await c.call("view.open", ["desk-only", c.repo, { w: 1200, h: 800, theme: { colors: {} }, device: { touch: false, compact: false } }, true], guest) as { session: string };
  c.post(guest, session, { type: "ready", v: 1 });
  assert.deepEqual(c.said(guest, session)[0]?.capabilities, []);
  assert.deepEqual(c.said(guest, session)[0]?.device, { touch: false, compact: false });
  c.post(guest, session, { type: "command", name: "spawnAgent", args: ["claude", null] });
  assert.deepEqual(c.started, []);
  assert.equal(c.store.getCore(c.repo)?.tiles.length, 2);
});

test("a view opened on a workspace here is told, once ready, where it is (a phone's screen) and what the board holds, as the window tells a view: its caller alone", async () => {
  const c = computer();
  await installed("priya-board", { name: "Priya's board", phone: true, permissions: ["workspace:spawn", "workspace:close", "workspace:edit", "workspace:prompt", "workspace:sessions"] });
  const [phone, other] = [c.caller(), c.caller()];
  assert.equal(await code(c.call("view.open", ["priya-board", path.join(tmp, "elsewhere")], phone)), "NOT_FOUND");
  const { session } = (await c.call("view.open", ["priya-board", c.repo], phone)) as { session: string };
  assert.deepEqual(c.said(phone, session), [], "nothing before the view says it is ready");
  c.post(phone, session, { type: "ready", v: 1 });
  assert.deepEqual(c.said(phone, session), [
    {
      type: "hello", v: 1, pluginId: "priya-board", capabilities: ["workspace:spawn", "workspace:close", "workspace:edit"], theme: { colors: {} },
      layout: null, viewport: { w: 0, h: 0 }, visible: true, features: ["agentStatus", "widgets", "invoke", "sleep"], device: { touch: true, compact: true },
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

test("a screen that places live surfaces itself says so, and its view is told it may ask for them; a screen that does not is not, and `surfaces` is true or false", async () => {
  const c = computer();
  await installed("priya-board", { name: "Priya's board", phone: true });
  const phone = c.caller();
  const features = async (...surfaces: unknown[]) => {
    const { session } = (await c.call("view.open", ["priya-board", c.repo, null, ...surfaces], phone)) as { session: string };
    c.post(phone, session, { type: "ready", v: 1 });
    return (c.said(phone, session).find((m) => m.type === "hello") as { features: string[] }).features;
  };
  assert.deepEqual(await features(true), ["agentStatus", "widgets", "invoke", "surfaces", "sleep"]);
  assert.deepEqual(await features(false), ["agentStatus", "widgets", "invoke", "sleep"]);
  assert.deepEqual(await features(), ["agentStatus", "widgets", "invoke", "sleep"]);
  assert.equal(await code(c.call("view.open", ["priya-board", c.repo, null, "yes"], phone)), "BAD_REQUEST");
});

test("a view is shown on its caller's screen: told its size and look once ready, the newest, and after only what of them changes; a screen not as the protocol has it is refused", async () => {
  const c = computer();
  await installed("priya-board", { name: "Priya's board", phone: true });
  const phone = c.caller();
  const dark = { colors: { bg: "#101418", fg: "#E8EAED" }, mode: "dark", accent: "#3a7bd5", fonts: { ui: "system-ui", mono: "ui-monospace" }, status: { working: "#4caf50" } };
  const light = { ...dark, mode: "light", colors: { bg: "#ffffff", fg: "#202124" } };
  const { session } = (await c.call("view.open", ["priya-board", c.repo, { w: 390, h: 844, theme: dark }], phone)) as { session: string };
  // The keyboard came up before it was ready: it is told the screen as it is by then.
  c.screen(phone, session, { w: 390, h: 500, theme: dark });
  c.post(phone, session, { type: "ready", v: 1 });
  const hello = c.said(phone, session)[0]!;
  assert.deepEqual([hello.type, hello.viewport, hello.theme], ["hello", { w: 390, h: 500 }, { ...dark, colors: { bg: "#101418", fg: "#e8eaed" } }]);
  const before = c.said(phone, session).length;
  c.screen(phone, session, { w: 844, h: 390, theme: dark });
  c.screen(phone, session, { w: 844, h: 390, theme: light });
  c.screen(phone, session, { w: 844, h: 390, theme: light });
  c.screen(phone, session, { w: -844, h: 390, theme: light });
  assert.deepEqual(c.said(phone, session).slice(before), [{ type: "resize", w: 844, h: 390 }, { type: "theme", theme: light }]);
  const bad: unknown[] = [
    { w: -1, h: 2, theme: dark }, { w: 1.5, h: 2, theme: dark }, { w: 1, h: 2 }, { w: 1, h: 2, theme: { colors: { bg: "red" } } },
    { w: 1, h: 2, theme: { colors: {}, mode: "dim" } }, { w: 1, h: 2, theme: { colors: {}, fonts: { ui: "x;}", mono: "y" } } },
  ];
  for (const screen of bad) assert.equal(await code(c.call("view.open", ["priya-board", c.repo, screen], phone)), "BAD_REQUEST", JSON.stringify(screen));
});

test("what the view does is done on the board as its caller, and recorded; what its caller may not do, it may not either", async () => {
  const c = computer();
  await installed("priya-board", { name: "Priya's board", phone: true, permissions: ["workspace:spawn", "workspace:close", "workspace:edit"] });
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

test("an agent asleep is shown asleep with when it slept, never where; the view wakes it and puts it to sleep as its caller, recorded, and a caller who may not, may not", async () => {
  const c = computer();
  await installed("priya-board", { name: "Priya's board", phone: true, permissions: ["workspace:spawn"] });
  const before = Date.now();
  c.store.setSleeping("t1", c.repo);
  const tileOne = (told: Array<Record<string, unknown>>) => (told.filter((m) => m.type === "structure").at(-1)!.tiles as Array<Record<string, unknown>>)[0]!;
  // A phone that may start agents but not wake or sleep them: its view may not either.
  const starts = c.caller((method) => method === "agent.start");
  const { session: s1 } = (await c.call("view.open", ["priya-board", c.repo], starts)) as { session: string };
  c.post(starts, s1, { type: "ready", v: 1 });
  c.post(starts, s1, { type: "command", name: "wakeAgent", args: ["t1"] });
  await wait(50);
  assert.deepEqual(c.woke, []);

  const phone = c.caller();
  const { session } = (await c.call("view.open", ["priya-board", c.repo], phone)) as { session: string };
  c.post(phone, session, { type: "ready", v: 1 });
  const asleep = tileOne(c.said(phone, session));
  assert.deepEqual(Object.keys(asleep), ["id", "frameId", "kind", "name", "agent", "asleep"]);
  const since = (asleep.asleep as { since: number }).since;
  assert.ok(since >= before && since <= Date.now(), `slept at ${since}`);
  c.post(phone, session, { type: "command", name: "wakeAgent", args: ["t1"] });
  const recorded = () => (fs.existsSync(path.join(c.dir, "audit.jsonl")) ? c.audit() : []).map(({ verb, target, detail, outcome }) => ({ verb, target, detail, outcome }));
  for (let t = 0; t < 2_000 && recorded().length < 1; t += 20) await wait(20);
  assert.deepEqual(c.woke, [`${c.repo}:t1`]);
  assert.equal(tileOne(c.said(phone, session)).asleep, undefined, "woken, it is told the agent is awake");
  c.post(phone, session, { type: "command", name: "sleepAgent", args: ["t1"] });
  for (let t = 0; t < 2_000 && recorded().length < 2; t += 20) await wait(20);
  assert.deepEqual(c.slept, [`${c.repo}:t1`]);
  assert.ok(tileOne(c.said(phone, session)).asleep);
  assert.deepEqual(recorded(), [
    { verb: "agent.wake", target: "t1", detail: "view priya-board", outcome: "ok" },
    { verb: "agent.sleep", target: "t1", detail: "view priya-board", outcome: "ok" },
  ]);
});

test("a tile's status follows the view that asks: its bucket and its agent's, now and as it changes, until it stops asking", async () => {
  const c = computer();
  await installed("priya-board", { name: "Priya's board", phone: true });
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
  await installed("priya-board", { name: "Priya's board", phone: true });
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

test("a widget pressed through a view is the opener's press, held to its role: one who may only look presses nothing", async () => {
  const c = computer();
  await installed("widgets", { name: "Widgets", phone: true, permissions: ["workspace:widgets"] });
  await installed("lookout", { name: "Look only", phone: true });
  const open = async (who: ReturnType<typeof c.caller>) => {
    const { session } = await c.call("view.open", ["widgets", c.repo, { w: 400, h: 800, theme: { colors: {} } }], who) as { session: string };
    c.post(who, session, { type: "ready", v: 1 });
    c.post(who, session, { type: "pressWidget", id: "w1", action: "pat" });
  };
  await open(c.caller((m) => m !== "widget.press", { ...PHONE, access: "view" }));
  assert.deepEqual(c.pressed, []);
  // A view that did not ask to press widgets presses none, whoever opened it.
  const owner = c.caller();
  const { session } = await c.call("view.open", ["lookout", c.repo, { w: 400, h: 800, theme: { colors: {} } }], owner) as { session: string };
  c.post(owner, session, { type: "ready", v: 1 });
  c.post(owner, session, { type: "pressWidget", id: "w1", action: "pat" });
  assert.deepEqual(c.pressed, []);
  await open(c.caller());
  assert.deepEqual(c.pressed, [{ id: "w1", press: { action: "pat" } }]);
});
