// A program on the drive socket supervises the agents it starts: a supervised worker's tool use
// waits in the agent list with what it would do, the program's answer reaches the worker's own
// hook, and what the worker reports comes to the program as an event. The agent is the scripted
// stand-in (fixtures/fake-agent.cjs) behind the real claude wiring: --settings hooks, the
// supervise broker, `hive ctl report`.
import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedAgents } from "./helpers/agents";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, "../..");
const CLI = path.resolve(APP_DIR, "../cli/src/index.ts");
const FIXTURE = path.join(__dirname, "fixtures", "fake-agent.cjs");

let root: string;
let app: ElectronApplication | undefined;
test.beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hm-drive-sup-"))); });
/** This spec's own pty daemon: it outlives the window, and is found by the profile it serves. */
function ownDaemons(): number[] {
  return fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d)).filter((pid) => {
    try { const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"); return cmd.includes("pty-daemon") && cmd.includes(root); } catch { return false; }
  }).map(Number);
}
test.afterEach(async () => {
  // The app closes while its daemon lives on, as when the person quits; then the daemon goes.
  await app?.close();
  app = undefined;
  for (const pid of ownDaemons()) try { process.kill(pid); } catch { /* gone */ }
  fs.rmSync(root, { recursive: true, force: true });
});

function onPath(bin: string): string {
  for (const d of (process.env.PATH ?? "").split(":")) {
    const p = path.join(d, bin);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  throw new Error(`${bin} not on PATH`);
}

/** A program on the drive socket: what it is told, line by line, and a way to call. */
function program(sock: string, hello: object) {
  const socket = net.connect(sock);
  socket.setEncoding("utf8");
  const heard: Array<Record<string, unknown>> = [];
  let buf = "";
  socket.on("data", (chunk: string) => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop()!;
    for (const l of lines) {
      const m = JSON.parse(l) as Record<string, unknown> | Array<Record<string, unknown>>;
      heard.push(...(Array.isArray(m) ? m : [m]));
    }
  });
  socket.write(`${JSON.stringify({ hello })}\n`);
  let id = 0;
  const call = async (method: string, params: unknown[]) => {
    const mine = ++id;
    socket.write(`${JSON.stringify({ id: mine, method, params })}\n`);
    await expect.poll(() => heard.some((m) => m.id === mine)).toBe(true);
    const answer = heard.find((m) => m.id === mine)!;
    expect(answer.error, `${method}`).toBeUndefined();
    return answer.result as never;
  };
  return { socket, heard, call };
}

test("a program supervises the agents it starts: their tool uses wait on its answer, and their reports come to it", async () => {
  test.setTimeout(120_000);
  const repo = path.join(root, "api");
  execFileSync("git", ["init", "-q", repo]);
  const config = path.join(root, "config");
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const toolLog = path.join(root, "tools.log");
  for (const d of [config, home, bin]) fs.mkdirSync(d, { recursive: true });
  seedAgents(config);
  fs.writeFileSync(path.join(bin, "claude"), `#!/usr/bin/env bash\nFAKE_TOOL_LOG=${JSON.stringify(toolLog)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)} claude "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "hive"), `#!/usr/bin/env bash\nexec ${JSON.stringify(onPath("bun"))} ${JSON.stringify(CLI)} "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, XDG_CONFIG_HOME: config, HOME: home, PATH: `${bin}:${process.env.PATH}`, HIVEMIND_SHELL_ENV: "0", HIVEMIND_PTY_DAEMON: "1" } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(APP_DIR, "out/main/index.js"), "--no-sandbox"], cwd: repo, env });
  const page = await app.firstWindow();
  await page.waitForSelector(".react-flow");

  const userData = path.join(config, "hivemind-dev");
  const sock = path.join(userData, "drive.sock");
  await expect.poll(() => fs.existsSync(sock)).toBe(true);
  const person = program(sock, { token: fs.readFileSync(path.join(userData, "hcp.token"), "utf8").trim() });
  const { grant, token } = await person.call("grant.create", [{ name: "orchestrator", repos: [repo], role: "agents" }]) as { grant: { id: string }; token: string };
  person.socket.destroy();
  const p = program(sock, { token, workspace: repo });

  // A supervised worker's tool use waits, in the list, on its starter.
  const { tile } = await p.call("agent.start", [repo, { program: "claude", supervise: true, prompt: 'TOOL Bash {"command":"rm -rf dist"}' }]) as { tile: string };
  type Item = { tile: string; parent?: string; waiting?: { kind: string; since: number; approval?: { tool: string; summary: string; expiresAt: number } } };
  let waiting: Item | undefined;
  await expect.poll(async () => {
    const { agents } = await p.call("agent.list", [repo]) as { agents: Item[] };
    waiting = agents.find((a) => a.tile === tile && a.waiting?.kind === "approval");
    return !!waiting;
  }, { timeout: 60_000 }).toBe(true);
  expect(waiting!.parent).toBe(`client:${grant.id}`);
  expect(waiting!.waiting!.approval).toMatchObject({ tool: "Bash", summary: "rm -rf dist" });

  // Its answer is the one the worker's hook gets.
  expect(await p.call("agent.answer", [tile, waiting!.waiting!.since, { decision: "deny" }])).toEqual({ answered: true });
  await expect.poll(() => (fs.existsSync(toolLog) ? fs.readFileSync(toolLog, "utf8") : ""), { timeout: 30_000 }).toMatch(/^Bash .*"permissionDecision":"deny"/m);

  // What a worker it started reports comes to it as an event.
  const reporter = await p.call("agent.start", [repo, { program: "claude", prompt: 'hive ctl report "done: 3 files"' }]) as { tile: string };
  await expect.poll(() => p.heard.some((m) => m.event === "agent.event" && (m.params as Array<{ kind?: string; tile?: string; detail?: string }>)[1]?.kind === "reported"
    && (m.params as Array<{ tile?: string }>)[1]?.tile === reporter.tile), { timeout: 60_000 }).toBe(true);
  const report = p.heard.find((m) => m.event === "agent.event" && (m.params as Array<{ kind?: string }>)[1]?.kind === "reported")!;
  expect((report.params as Array<{ detail?: string }>)[1]!.detail).toBe("done: 3 files");
  p.socket.destroy();
});
