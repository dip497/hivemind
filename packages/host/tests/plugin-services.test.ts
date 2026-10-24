// A tool plugin's service over the drive socket (plugin-services.ts, design jira-sync §12.2-5,
// §12.7): it reads its own plugin's options and secret, never another plugin's; it creates an
// issue signed as itself; it serves commands, and `hive ctl plugin call` reaches it when no window
// runs the plugin (as under `hive host`); a change the person makes to its settings is told to it;
// a program that holds no service's grant is refused all of it; it keeps a secret of its own
// plugin's (a sign-in), never another's; and `node` it needs comes from the host's own runtime
// where the machine has none.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setCatalog } from "@hivemind/agents";
import { Intents } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { WorkspaceStore } from "@hivemind/workspace-host/store";
import { newSeed } from "@hivemind/workspace-host/identity";
import { WorkspaceServer } from "@hivemind/workspace-api/server";
import { ApiError } from "@hivemind/workspace-api/protocol";
import { WORKSPACE_FORMAT, readIssue, writeConfig } from "@hivemind/core/storage";
import { askDrive, serveDrive } from "../src/drive.ts";
import { Grants } from "../src/grants.ts";
import { Services, type WantedService } from "../src/services.ts";
import { PluginServices } from "../src/plugin-services.ts";
import { Secrets } from "../src/secrets.ts";
import { workspaceDomains } from "../src/domains.ts";
import { ControlPlane, type ControlPlaneOptions } from "../src/control/plane.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hm-plugin-services-")));
const repo = path.join(tmp, "ws");
const root = path.join(repo, ".hivemind");
fs.mkdirSync(path.join(root, "issues"), { recursive: true });
await writeConfig(root, { prefix: "TT", next_id: 1, agents: {}, format: WORKSPACE_FORMAT });
const sock = path.join(tmp, "drive.sock");
const grants = new Grants(path.join(tmp, "grants.json"));
const secrets = new Secrets(path.join(tmp, "secrets.json"));
/** What the person set each plugin to. */
const values: Record<string, Record<string, string | number | boolean>> = { "@acme/ci": { site: "acme.example", every: 5 } };
const plugins = new PluginServices({
  pluginOfGrant: (id) => grants.list().find((g) => g.id === id)?.plugin,
  options: async (plugin) => ({ values: values[plugin] ?? {}, secrets: secrets.names(`tool:${plugin}`) }),
  secret: (plugin, name) => secrets.get(`tool:${plugin}`, name),
  setSecret: (key, name, value) => secrets.set(key, name, value),
  secretFields: async (plugin) => (plugin === "@acme/ci" ? ["token", "session"] : ["token"]),
});
const server = new WorkspaceServer([...workspaceDomains(), plugins.domain()], new Intents(new AuditLog({ file: path.join(tmp, "audit.jsonl") })));
const drive = serveDrive(sock, { server, installToken: () => "install-token", grants, repos: () => [repo], workspaceOf: () => null, nameOf: (t) => t });

// The service: asks its options and its secret, makes an issue, serves `echo`, and logs each as a
// JSON line.
const dir = fs.mkdirSync(path.join(tmp, "tools", "acme--ci"), { recursive: true })!;
fs.writeFileSync(path.join(dir, "service.js"), `
const net = require("node:net");
process.stdin.on("end", () => process.exit(0)).resume();
const say = (m) => console.log(JSON.stringify(m));
const c = net.connect(process.env.HIVE_DRIVE_SOCK, () => send({ hello: { token: process.env.HIVE_DRIVE_TOKEN } }));
const send = (m) => c.write(JSON.stringify(m) + "\\n");
let id = 0; const waiting = new Map();
const call = (method, ...params) => new Promise((r) => { const i = ++id; waiting.set(i, r); send({ id: i, method, params }); });
let buf = "";
c.on("data", (d) => {
  buf += d;
  for (let i; (i = buf.indexOf("\\n")) >= 0; ) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.hello) void run(m.hello.as.workspace);
    else if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    else if (m.event === "plugin.called") {
      const { call: n, command, args } = m.params[0];
      send({ method: "plugin.answer", params: [n, args && args.fail ? { error: { code: "BAD_REQUEST", message: "asked to fail" } } : { result: { echo: args, runtime: process.env.ELECTRON_RUN_AS_NODE || null } }] });
    } else if (m.event === "options.changed") say({ changed: m.params[0] });
  }
});
async function run(workspace) {
  say({ options: (await call("plugin.options")).result });
  say({ secret: (await call("secret.get", "token")).result });
  const made = await call("issue.create", workspace + "/.hivemind", { title: "from the service" });
  say({ issue: made.result ? made.result.id : made.error });
  const set = async (...p) => { const r = await call("secret.set", ...p); return r.error ? r.error.code : r.result; };
  say({ sets: [await set("tool:@acme/ci", "session", "signed-in"), await set("tool:@acme/other", "token", "mine-now"), await set("tool:@acme/ci", "undeclared", "x"), await set("tool:@acme/ci", "session", null), await set("tool:@acme/ci", "session", "again")] });
  send({ method: "plugin.serve", params: [[{ name: "echo", description: "answers what it is given" }]] });
  say({ serving: true });
}
`);
const services = new Services({ driveSock: sock, grants, logDir: path.join(tmp, "services") });
after(async () => {
  await services.stop();
  drive.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ci = (o: Partial<WantedService> = {}): WantedService => ({
  plugin: "@acme/ci", name: "CI", dir, service: { command: ["node", "./service.js"], role: "edit" }, workspaces: [repo], ...o,
});
/** What the service logged, one JSON object a line. */
const said = (): Array<Record<string, unknown>> => services.log("@acme/ci").split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown>);
async function until(what: string, ok: () => boolean, ms = 8_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`${what} did not happen; log:\n${services.log("@acme/ci")}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const codeOf = (p: Promise<unknown>) => p.then(() => "answered", (e: ApiError) => e.code);

test("a service reads its own options and secret, never another plugin's, and writes an issue signed as itself", async () => {
  await drive.serving;
  secrets.set("tool:@acme/ci", "token", "ci-token");
  secrets.set("tool:@acme/other", "token", "someone-elses");
  await services.sync([ci()]);
  await until("it serves", () => said().some((m) => m.serving));
  const log = said();
  assert.deepEqual(log.find((m) => m.options)?.options, { values: { site: "acme.example", every: 5 }, secrets: ["token"] });
  assert.equal(log.find((m) => "secret" in m)?.secret, "ci-token");
  const id = log.find((m) => m.issue)?.issue;
  assert.equal(typeof id, "string", JSON.stringify(log));
  const issue = await readIssue(root, id as string);
  assert.deepEqual(issue.sections.activity.map((a) => [a.who, a.message]), [["@acme/ci (service)", "created"]]);
  assert.ok(!services.log("@acme/ci").includes("someone-elses"));
});

test("a service keeps a declared secret of its own plugin, signed as itself; never another plugin's, nor one its plugin does not declare", async () => {
  const sets = said().find((m) => m.sets)?.sets;
  assert.deepEqual(sets, [{ kept: "file" }, "FORBIDDEN", "FORBIDDEN", { kept: null }, { kept: "file" }]);
  assert.equal(secrets.get("tool:@acme/ci", "session"), "again");
  assert.equal(secrets.get("tool:@acme/other", "token"), "someone-elses");
  assert.equal(secrets.get("tool:@acme/ci", "undeclared"), null);
  const service = grants.list().find((g) => g.plugin === "@acme/ci")!;
  const audit = fs.readFileSync(path.join(tmp, "audit.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { verb: string; target?: string; outcome: string; actor: { person?: string } });
  const kept = audit.filter((r) => r.verb === "secret.set" && r.target === "tool:@acme/ci.session");
  assert.deepEqual(kept.map((r) => [r.actor.person, r.outcome]), [[`client:${service.id}`, "ok"], [`client:${service.id}`, "ok"], [`client:${service.id}`, "ok"]]);
  assert.ok(!fs.readFileSync(path.join(tmp, "audit.jsonl"), "utf8").includes("signed-in"), "the value is never recorded");
});

test("a change to its settings is told to it; a change to another plugin's is not", async () => {
  const before = said().filter((m) => m.changed).length;
  values["@acme/other"] = { x: true };
  await plugins.settingsChanged();
  values["@acme/ci"] = { site: "acme.example", every: 10 };
  await plugins.settingsChanged();
  await until("it was told", () => said().filter((m) => m.changed).length > before);
  assert.deepEqual(said().filter((m) => m.changed).slice(before).map((m) => m.changed), [{ values: { site: "acme.example", every: 10 }, secrets: ["session", "token"] }]);
});

test("`plugin call` with no window reaches the service, as under `hive host`; what it answers, or why it failed, comes back", async () => {
  const dir2 = fs.mkdtempSync(path.join(tmp, "plane-"));
  setCatalog([]);
  const plane = new ControlPlane({
    dir: () => dir2,
    publish: () => {},
    spawned: () => {},
    windowsUp: () => false,
    methods: () => ({
      workspaces: new WorkspaceStore({ dir: dir2, person: newSeed() }),
      shownWorkspace: () => null,
      launchOptions: () => ({}),
      sessionHeld: () => false,
      intents: new Intents(new AuditLog({ file: path.join(dir2, "audit.jsonl") })),
      callRenderer: () => Promise.reject(new ApiError("UNAVAILABLE", "there is no window here: hive host runs none")),
      reloadSettings: async () => ({}),
      services: plugins,
    }),
  } as unknown as ControlPlaneOptions);
  const api = await plane.api();
  assert.deepEqual(await api.pluginCall("@acme/ci", "echo", { n: 1 }, undefined), { result: { echo: { n: 1 }, runtime: null } });
  assert.equal(await codeOf(api.pluginCall("@acme/ci", "echo", { fail: true }, undefined)), "BAD_REQUEST");
  // A command it does not serve, or a plugin with no service: the window's answer stands.
  assert.equal(await codeOf(api.pluginCall("@acme/ci", "other", null, undefined)), "UNAVAILABLE");
  assert.equal(await codeOf(api.pluginCall("@acme/none", "echo", null, undefined)), "UNAVAILABLE");
  const listed = await api.pluginCommands() as { plugins: Array<{ plugin: string; kind: string; commands: Array<{ name: string }> }> };
  assert.deepEqual(listed.plugins.map((p) => [p.plugin, p.kind, p.commands.map((c) => c.name)]), [["@acme/ci", "service", ["echo"]]]);
});

test("a tool's own tile reaches its service directly (host.call): its answer, its error, and why there is none", async () => {
  assert.deepEqual(await plugins.tileCall("@acme/ci", "echo", { n: 2 }), { echo: { n: 2 }, runtime: null });
  assert.deepEqual(await plugins.tileCall("@acme/ci", "echo", undefined), { echo: null, runtime: null });
  assert.equal(await codeOf(plugins.tileCall("@acme/ci", "echo", { fail: true })), "BAD_REQUEST");
  const why = (p: Promise<unknown>) => p.then(() => "answered", (e: ApiError) => `${e.code}: ${e.message}`);
  assert.equal(await why(plugins.tileCall("@acme/ci", "other", null)), `UNAVAILABLE: @acme/ci's service has no command "other"`);
  assert.match(await why(plugins.tileCall("@acme/none", "echo", null)), /^UNAVAILABLE: @acme\/none's service is not running/);
  // Only a command's name reaches the service.
  assert.equal(await codeOf(plugins.tileCall("@acme/ci", "Echo", null)), "BAD_REQUEST");
  assert.equal(await codeOf(plugins.tileCall("", "echo", null)), "BAD_REQUEST");
});

test("a program holding no service's grant, and the person, are refused a service's methods; a program sets no secret, the person any", async () => {
  const program = grants.create({ name: "a program", repos: [repo], role: "edit" });
  for (const [method, ...params] of [["plugin.options"], ["secret.get", "token"]] as const) {
    assert.equal(await codeOf(askDrive(sock, program.token, method, [...params])), "FORBIDDEN", `${method} by a program`);
    assert.equal(await codeOf(askDrive(sock, "install-token", method, [...params])), "FORBIDDEN", `${method} by the person`);
  }
  const service = grants.list().find((g) => g.plugin === "@acme/ci")!;
  assert.ok(service, "the service runs");
  assert.equal(await codeOf(askDrive(sock, program.token, "secret.set", ["tool:@acme/ci", "token", "x"])), "FORBIDDEN");
  assert.deepEqual(await askDrive(sock, "install-token", "secret.set", ["tool:@acme/ci", "token", "new-token"]), { kept: "file" });
  assert.equal(secrets.get("tool:@acme/ci", "token"), "new-token");
  assert.equal((fs.statSync(path.join(tmp, "secrets.json")).mode & 0o777).toString(8), "600", "the secrets file is the person's alone");
  grants.revoke(program.grant.id);
});

test("a service whose `node` the machine lacks runs on the host's own runtime; without one, it says how to get node", async () => {
  await services.sync([]);
  const bin = fs.mkdtempSync(path.join(tmp, "bin-"));
  const path0 = process.env.PATH;
  process.env.PATH = bin; // a machine with no node
  try {
    const own = new Services({ driveSock: sock, grants, logDir: path.join(tmp, "services"), node: { file: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } } });
    await own.sync([ci()]);
    const before = said().filter((m) => m.serving).length;
    await until("it serves on the host's runtime", () => said().filter((m) => m.serving).length > before);
    assert.deepEqual(await plugins.call("@acme/ci", "echo", null), { echo: null, runtime: "1" });
    await own.stop();

    const none = new Services({ driveSock: sock, grants, logDir: path.join(tmp, "services") });
    await none.sync([ci()]);
    const s = none.states().find((x) => x.plugin === "@acme/ci");
    assert.deepEqual([s?.state, s?.why], ["stopped", "node is not installed on this machine: install Node.js (https://nodejs.org), or run the service in the app, which brings its own"]);
    await none.stop();
  } finally {
    process.env.PATH = path0;
  }
});
