// `hive ctl` on a machine with no desktop (M3 step 4b): `hive host` serves the control plane, the
// machine's PTY daemon passing its control-plane socket on to it. An agent spawned there runs with
// no window: the host starts its session in the workspace's folder, types its first task once it
// has settled (a stand-in `droid`, which takes none on its command line), records its output and
// hears its turns through the daemon; a follow-up gets its reply, its title names it, a startup
// screen its launch flags answered is skipped, a read waiting on a worker that is closed is told at
// once, and a verb that needs a window is refused. The daemon still hears what the agents report,
// for the devices watching it. Stopped, the host gives the socket back to the daemon.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { cmd, hive, hiveAsync } from "./helpers.js";

setDefaultTimeout(150_000);
const unix = process.platform !== "win32";
// sun_path is ~108 bytes; os.tmpdir() can be deep, /tmp is not.
const dir = unix ? fs.mkdtempSync("/tmp/hive-ctl-host-") : "";
const config = path.join(dir, "config");
/** The app's data folder where it is on Linux, the daemon's socket and the control plane's in it. */
const data = path.join(config, "hivemind");
const bin = path.join(dir, "bin");
const FAKE_AGENT = path.resolve(import.meta.dir, "../../desktop/tests/e2e/fixtures/fake-agent.cjs");
const DROID = path.resolve(import.meta.dir, "../../../packages/hive-agents/tests/fixtures/published-agents/droid");
// Nothing from a tile this test may itself run in: its own socket, token and tile are not these.
const env = {
  XDG_CONFIG_HOME: config, HIVEMIND_APP_DATA: data, HIVEMIND_SHELL_ENV: "0", HIVEMIND_HIVE_NET: path.join(dir, "none"),
  PATH: `${bin}:${process.env.PATH}`, HIVE_HCP_SOCK: "", HCP_TOKEN: "", HIVEMIND_TILE: "", HIVEMIND_PTY_SOCK: "",
};
const running: ChildProcess[] = [];

async function until<T>(get: () => T | null | undefined | false, what: string, ms = 30_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) {
    const v = get();
    if (v) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}
const ctl = (...args: string[]) => hive(["ctl", ...args, "--json"], { env });
interface Listed { tileId: string; name?: string; status?: string | null; agent?: string }
const listed = (): Listed[] => {
  const r = ctl("list").json as { frames?: Array<{ tiles: Listed[] }>; loose?: Listed[] };
  return [...(r.frames ?? []).flatMap((f) => f.tiles), ...(r.loose ?? [])];
};
/** The processes running for a tile: an agent and what it starts carry the tile's id. */
const processesOf = (tileId: string): string[] => fs.readdirSync("/proc").filter((pid) => {
  if (!/^\d+$/.test(pid)) return false;
  try { return fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`HIVEMIND_TILE=hm:${tileId}`); } catch { return false; }
});

afterAll(() => {
  for (const c of running) c.kill("SIGKILL");
  if (unix) hive(["daemon", "stop"], { env });
  for (const pid of fs.existsSync(dir) ? fs.readdirSync("/proc").filter((p) => /^\d+$/.test(p)) : []) {
    try { if (fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(FAKE_AGENT) && fs.readFileSync(`/proc/${pid}/environ`, "utf8").includes(`XDG_CONFIG_HOME=${config}`)) process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!unix)("hive ctl on a headless host", () => {
  test("an agent spawned there runs with no window: started, given its task, heard, read, named, closed; a verb that needs a window is refused", async () => {
    // A stand-in droid on PATH, and its manifest installed as the app installs one.
    fs.mkdirSync(bin, { recursive: true });
    const node = Bun.which("node") ?? process.execPath;
    fs.writeFileSync(path.join(bin, "droid"), `#!/usr/bin/env bash\nexec ${JSON.stringify(node)} ${JSON.stringify(FAKE_AGENT)} droid "$@"\n`, { mode: 0o755 });
    fs.cpSync(DROID, path.join(data, "agents", "droid"), { recursive: true });
    const repo = path.join(dir, "repo");
    fs.mkdirSync(repo);

    const host = spawn(...cmd(["host", "run"]), { env: { ...process.env, ...env }, stdio: "ignore" });
    running.push(host);
    await until(() => (hive(["host", "status", "--json"], { env }).json as { data?: { running?: boolean } })?.data?.running, "the host to answer");
    expect(hive(["host", "add", repo, "--json"], { env }).code).toBe(0);
    // Another device watching this machine's daemon, as one with a frame here does.
    const watcher = net.connect(path.join(data, "pty-daemon.sock"));
    const heard: Array<{ topic: string; data: { tileId?: string; event?: string } }> = [];
    let pending = "";
    watcher.on("data", (d) => {
      pending += d.toString();
      for (let nl = pending.indexOf("\n"); nl !== -1; nl = pending.indexOf("\n")) {
        const m = JSON.parse(pending.slice(0, nl)) as { t: string; topic: string; data: { tileId?: string; event?: string } };
        pending = pending.slice(nl + 1);
        if (m.t === "event") heard.push(m);
      }
    });
    await new Promise((r) => watcher.once("connect", r));
    watcher.write(`${JSON.stringify({ t: "hello", caps: ["events"] })}\n`);

    // Spawned by the person at this machine, into the one workspace the host serves.
    const spawned = ctl("spawn", "--agent", "droid", "--name", "worker", "--prompt", 'echo "hello from $PWD as $HIVEMIND_TILE"');
    expect(spawned.code, spawned.stdout + spawned.stderr).toBe(0);
    const worker = (spawned.json as { tileId: string }).tileId;
    const first = ctl("read", worker, "--timeout", "40000");
    expect(first.json, first.stdout + first.stderr).toMatchObject({ text: `hello from ${repo} as hm:${worker}`, finalStatus: "turn" });
    expect(listed().find((t) => t.tileId === worker)).toMatchObject({ name: "worker", agent: "droid", status: "idle" });
    // The daemon heard the turn too, through the socket it passed on: so do the devices watching it.
    await until(() => heard.some((e) => e.topic === "agent.event" && e.data.tileId === `hm:${worker}` && e.data.event === "turn.ended"), "the daemon to tell its watchers");
    // Its output is recorded, whoever shows it.
    const tail = hive(["ctl", "stream", worker, "--lines", "40", "--snapshot", "--json"], { env });
    expect(tail.stdout).toContain(`hello from ${repo}`);

    expect(ctl("send", worker, "echo second").code).toBe(0);
    expect(ctl("read", worker, "--timeout", "40000").json).toMatchObject({ text: "second", finalStatus: "turn" });

    // An unnamed one is called by what it says it is doing, as the daemon reads its title: its task
    // first, then what its next turn's title says.
    const unnamed = (ctl("spawn", "--agent", "droid", "--prompt", "echo titled").json as { tileId: string }).tileId;
    expect(ctl("read", unnamed, "--timeout", "40000").json).toMatchObject({ text: "titled", finalStatus: "turn" });
    expect(ctl("send", unnamed, "echo retitled").code).toBe(0);
    await until(() => listed().find((t) => t.tileId === unnamed)?.name === "echo retitled", "the title to name the tile");

    // An agent that opens a startup screen its launch flags answered (a stand-in whose manifest
    // says so): the host skips it, reading the screen in the daemon, and the task then goes in.
    const gated = path.join(data, "agents", "gated");
    fs.cpSync(DROID, gated, { recursive: true });
    const manifest = fs.readFileSync(path.join(gated, "agent.yaml"), "utf8")
      .replace(/^id: droid$/m, "id: gated").replace(/^bin: droid$/m, "bin: gated").replace(/^label: Droid$/m, "label: Gated").replace(/^  root: droid-home$/m, "  root: gated-home");
    fs.writeFileSync(path.join(gated, "agent.yaml"), `${manifest}\nspawn:\n  dismiss:\n  - when:\n      contains: hooks need review\n    keys: [Enter]\n`);
    fs.writeFileSync(path.join(bin, "gated"), `#!/usr/bin/env bash\nFAKE_GATE="2 hooks need review" exec ${JSON.stringify(node)} ${JSON.stringify(FAKE_AGENT)} droid "$@"\n`, { mode: 0o755 });
    const past = ctl("spawn", "--agent", "gated", "--name", "gated", "--prompt", "echo past the gate");
    expect(past.code, past.stdout + past.stderr).toBe(0);
    expect(ctl("read", (past.json as { tileId: string }).tileId, "--timeout", "40000").json).toMatchObject({ text: "past the gate", finalStatus: "turn" });

    // A read waiting on a worker mid-turn is told at once when it is closed, and the agent ends.
    const busy = (ctl("spawn", "--agent", "droid", "--name", "busy", "--prompt", "sleep 60; echo late").json as { tileId: string }).tileId;
    await until(() => processesOf(busy).length > 0, "the busy worker to run");
    const reading = hiveAsync(["ctl", "read", busy, "--timeout", "40000", "--json"], { env });
    await new Promise((r) => setTimeout(r, 1_500));
    const started = Date.now();
    expect(ctl("close", busy).code).toBe(0);
    expect(await reading).toMatchObject({ code: 5, json: { finalStatus: "closed" } });
    expect(Date.now() - started).toBeLessThan(10_000);
    await until(() => processesOf(busy).length === 0, "the busy worker to end");
    expect(listed().map((t) => t.tileId)).not.toContain(busy);

    // Nobody sits at it: a verb that needs a window is refused.
    expect(ctl("focus", worker)).toMatchObject({ code: 3, json: { ok: false, code: "APP_NO_RENDERER" } });

    watcher.destroy();
    // Stopped, the host gives the socket back: the daemon answers there again, as it does with no
    // control plane on the machine.
    expect(hive(["host", "stop", "--json"], { env }).code).toBe(0);
    await until(() => host.exitCode !== null || host.signalCode !== null, "the host to exit");
    expect(ctl("list")).toMatchObject({ code: 3, json: { ok: false, code: "UNAVAILABLE", message: "no desktop on this machine" } });
  });
});
