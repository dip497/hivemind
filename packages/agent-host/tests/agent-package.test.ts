// A machine with only `hive` on it (one added over ssh, a `hive host`) has no agents installed. An
// agent started there by a machine that has it runs as it would at home: the start carries the
// agent, the machine installs it, and the agent's hooks report its turn to everyone watching.
// An agent the machine has already is its own: a start never replaces it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { setCatalog } from "@hivemind/agents";
import { loadAgents } from "@hivemind/agents/load";
import { DaemonEndpoint } from "../src/daemon-endpoint.ts";

const unix = process.platform !== "win32";
const DAEMON = path.join(import.meta.dir, "../src/pty-daemon.ts");
const FAKE = path.join(import.meta.dir, "../../../apps/desktop/tests/e2e/fixtures/fake-agent.cjs");
const CLAUDE = path.join(import.meta.dir, "../../hive-agents/tests/fixtures/published-agents/claude");
const dir = fs.mkdtempSync("/tmp/hap-");
const sock = path.join(dir, "d.sock");
/** The machine's own agents folder: empty, as `hive` alone leaves it. */
const machineAgents = path.join(dir, "machine", "hivemind", "agents");
let daemon: ChildProcess | undefined;
const events: Array<{ topic: string; data: { tileId?: string; status?: { state: string; source: string } } }> = [];
let screen = "";
let ep: DaemonEndpoint;

beforeAll(async () => {
  if (!unix) return;
  // The machine that starts it has claude installed.
  const home = path.join(dir, "home");
  fs.cpSync(CLAUDE, path.join(home, "hivemind", "agents", "claude"), { recursive: true });
  const was = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = home;
  setCatalog((await loadAgents()).defs);
  process.env.XDG_CONFIG_HOME = was;
  // The machine it starts on has the program, but no agents.
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} claude "$@"\n`, { mode: 0o755 });
  daemon = spawn(process.execPath, [DAEMON, sock], { stdio: "ignore", env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: path.join(dir, "machine"), PATH: `${bin}:${process.env.PATH}` } });
  for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 100));
  ep = new DaemonEndpoint({
    connect: () => new Promise((res, rej) => { const s = net.connect(sock); s.once("connect", () => res(s)); s.once("error", rej); }),
    onEvent: (topic, data) => { events.push({ topic, data: data as never }); },
  });
});
afterAll(() => {
  ep?.close();
  daemon?.kill("SIGKILL");
  fs.rmSync(dir, { recursive: true, force: true });
});

const statusOf = (tile: string) => events.filter((e) => e.topic === "agent.status" && e.data.tileId === tile).map((e) => `${e.data.status!.state}/${e.data.status!.source}`);

test.skipIf(!unix)("an agent started on a machine without it is installed there, and its hooks report its turn", async () => {
  await ep.spawn({ tileId: "hm:t-there", cwd: dir, cmd: "claude", args: ["echo counted"], cols: 100, rows: 30 }, { onData: (d) => { screen += d; }, onExit: () => {} });
  for (let i = 0; i < 200 && !statusOf("hm:t-there").includes("done/hooks"); i++) await new Promise((r) => setTimeout(r, 50));
  expect(screen).toContain("fake claude up (tile hm:t-there, hooks: ");
  expect(statusOf("hm:t-there")).toContain("done/hooks");
  expect(fs.existsSync(path.join(machineAgents, "claude", "agent.yaml"))).toBe(true);
}, 30_000);

test.skipIf(!unix)("an agent the machine has already is not replaced by the one a start carries", async () => {
  const own = path.join(machineAgents, "claude", "agent.yaml");
  const mine = `${fs.readFileSync(own, "utf8")}\n# the machine's own\n`;
  fs.writeFileSync(own, mine);
  await ep.spawn({ tileId: "hm:t-again", cwd: dir, cmd: "claude", args: ["echo again"], cols: 100, rows: 30 }, { onData: () => {}, onExit: () => {} });
  for (let i = 0; i < 200 && !statusOf("hm:t-again").includes("done/hooks"); i++) await new Promise((r) => setTimeout(r, 50));
  expect(fs.readFileSync(own, "utf8")).toBe(mine);
}, 30_000);
