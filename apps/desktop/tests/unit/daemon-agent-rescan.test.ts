// The daemon loads the agent catalog once at boot but outlives installs: an agent
// installed into a temp XDG AFTER that load must still be wired (its manifest's launch
// env applied) on the NEXT spawn. Drives the real daemon over its socket.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { frame, makeLineDecoder, type ClientMsg, type ServerMsg } from "../../src/main/pty-protocol.ts";

const unix = process.platform !== "win32";
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = unix ? fs.mkdtempSync("/tmp/hrescan-") : "";
const xdg = path.join(dir, "xdg");
const bin = path.join(dir, "bin");
const sock = path.join(dir, "d.sock");
const PROBE_ID = "probe";
const cli = path.join(bin, "probe-cli");
const manifest = `manifestVersion: 1
id: ${PROBE_ID}
label: "Probe"
bin: probe-cli
enabled: true
caps:
  promptDelivery: typed
  turnSignal: false
  resume: none
  supervise: human
  blockedDetection: false
launch:
  env:
    HM_PROBE_ID: "{agentId}"
`;
let daemon: ChildProcess | undefined;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  if (!unix) return;
  fs.mkdirSync(bin);
  // The script prints what the manifest's launch.env injected, so the output IS the proof.
  fs.writeFileSync(cli, "#!/bin/sh\necho PROBE=$HM_PROBE_ID\nsleep 30\n", { mode: 0o755 });
  daemon = spawn(process.execPath, ["--import", "tsx", path.join(here, "../../src/main/pty-daemon.ts"), sock], {
    stdio: "ignore",
    env: { ...process.env, XDG_CONFIG_HOME: xdg },
  });
  for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await wait(100);
});
after(() => { daemon?.kill("SIGKILL"); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

function client() {
  const s = net.connect(sock);
  const msgs: ServerMsg[] = [];
  s.on("data", makeLineDecoder((l) => msgs.push(JSON.parse(l) as ServerMsg)));
  const send = (m: ClientMsg) => s.write(frame(m));
  // Output that arrives before the attach promise settles rides the replay instead of
  // data frames — count both, or the assertion becomes a race the daemon always wins.
  const text = (id: string) =>
    msgs.filter((m): m is Extract<ServerMsg, { t: "attached" }> => m.t === "attached" && m.id === id).map((m) => m.replay).join("")
    + msgs.filter((m): m is Extract<ServerMsg, { t: "data" }> => m.t === "data" && m.id === id).map((m) => m.data).join("");
  const until = async <T extends ServerMsg>(f: (m: ServerMsg) => m is T, ms = 20000): Promise<T> => {
    for (let t = 0; t < ms; t += 20) { const m = msgs.find(f); if (m) return m; await wait(20); }
    throw new Error("timed out");
  };
  const spawnTile = async (id: string) => {
    send({ t: "attach", reqId: id, id, spec: { cwd: dir, cmd: cli, args: [], cols: 80, rows: 24 } });
    return until((m): m is Extract<ServerMsg, { t: "attached" }> => m.t === "attached" && m.id === id);
  };
  return { s, send, text, until, spawnTile };
}

test("an agent installed after the daemon's first load is wired on the next spawn", { skip: !unix, timeout: 60000 }, async () => {
  const a = client();
  const at = await a.spawnTile("pre");
  assert.equal(at.isNew, true);
  // No catalog entry yet, so the manifest env is absent — the injection below comes from
  // the rescan, not from anything the script or daemon does unconditionally.
  for (let t = 0; t < 10000 && !a.text("pre").includes("PROBE="); t += 20) await wait(20);
  assert.ok(!a.text("pre").includes("PROBE=probe"), "no injection before the install");
  a.send({ t: "kill", id: "pre" });

  // Install into the temp XDG the daemon was pointed at: it must pick this up without a restart.
  fs.mkdirSync(path.join(xdg, "hivemind", "agents", PROBE_ID), { recursive: true });
  fs.writeFileSync(path.join(xdg, "hivemind", "agents", PROBE_ID, "agent.yaml"), manifest);

  const b = client();
  await b.spawnTile("post");
  for (let t = 0; t < 20000 && !b.text("post").includes("PROBE=probe"); t += 20) await wait(20);
  assert.ok(b.text("post").includes("PROBE=probe"), "the installed agent's launch env applied");
  b.send({ t: "kill", id: "post" });
  a.s.destroy();
  b.s.destroy();
});
