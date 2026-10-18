// A tool plugin's service (D8): it drives the workspaces picked for it through the drive socket as
// a grant of its own, with none of the app's tokens; switched off, it stops and its grant is taken
// back; a failing exit starts it again, a clean one does not; its grant taken back elsewhere keeps
// it stopped; and it does not start without a workspace, a role there is, or its program.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Intents } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { WorkspaceServer, type Domain } from "@hivemind/workspace-api/server";
import { serveDrive } from "../src/drive.ts";
import { Grants } from "../src/grants.ts";
import { Services, type WantedService } from "../src/services.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hm-services-")));
const repoA = fs.mkdirSync(path.join(tmp, "a"), { recursive: true })!;
const repoB = fs.mkdirSync(path.join(tmp, "b"), { recursive: true })!;
const sock = path.join(tmp, "drive.sock");
const grants = new Grants(path.join(tmp, "grants.json"));
const domain = {
  answers: { "agent.start": (from: { actor: unknown }) => ({ by: from.actor }) },
  effects: {},
} as unknown as Domain<never>;
const server = new WorkspaceServer([domain], new Intents(new AuditLog({ file: path.join(tmp, "audit.jsonl") })));
const drive = serveDrive(sock, {
  server, installToken: () => "install-token", grants, repos: () => [repoA, repoB], workspaceOf: () => null, nameOf: (t) => t,
});

// The plugin: a service that says who it drives as, what the app left in its environment, and
// does what `mode` in its folder says: stay, fail, or finish.
const dir = fs.mkdirSync(path.join(tmp, "tools", "acme--ci"), { recursive: true })!;
fs.writeFileSync(path.join(dir, "service.js"), `#!/usr/bin/env node
const net = require("node:net"), fs = require("node:fs");
const mode = fs.readFileSync(__dirname + "/mode", "utf8").trim();
console.log("env " + ["HCP_TOKEN", "HIVEMIND_TILE", "SECRET"].filter((k) => k in process.env).join(",") + " workspaces " + process.env.HIVE_WORKSPACES);
if (mode === "fail") process.exit(3);
if (mode === "finish") process.exit(0);
process.stdin.on("end", () => process.exit(0)).resume();
const c = net.connect(process.env.HIVE_DRIVE_SOCK, () => c.write(JSON.stringify({ hello: { token: process.env.HIVE_DRIVE_TOKEN } }) + "\\n"));
let buf = "";
c.on("data", (d) => {
  buf += d;
  for (let i; (i = buf.indexOf("\\n")) >= 0; ) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.hello) { console.log("as " + JSON.stringify(m.hello.as)); c.write(JSON.stringify({ id: 1, method: "agent.start", params: [] }) + "\\n"); }
    else if (m.id === 1) console.log("started by " + JSON.stringify(m.result.by));
  }
});
`, { mode: 0o755 });
const mode = (m: "stay" | "fail" | "finish") => {
  fs.writeFileSync(path.join(dir, "mode.next"), m);
  fs.renameSync(path.join(dir, "mode.next"), path.join(dir, "mode"));
};

// This process was started from an agent's tile: its token and anything else of its own stay out.
const own = { HCP_TOKEN: process.env.HCP_TOKEN, HIVEMIND_TILE: process.env.HIVEMIND_TILE, SECRET: process.env.SECRET };
Object.assign(process.env, { HCP_TOKEN: "agent-token", HIVEMIND_TILE: "hm:t1", SECRET: "x" });
const services = new Services({ driveSock: sock, grants, logDir: path.join(tmp, "services") });
after(async () => {
  await services.stop();
  drive.close();
  for (const [k, v] of Object.entries(own)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ci = (o: Partial<WantedService> = {}): WantedService => ({
  plugin: "acme/ci", name: "CI", dir, service: { command: ["node", "./service.js"], role: "agents" }, workspaces: [repoA], ...o,
});
const fileService = { command: ["./service.js"], role: "agents" };
const state = () => services.states().find((s) => s.plugin === "acme/ci");
const ours = () => grants.list().filter((g) => g.plugin === "acme/ci");
async function until(what: string, ok: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`${what} did not happen; log:\n${services.log("acme/ci")}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const startedPids = () => [...services.log("acme/ci").matchAll(/started, pid (\d+)/g)].map((m) => Number(m[1]));

test("a service drives the workspace picked for it as a grant of its own, with none of the app's tokens", async () => {
  await drive.serving;
  mode("stay");
  await services.sync([ci({ service: { command: ["node", "service.js"], role: "agents" } })]);
  await until("the service's first call", () => services.log("acme/ci").includes("started by"));
  const log = services.log("acme/ci");
  assert.match(log, new RegExp(`env  workspaces ${repoA}\\n`), "nothing of the app's environment but where and who");
  assert.ok(log.includes(`as ${JSON.stringify({ client: "CI service", role: "agents", workspace: repoA })}\n`), "it is its grant, named for its plugin, in its workspace");
  const [grant] = ours();
  assert.ok(grant, "its grant is listed, marked with its plugin");
  assert.deepEqual([grant.name, grant.role, grant.repos], ["CI service", "agents", [repoA]]);
  assert.match(log, new RegExp(`started by \\{"kind":"peer","person":"client:${grant.id}"`));
  assert.equal(state()?.state, "running");
});

test("switched off, it stops and its grant is taken back", async () => {
  const [pid] = startedPids().slice(-1);
  await services.sync([]);
  assert.equal(state(), undefined);
  assert.deepEqual(ours(), []);
  await until("the process ending", () => !alive(pid!));
});

test("picking other workspaces starts it again, with a grant that reaches them", async () => {
  mode("stay");
  await services.sync([ci()]);
  await until("the first run", () => ours().length === 1 && state()?.state === "running");
  const first = ours()[0]!.id;
  await services.sync([ci({ workspaces: [repoA, repoB] })]);
  await until("the second run", () => state()?.state === "running" && ours()[0]?.id !== first);
  assert.deepEqual(ours().map((g) => g.repos), [[repoA, repoB]], "one grant, the new one");
  await until("it told of both", () => services.log("acme/ci").includes(`workspaces ${repoA}${path.delimiter}${repoB}\n`));
  await services.sync([]);
});

test("a failing exit starts it again a second later; a clean one stops it", async () => {
  mode("fail");
  const before = startedPids().length;
  await services.sync([ci({ service: fileService })]);
  await until("a restart scheduled", () => state()?.state === "restarting");
  const s = state()!;
  assert.equal(s.why, "it exited (3)");
  assert.ok(s.restartAt! - s.since >= 900 && s.restartAt! - s.since <= 1_100, `again in about a second, not ${s.restartAt! - s.since} ms`);
  assert.deepEqual(ours(), [], "a run that ended holds no grant");
  await until("the second start", () => startedPids().length >= before + 2, 3_000);
  mode("finish");
  await until("the clean exit", () => state()?.state === "stopped", 5_000);
  assert.equal(state()?.why, "it exited");
  const runs = startedPids().length;
  await new Promise((r) => setTimeout(r, 1_500));
  assert.equal(startedPids().length, runs, "not started again");
  await services.sync([]);
});

test("its log folder gone while it runs, it is still started again, and its log goes on", async () => {
  mode("fail");
  await services.sync([ci({ service: fileService })]);
  await until("a restart scheduled", () => state()?.state === "restarting");
  fs.rmSync(path.join(tmp, "services"), { recursive: true, force: true });
  await until("the next start", () => state()?.state !== "restarting", 3_000);
  await until("its log written again", () => startedPids().length >= 1, 3_000);
  mode("stay");
  await services.sync([]);
});

test("its grant taken back elsewhere stops it, and it stays stopped", async () => {
  mode("stay");
  await services.sync([ci()]);
  await until("running", () => state()?.state === "running" && ours().length === 1);
  const [pid] = startedPids().slice(-1);
  grants.revoke(ours()[0]!.id);
  assert.deepEqual([state()?.state, state()?.why], ["stopped", "its grant was taken back"]);
  await until("the process ending", () => !alive(pid!));
  await new Promise((r) => setTimeout(r, 1_500));
  assert.deepEqual([state()?.state, ours()], ["stopped", []], "not started again, with no grant");
  await services.sync([]);
});

test("it does not start without a workspace, a role there is, or its program", async () => {
  mode("stay");
  for (const [want, why] of [
    [ci({ workspaces: [] }), "no workspace is picked for it"],
    [ci({ service: { command: ["node", "service.js"], role: "owner" } }), 'it asks for the role "owner", which is none of view, edit, terminals, agents'],
    [ci({ service: { command: ["./missing.js"], role: "agents" } }), "./missing.js is not in the plugin's folder"],
    [ci({ service: { command: ["no-such-program-hm"], role: "agents" } }), "no-such-program-hm is not installed on this machine"],
  ] as const) {
    await services.sync([want]);
    assert.deepEqual([state()?.state, state()?.why], ["stopped", why]);
    assert.deepEqual(ours(), [], `${why}: no grant`);
    await services.sync([]);
  }
});

test("a service's grant left behind by an app that was killed is taken back when services begin again, its plugin on or not", async () => {
  const stale = grants.create({ name: "Old service", repos: [repoA], role: "agents" }, "acme/switched-off");
  const program = grants.create({ name: "a program", repos: [repoA], role: "agents" });
  const again = new Services({ driveSock: sock, grants, logDir: path.join(tmp, "services") });
  assert.deepEqual([grants.holder(stale.token), grants.holder(program.token)?.name], [null, "a program"]);
  await again.stop();
});
