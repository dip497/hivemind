/** `hive ctl` on a REAL drive socket (the host's serveDrive and workspace server, a scripted
 *  domain): who it is (the person, or the agent whose tile token it holds), the workspace it acts
 *  on, each verb as its API method, `--json` shapes, exit codes, read's short polls, sleep and wake
 *  refused when they did nothing, and `agents --watch` following the feed's events. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Intents, type Actor } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { WorkspaceServer, type Connection } from "@hivemind/workspace-api/server";
import { ApiError } from "@hivemind/workspace-api/protocol";
import { tileToken } from "@hivemind/agent-host/hooks/token";
import { serveDrive, type DriveServer } from "@hivemind/host/drive";
import { Grants } from "@hivemind/host/grants";
import { cmd, hiveAsync as hive, sealedEnv } from "./helpers.js";
import { fixtureXDG } from "./agents-fixtures.js";

const unix = process.platform !== "win32";
// sun_path is ~108 bytes; os.tmpdir() can be deep, /tmp is not.
const dir = unix ? fs.realpathSync(fs.mkdtempSync("/tmp/hive-ctl-drive-")) : "";
const sock = path.join(dir, "drive.sock");
const repoA = path.join(dir, "a");
const repoB = path.join(dir, "b");
/** A workspace in another's folder, as a worktree's may be. */
const nested = path.join(repoA, "sub");
/** A workspace on another machine, named by its address. */
const onBox = "ssh://build-box/srv/api";
const TOKEN = "t0k3n";
const calls: Array<{ method: string; params: unknown[]; by: Actor }> = [];
let reads = 0;
/** After this many agent.read calls, the turn completes. */
let turnAfterReads = 0;
let server: WorkspaceServer;
let drive: DriveServer;
const grants = unix ? new Grants(path.join(dir, "grants.json")) : (null as unknown as Grants);
// The CLI checks --agent against the agents installed; this machine has the fixture ones.
const xdg = fixtureXDG(["claude", "codex"]);
const env = (token = TOKEN) => ({ XDG_CONFIG_HOME: xdg, HIVE_DRIVE_SOCK: sock, HCP_TOKEN: token });
const asAgent = () => env(tileToken(TOKEN, "hm:me-1"));

const answer = (method: string, reply: (...params: unknown[]) => unknown) => [method, (from: Connection, ...params: unknown[]) => {
  calls.push({ method, params, by: from.actor });
  return reply(...params);
}] as const;

beforeAll(async () => {
  for (const r of [repoA, repoB]) fs.mkdirSync(path.join(r, "sub"), { recursive: true });
  const answers = Object.fromEntries([
    answer("host.status", () => ({ workspaces: [repoA, nested, repoB, onBox].map((repo) => ({ repo, workspace: null })) })),
    answer("agent.list", () => ({ seq: 3, agents: [{ tile: "w-1", agent: "worker", state: "idle" }, asking] })),
    answer("agent.answer", (_tile, since) => ({ answered: since === 77 })),
    answer("agent.startable", () => ({ programs: [], frames: [{ id: "f1", name: "a", machine: "here" }] })),
    answer("agent.start", () => ({ tile: "w-2" })),
    answer("agent.send", (tile, text) => { if (!text) throw new ApiError("BAD_REQUEST", "text required"); return { sent: tile !== "ghost" }; }),
    answer("agent.close", (tile) => ({ closed: tile !== "ghost" })),
    answer("agent.sleep", (_repo, target) => (target === "busy" ? { slept: [], skipped: [{ tile: "w-1", why: "working: --force puts it to sleep anyway" }] } : { slept: ["w-1"], skipped: [{ tile: "s-1", why: "not an agent: only an agent comes back where it was" }] })),
    answer("agent.wake", (_repo, target) => {
      if (target === "ghost") throw new ApiError("NOT_FOUND", 'no tile or frame here answers to "ghost"');
      return target === "w-2" ? { woke: [], skipped: [{ tile: "w-2", why: "tile w-1 runs this conversation now" }] } : { woke: ["w-1"], skipped: [] };
    }),
    answer("agent.read", async (tile) => {
      if (tile === "z-1") return { text: null, finalStatus: "asleep", truncated: false, note: "it is asleep: no turn will come until hive ctl wake z-1" };
      if (++reads > turnAfterReads) return { text: `reply ${reads}`, finalStatus: "turn", truncated: false };
      await new Promise((r) => setTimeout(r, 50));
      return { text: null, finalStatus: "timeout", truncated: false };
    }),
    answer("agent.keys", (_t, keys) => ({ keys: (keys as string[]).length })),
    answer("agent.rename", (_t, name) => ({ name })),
    answer("agent.sessions", () => ({ agent: "codex", resumable: true, sessions: [] })),
    answer("tool.open", () => ({ tile: "t-9" })),
    answer("link.connect", () => null),
    answer("link.disconnect", () => null),
    answer("tile.focus", () => null),
    answer("agent.output", (_t, lines) => ({ text: `last ${String(lines)} lines\n` })),
    answer("terminal.open", (opts) => ({ pid: (opts as { tileId: string }).tileId === "hm:ghost" ? -1 : 7, joined: true })),
    answer("view.emit", (name) => (name === "ci.build" ? { id: "ev_1", delivered: true, view: "@a/valley" } : { id: "ev_3", delivered: false, view: "canvas", reason: "no-listener", buffered: true })),
    answer("plugin.commands", () => ({ plugins: [{ plugin: "@a/progress", kind: "widget", instance: "w1", label: "Progress", commands: [{ name: "add", description: "Add a step.", args: '{ "text": string }' }] }] })),
    // As the host answers (control/methods.ts pluginOpen): a tool's tile, else the window's answer.
    answer("plugin.open", (plugin) => (String(plugin).startsWith("tool:") ? { tile: "t-9" } : { widget: "w-5" })),
    answer("plugin.list", () => ({
      plugins: [
        { plugin: "@a/progress", kind: "widget", instance: "w1", label: "Progress", state: "ready", since: 1, commands: [{ name: "add", description: "Add a step." }] },
        { plugin: "@a/valley", kind: "view", instance: "@a/valley", label: "Valley", state: "failed", reason: "it did not start in 15 s", since: 2, commands: [] },
      ],
      views: [{ id: "canvas", label: "Canvas", active: true }, { id: "@a/valley", label: "Valley", active: false }],
    })),
    answer("plugin.close", (instance, plugin) => { if (instance === "ghost") throw new ApiError("NOT_FOUND", "no plugin runs as ghost"); return { closed: instance, plugin: plugin ?? "@a/progress", kind: "widget" }; }),
    answer("plugin.call", (_p, command, args, tile) => { if (command === "check") throw new ApiError("FAILED", "there is no step 7"); return { result: { echoed: args, tile: tile ?? null } }; }),
  ]);
  server = new WorkspaceServer([{ answers, effects: {} }], new Intents(new AuditLog({ file: path.join(dir, "audit.jsonl") })));
  drive = serveDrive(sock, {
    server, installToken: () => TOKEN, grants, repos: () => [repoA, repoB],
    // The agent, and the one it starts, are in workspace a.
    workspaceOf: (tile) => (tile === "me-1" || tile === "w-2" ? repoA : null), nameOf: (tile) => `the ${tile} agent`,
  });
  while (!fs.existsSync(sock)) await new Promise((r) => setTimeout(r, 10));
});
afterAll(() => {
  drive?.close();
  if (unix) fs.rmSync(dir, { recursive: true, force: true });
});
const last = (method: string) => calls.findLast((c) => c.method === method)!;
/** A worker waiting on its supervisor's answer to a tool use. */
const asking = { tile: "w-3", agent: "asker", state: "waiting", waiting: { kind: "approval", since: 77, approval: { request: "req-1", tool: "Bash", summary: "rm -rf dist", expiresAt: 0 } } };

describe.skipIf(!unix)("hive ctl on a real drive socket", () => {
  test("a program given a grant's token (a plugin's service) is that grant, in its workspace; one reaching several drives the one HIVE_WORKSPACE names", async () => {
    const { token } = grants.create({ name: "ci", repos: [repoA], role: "agents" });
    const program = { XDG_CONFIG_HOME: xdg, HIVE_DRIVE_SOCK: sock, HIVE_DRIVE_TOKEN: token };
    const r = await hive(["ctl", "agents", "--json"], { cwd: dir, env: program });
    expect(r.code).toBe(0);
    expect(last("agent.list")).toMatchObject({ params: [repoA], by: { kind: "peer", client: "ci", access: "agents" } });
    const both = grants.create({ name: "ci-both", repos: [repoA, repoB], role: "agents" }).token;
    await hive(["ctl", "agents", "--json"], { cwd: dir, env: { ...program, HIVE_DRIVE_TOKEN: both, HIVE_WORKSPACE: repoB } });
    expect(last("agent.list")).toMatchObject({ params: [repoB], by: { client: "ci-both" } });
    const unnamed = await hive(["ctl", "agents", "--json"], { cwd: dir, env: { ...program, HIVE_DRIVE_TOKEN: both } });
    expect([unnamed.code, (unnamed.json as { code: string }).code]).toEqual([2, "BAD_REQUEST"]);
  });

  test("as the person, a verb acts on the open workspace this folder is in (the innermost), else the only one, else asks which; --repo names it", async () => {
    const r = await hive(["ctl", "agents", "--json"], { cwd: path.join(repoB, "sub"), env: env() });
    expect([r.code, r.stdout.trim().split("\n").length]).toEqual([0, 1]);
    expect(r.json).toEqual({ seq: 3, agents: [{ tile: "w-1", agent: "worker", state: "idle" }, asking] });
    expect(last("agent.list").params).toEqual([repoB]);
    await hive(["ctl", "frames", "--repo", repoA, "--json"], { cwd: dir, env: env() });
    expect(last("agent.startable").params).toEqual([repoA]);
    await hive(["ctl", "agents", "--json"], { cwd: nested, env: env() });
    expect(last("agent.list").params).toEqual([nested]);
    const which = await hive(["ctl", "agents", "--json"], { cwd: dir, env: env() });
    expect([which.code, (which.json as { message: string }).message]).toEqual([2, `say which of the host's workspaces: a (not shared) at ${repoA}; sub (not shared) at ${nested}; b (not shared) at ${repoB}; api (not shared) at ${onBox}`]);
  });

  test("--repo names a workspace on another machine by its address, or its name", async () => {
    const r = await hive(["ctl", "agents", "--repo", onBox, "--json"], { cwd: dir, env: env() });
    expect(r.code).toBe(0);
    expect(last("agent.list").params).toEqual([onBox]);
    expect((await hive(["ctl", "agents", "--repo", "api", "--json"], { cwd: dir, env: env() })).code).toBe(0);
    expect(last("agent.list").params).toEqual([onBox]);
  });

  test("as an agent, by its tile's token, it drives its own workspace as itself; another is refused", async () => {
    const r = await hive(["ctl", "spawn", "--agent", "codex", "--name", "w", "--frame", "f1", "--model", "m", "--no-report", "--supervise", "Bash, Edit", "--prompt", "go", "--json"], { cwd: dir, env: asAgent() });
    expect([r.code, r.json]).toEqual([0, { tile: "w-2" }]);
    expect(last("agent.start")).toMatchObject({
      params: [repoA, { program: "codex", name: "w", frame: "f1", model: "m", prompt: "go", report: false, supervise: ["Bash", "Edit"] }],
      by: { kind: "peer", access: "agents", tile: "me-1", client: "the me-1 agent" },
    });
    // A frame by its name, in any case; one no frame answers to is not found, and nothing starts.
    await hive(["ctl", "spawn", "--agent", "codex", "--frame", "A", "--json"], { cwd: dir, env: asAgent() });
    expect(last("agent.start").params).toEqual([repoA, { program: "codex", frame: "f1" }]);
    calls.length = 0;
    const nowhere = await hive(["ctl", "spawn", "--agent", "codex", "--frame", "b", "--json"], { cwd: dir, env: asAgent() });
    expect([nowhere.code, (nowhere.json as { code: string }).code, calls.some((c) => c.method === "agent.start")]).toEqual([5, "NOT_FOUND", false]);
    const elsewhere = await hive(["ctl", "spawn", "--agent", "codex", "--repo", repoB, "--json"], { env: asAgent() });
    expect([elsewhere.code, (elsewhere.json as { code: string }).code]).toEqual([6, "FORBIDDEN"]);
  });

  test("each verb is its API method", async () => {
    for (const args of [
      ["send", "w-1", "hi"], ["keys", "w-1", "Down,Enter"], ["rename", "w-1", "reviewer"], ["rename", "w-1"], ["close", "w-1"], ["focus", "w-1"],
      ["connect", "w-1", "w-2"], ["disconnect", "w-1"], ["disconnect", "w-1", "w-2"],
      ["open-tool", "a/b/c", "--url", "https://x", "--repo", repoA], ["sessions", "codex", "--cwd", repoA, "--limit", "5"],
    ]) {
      const r = await hive(["ctl", ...args, "--json"], { env: env() });
      expect(r.code, `${args.join(" ")}: ${r.stdout}${r.stderr}`).toBe(0);
    }
    // Which workspace `--repo` names is looked up first (host.status); the verb is the call after it.
    expect(calls.filter((c) => c.method !== "host.status").slice(-11).map((c) => [c.method, ...c.params])).toEqual([
      ["agent.send", "w-1", "hi"], ["agent.keys", "w-1", ["Down", "Enter"]], ["agent.rename", "w-1", "reviewer"], ["agent.rename", "w-1", ""],
      ["agent.close", "w-1"], ["tile.focus", "w-1"], ["link.connect", "w-1", "w-2"], ["link.disconnect", "w-1"], ["link.disconnect", "w-1", "w-2"],
      ["tool.open", repoA, { tool: "a/b/c", url: "https://x" }], ["agent.sessions", repoA, "codex", 5],
    ]);
  });

  test("sleep and wake a tile, a frame or every agent of the workspace, as agent.sleep and agent.wake; nothing done with something left is exit 7, saying why", async () => {
    const one = await hive(["ctl", "sleep", "w-1", "--repo", repoA, "--json"], { env: env() });
    expect([one.code, one.json]).toEqual([0, { slept: ["w-1"], skipped: [{ tile: "s-1", why: "not an agent: only an agent comes back where it was" }] }]);
    expect(last("agent.sleep").params).toEqual([repoA, "w-1", false]);
    expect((await hive(["ctl", "sleep", "--force", "--repo", repoA], { env: env() })).code).toBe(0);
    expect(last("agent.sleep").params).toEqual([repoA, "", true]);
    const busy = await hive(["ctl", "sleep", "busy", "--repo", repoA, "--json"], { env: env() });
    expect([busy.code, busy.json]).toEqual([7, { slept: [], skipped: [{ tile: "w-1", why: "working: --force puts it to sleep anyway" }] }]);

    const woke = await hive(["ctl", "wake", "api", "--repo", repoA, "--json"], { env: env() });
    expect([woke.code, woke.json, last("agent.wake").params]).toEqual([0, { woke: ["w-1"], skipped: [] }, [repoA, "api"]]);
    const twin = await hive(["ctl", "wake", "w-2", "--repo", repoA], { env: env() });
    expect([twin.code, twin.stdout]).toEqual([7, expect.stringContaining("tile w-1 runs this conversation now")]);
    const ghost = await hive(["ctl", "wake", "ghost", "--repo", repoA, "--json"], { env: env() });
    expect([ghost.code, (ghost.json as { code: string }).code]).toEqual([5, "NOT_FOUND"]);
  }, 30_000);

  test("approve answers the wait its request names, as agent.answer; always and never decide the tool from now on; one not waiting is exit 2", async () => {
    for (const [decision, answer] of [["allow", { decision: "allow" }], ["never", { decision: "deny", always: true }], ["always", { decision: "allow", always: true }]] as const) {
      const r = await hive(["ctl", "approve", "req-1", decision, "--repo", repoA, "--json"], { env: env() });
      expect([r.code, r.json]).toEqual([0, { answered: true }]);
      expect(last("agent.answer").params).toEqual(["w-3", 77, answer]);
    }
    await hive(["ctl", "approve", "req-1", "deny", "--reason", "not that dir", "--repo", repoA], { env: env() });
    expect(last("agent.answer").params[2]).toEqual({ decision: "deny", feedback: "not that dir" });
    const gone = await hive(["ctl", "approve", "req-2", "allow", "--repo", repoA, "--json"], { env: env() });
    expect([gone.code, (gone.json as { code: string }).code]).toEqual([2, "BAD_REQUEST"]);
  });

  test("a bad token → exit 6 FORBIDDEN; an agent nobody runs → exit 5; a bad request → exit 2", async () => {
    const bad = await hive(["ctl", "agents", "--json"], { env: env("wrong") });
    expect([bad.code, (bad.json as { code: string }).code]).toEqual([6, "FORBIDDEN"]);
    for (const verb of [["send", "ghost", "hi"], ["close", "ghost"]]) {
      const nf = await hive(["ctl", ...verb, "--json"], { env: env() });
      expect([nf.code, (nf.json as { code: string }).code]).toEqual([5, "NOT_FOUND"]);
    }
    const br = await hive(["ctl", "send", "w-1", "", "--json"], { env: env() });
    expect([br.code, (br.json as { code: string }).code]).toEqual([2, "BAD_REQUEST"]);
  });

  test("read --timeout is a loop of short reads, exit 4 when it runs out; it returns as soon as a turn lands; --poll at once", async () => {
    const slices = () => calls.filter((c) => c.method === "agent.read").map((c) => c.params[1]);
    calls.length = 0; reads = 0; turnAfterReads = 1000;
    const out = await hive(["ctl", "read", "w-1", "--timeout", "25000", "--json"], { env: env() });
    expect([out.code, out.json]).toEqual([4, { text: null, finalStatus: "timeout", truncated: false }]);
    expect(slices()).toEqual([10000, 10000, 5000]); // never one 25 s request
    calls.length = 0; reads = 0; turnAfterReads = 1;
    const turn = await hive(["ctl", "read", "w-1", "--timeout", "30000", "--json"], { env: env() });
    expect([turn.code, turn.json, slices().length]).toEqual([0, { text: "reply 2", finalStatus: "turn", truncated: false }, 2]);
    calls.length = 0; reads = 0; turnAfterReads = 1000;
    const poll = await hive(["ctl", "read", "w-1", "--poll", "--json"], { env: env() });
    expect([poll.code, slices()]).toEqual([0, [0]]);
  });

  test("read of an agent asleep stops at once, exit 7, saying so", async () => {
    calls.length = 0;
    const out = await hive(["ctl", "read", "z-1", "--timeout", "25000", "--json"], { env: env() });
    expect([out.code, out.json, calls.filter((c) => c.method === "agent.read").length]).toEqual([7, { text: null, finalStatus: "asleep", truncated: false, note: "it is asleep: no turn will come until hive ctl wake z-1" }, 1]);
  }, 30_000);

  test("agents --watch prints what happens to the workspace's agents after the list, one JSON a line, and nothing of another's: as the person, and as an agent", async () => {
    const event = (seq: number, tile: string) => ({ seq, at: 0, kind: "turnEnded", tile, detail: "done" });
    for (const [who, args] of [[env(), ["--repo", repoA]], [asAgent(), []]] as const) {
      calls.length = 0;
      const watch = spawn(...cmd(["ctl", "agents", "--watch", ...args, "--json"]), { env: { ...sealedEnv(), ...who } });
      let out = "";
      watch.stdout.setEncoding("utf8").on("data", (d: string) => { out += d; });
      while (!calls.some((c) => c.method === "agent.list")) await new Promise((r) => setTimeout(r, 20));
      // In one moment: an agent's connection hears them as one list.
      server.publish("agent.event", repoA, event(3, "listed"));
      server.publish("agent.event", repoB, event(4, "elsewhere"));
      server.publish("agent.event", repoA, event(4, "w-1"));
      for (const end = Date.now() + 5_000; !out.includes('"w-1"') && Date.now() < end;) await new Promise((r) => setTimeout(r, 20));
      watch.kill();
      expect(out.trim().split("\n").map((l) => JSON.parse(l))).toEqual([event(4, "w-1")]);
    }
  });

  test("workflow: an agent's workers are started in its workspace, as silent workers, each reply read and closed once in", async () => {
    calls.length = 0; reads = 0; turnAfterReads = 0;
    const r = await hive(["ctl", "workflow", "--items", "a || b", "--prompt", "do {item}", "--frame", "A", "--max-concurrent", "1", "--close", "--json"], { env: asAgent() });
    expect([r.code, r.json]).toEqual([0, { shape: "fanout", items: [{ item: "a", tile: "w-2", status: "turn", text: "reply 1" }, { item: "b", tile: "w-2", status: "turn", text: "reply 2" }] }]);
    expect(calls.map((c) => [c.method, c.params])).toEqual([
      ["agent.startable", [repoA]],
      ["agent.start", [repoA, { program: "claude", prompt: "do a", name: "a", report: false, frame: "f1" }]], ["agent.read", ["w-2", 10_000]], ["agent.close", ["w-2"]],
      ["agent.start", [repoA, { program: "claude", prompt: "do b", name: "b", report: false, frame: "f1" }]], ["agent.read", ["w-2", 10_000]], ["agent.close", ["w-2"]],
    ]);
  });

  test("stream: --snapshot prints the last lines it printed; live, what it prints as it comes, never a copy of its screen, until it ends; nothing running is exit 5", async () => {
    const snap = await hive(["ctl", "stream", "w-1", "--snapshot", "--json"], { env: env() });
    expect([snap.code, snap.stdout.trim().split("\n").map((l) => JSON.parse(l))]).toEqual([0, [{ seq: 0, chunk: "last 40 lines\n", printed: true }, { end: true }]]);
    expect(last("agent.output").params).toEqual(["w-1", 40]);
    calls.length = 0;
    const live = hive(["ctl", "stream", "w-1", "--json"], { env: env() });
    while (!calls.some((c) => c.method === "terminal.open")) await new Promise((r) => setTimeout(r, 20));
    expect(last("terminal.open").params).toEqual([{ tileId: "hm:w-1", cols: 80, rows: 24, attachOnly: true, liveOnly: true }]);
    server.publish("terminal.data", "hm:w-1", "\x1bcthe screen");
    server.publish("terminal.data", "hm:w-2", "another's");
    server.publish("terminal.data", "hm:w-1", "\x1b[31mnew\x1b[0m line\n");
    server.publish("terminal.exit", "hm:w-1", { code: 0 });
    const r = await live;
    expect([r.code, r.stdout.trim().split("\n").map((l) => JSON.parse(l))]).toEqual([0, [{ seq: 0, chunk: "new line\n" }, { end: true }]]);
    const none = await hive(["ctl", "stream", "ghost", "--json"], { env: env() });
    expect([none.code, (none.json as { code: string }).code]).toEqual([5, "NOT_FOUND"]);
  });

  test("view emit: --json shapes for delivered and not listening", async () => {
    const d = await hive(["ctl", "view", "emit", "ci.build", '{"state":"failed"}', "--json"], { env: env() });
    expect([d.code, d.json]).toEqual([0, { id: "ev_1", delivered: true, view: "@a/valley" }]);
    expect(last("view.emit").params).toEqual(["ci.build", { state: "failed" }]);
    const none = await hive(["ctl", "view", "emit", "deploy.done"], { env: env() });
    expect([none.code, none.stdout.trim()]).toEqual([0, "buffered (active view canvas isn't listening)"]);
    const before = calls.length;
    const bad = await hive(["ctl", "view", "emit", "ci.build", "{nope", "--json"], { env: env() });
    expect([bad.code, (bad.json as { code: string }).code, calls.length]).toEqual([2, "USAGE", before]);
  });

  test("plugin: commands lists what runs; open says what it opened; call sends the JSON argument and prints the answer, or the plugin's error", async () => {
    expect((await hive(["ctl", "plugin", "open", "tool:a/b"], { env: env() })).stdout.trim()).toBe("opened tile t-9");
    expect((await hive(["ctl", "plugin", "open", "widget:@a/progress"], { env: env() })).stdout.trim()).toBe("added widget w-5");
    const list = await hive(["ctl", "plugin", "commands"], { env: env() });
    expect(list.stdout).toContain("@a/progress  (widget Progress, w1)");
    expect(list.stdout).toContain('add                Add a step.  args: { "text": string }');
    const ok = await hive(["ctl", "plugin", "call", "@a/progress", "add", '{"text":"milk"}', "--tile", "w1", "--json"], { env: env() });
    expect([ok.code, ok.json]).toEqual([0, { result: { echoed: { text: "milk" }, tile: "w1" } }]);
    expect(last("plugin.call").params).toEqual(["@a/progress", "add", { text: "milk" }, "w1"]);
    const failed = await hive(["ctl", "plugin", "call", "@a/progress", "check", '{"index":7}', "--json"], { env: env() });
    expect([failed.code === 0, (failed.json as { message: string }).message]).toEqual([false, "there is no step 7"]);
    const before = calls.length;
    const bad = await hive(["ctl", "plugin", "call", "@a/progress", "add", "{nope"], { env: env() });
    expect([bad.code === 0, bad.stderr.includes("must be JSON"), calls.length]).toEqual([false, true, before]);
  });

  test("plugin: list says each one's state and why one failed, and the views there are; close names the copy, and one not running exits 5", async () => {
    const list = await hive(["ctl", "plugin", "list"], { env: env() });
    expect(list.stdout.trim().split("\n")).toEqual([
      "w1  widget @a/progress (Progress)  ready  commands: add",
      "@a/valley  view @a/valley (Valley)  failed: it did not start in 15 s",
      "views: canvas (shown), @a/valley",
    ]);
    const closed = await hive(["ctl", "plugin", "close", "w1", "--plugin", "@a/progress", "--json"], { env: env() });
    expect([closed.code, closed.json, last("plugin.close").params]).toEqual([0, { closed: "w1", plugin: "@a/progress", kind: "widget" }, ["w1", "@a/progress"]]);
    const ghost = await hive(["ctl", "plugin", "close", "ghost", "--json"], { env: env() });
    expect([ghost.code, (ghost.json as { code: string }).code]).toEqual([5, "NOT_FOUND"]);
  });
});
