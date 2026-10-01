// `hive host` (R14): the headless host is this machine's device, the one the app is here (its keys
// are the app's, in the app's data folder), on the network as that device; it is the only host on
// the machine — a second one, or one while the app runs, is refused and the first keeps serving;
// and it stops when asked. A laptop pairs with it (spec/pairing.md), after which the host is the
// laptop's person, lists the workspaces it holds to the laptop and opens one to it as its owner;
// a terminal the laptop starts there runs on after the laptop is gone. Here the laptop is this
// test, with keys and a hive-net of its own. Needs crates/hive-net's build.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { cmd, hive } from "./helpers.js";
import { idOf } from "@hivemind/workspace-host/identity";
import { machineKeys } from "@hivemind/workspace-host/keyring";
import { HiveNet } from "@hivemind/workspace-host/hive-net";
import { enterPairing, parsePairLink } from "@hivemind/workspace-host/pairing";
import { WorkspaceStore, type WorkspaceChange } from "@hivemind/workspace-host/store";
import { replicate } from "@hivemind/workspace-host/doc-sync";
import type { Access } from "@hivemind/workspace-host/access";
import { peerTransport, workspaceUrl } from "@hivemind/workspace-api/peers";
import { WorkspaceClient } from "@hivemind/workspace-api/client";
import { heldWorkspaces, streamOf } from "@hivemind/host/peer-links";

setDefaultTimeout(90_000);
const HIVE_NET = path.resolve(import.meta.dir, "../../../crates/hive-net/target/debug/hive-net");
const unix = process.platform !== "win32";
const built = unix && fs.existsSync(HIVE_NET);

// sun_path is ~108 bytes; os.tmpdir() can be deep, /tmp is not.
const dir = unix ? fs.mkdtempSync("/tmp/hive-host-") : "";
const appData = path.join(dir, "data");
const env = { HIVEMIND_APP_DATA: appData, HIVEMIND_HIVE_NET: HIVE_NET, HIVEMIND_PTY_SOCK: path.join(dir, "d.sock"), HIVEMIND_SHELL_ENV: "0" };
const data = <T>(r: ReturnType<typeof hive>) => (r.json as { data: T }).data;
const running: ChildProcess[] = [];

function runHost(): ChildProcess {
  const c = spawn(...cmd(["host", "run"]), { env: { ...process.env, ...env }, stdio: "ignore" });
  running.push(c);
  return c;
}
async function until<T>(get: () => T | null | undefined | false | Promise<T | null | undefined | false>, what: string, ms = 30_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) {
    const v = await get();
    if (v) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}

afterAll(() => {
  for (const c of running) c.kill("SIGKILL");
  if (unix) hive(["daemon", "stop"], { env });
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Status {
  running: boolean;
  pid: number;
  device: string;
  person: string;
  network: { id: string } | null;
  devices: Array<{ device: string; name: string; kind: string }>;
}
/** The host's status; undefined while it is starting. */
const status = () => data<Status | undefined>(hive(["host", "status", "--json"], { env }));

/** The lines a process prints, one at a time. */
function lines(stream: NodeJS.ReadableStream): () => Promise<string> {
  const ready: string[] = [];
  const waiting: Array<(line: string) => void> = [];
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (d: string) => {
    buffer += d;
    for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const w = waiting.shift();
      if (w) w(line); else ready.push(line);
    }
  });
  return () => new Promise((resolve) => { const l = ready.shift(); if (l !== undefined) resolve(l); else waiting.push(resolve); });
}

describe.skipIf(!built)("hive host", () => {
  test("serves as this machine's device, on the network; the only host here; stops when asked", async () => {
    const first = runHost();
    const status = await until(() => {
      const s = data<Status | undefined>(hive(["host", "status", "--json"], { env }));
      return s?.running ? s : null;
    }, "the host to answer");
    // The app's keys, in the app's data folder: the host and the app are one device here.
    const deviceKey = fs.readFileSync(path.join(appData, "identity", "device.key"), "utf8").trim();
    expect(status.device).toBe(idOf(new Uint8Array(Buffer.from(deviceKey, "hex"))));
    expect(status.pid).toBe(first.pid!);
    expect(status.network?.id).toBe(status.device);

    // A second host is refused, and the first keeps serving.
    const second = hive(["host", "run", "--json"], { env });
    expect(second.code).toBe(3);
    expect(second.json).toMatchObject({ ok: false, code: "already_running" });
    expect(data<Status>(hive(["host", "status", "--json"], { env })).pid).toBe(first.pid!);

    expect(data<{ stopped: boolean }>(hive(["host", "stop", "--json"], { env })).stopped).toBe(true);
    expect(data<Status>(hive(["host", "status", "--json"], { env })).running).toBe(false);
    await until(() => first.exitCode !== null || first.signalCode !== null, "the host to exit");
    expect(first.exitCode).toBe(0);
  });

  test("a laptop pairs with it, finds the workspace it holds and opens it as the owner; a terminal started there runs on after the laptop goes", async () => {
    const repo = path.join(dir, "api");
    fs.mkdirSync(repo);
    runHost();
    await until(() => status()?.running || null, "the host to answer");
    const added = data<{ repo: string; workspace: string }>(hive(["host", "add", repo, "--json"], { env }));
    expect(added.repo).toBe(repo);

    // The laptop: keys and a hive-net of its own.
    const identity = path.join(dir, "laptop", "identity");
    const keys = machineKeys(identity);
    const laptop = await HiveNet.start({
      bin: HIVE_NET, identity, socket: path.join(dir, "l.sock"),
      onIncoming: (link) => link.close(), onPairRequest: async () => ({ ok: false, error: "declined" }),
    });
    try {
      // The host shows a code; the laptop enters its link.
      const pairing = spawn(...cmd(["host", "pair", "--json"]), { env: { ...process.env, ...env } });
      running.push(pairing);
      const printed = lines(pairing.stdout!);
      const offer = (JSON.parse(await printed()) as { data: { offer: { link: string } } }).data.offer;
      const link = parsePairLink(offer.link)!;
      const where = { addrs: link.addrs, relay: link.relay };
      const paired = await enterPairing({
        me: { device: keys.deviceId, name: "laptop", kind: "app", certificate: keys.certificate, person: keys.person, addrs: laptop.ready.addrs, relay: laptop.ready.relay },
        code: link.code, offering: link.device, ask: (hello) => laptop.pair(link.device, where, hello),
      });
      expect(paired.with).toMatchObject({ device: link.device, kind: "host" });
      expect(JSON.parse(await printed())).toMatchObject({ ok: true, data: { paired: { device: keys.deviceId, name: "laptop", kind: "app" } } });

      // The host is the laptop's person now, and knows the laptop.
      const now = await until(() => { const s = status(); return s?.running && s.person === keys.personId ? s : null; }, "the host to be the laptop's person");
      expect(now.devices).toEqual([{ device: keys.deviceId, name: "laptop", kind: "app" }]);

      // It tells the laptop which workspaces it holds.
      const asking = await laptop.dial(link.device, where);
      expect(await heldWorkspaces(asking)).toEqual([{ workspace: added.workspace, name: "api", repo }]);
      asking.close();

      // The laptop opens it, as its owner.
      const heard = new Set<(change: WorkspaceChange) => void>();
      const replicas = new WorkspaceStore({ dir: path.join(dir, "laptop", "shared"), onChange: (c) => { for (const l of heard) l(c); } });
      const url = workspaceUrl(added.workspace);
      const opened = await laptop.dial(link.device, where);
      const access = await new Promise<Access>((resolve) => {
        replicate(replicas, url, streamOf(opened, "sync"), {
          workspace: added.workspace,
          changes: (l) => { heard.add(l); return () => { heard.delete(l); }; },
          onWelcome: resolve,
        });
      });
      expect(access).toBe("owner");

      // A shell in it, started on the host, outlives the laptop's connection.
      replicas.addTile(url, { id: "t-sh", kind: "shell", label: "sh", cmd: "sh" });
      const client = new WorkspaceClient(peerTransport(streamOf(opened, "api")));
      const start = () => client.call("terminal.open", { tileId: "hm:t-sh", cwd: url, cmd: "sh", args: ["-c", "sleep 2; pwd > ran.txt"], cols: 80, rows: 24 });
      await until(async () => (await start().then(() => true, () => false)) || null, "the host to start the shell");
      opened.close();
      laptop.stop();
      expect(await until(() => fs.existsSync(path.join(repo, "ran.txt")) && fs.readFileSync(path.join(repo, "ran.txt"), "utf8").trim(), "the shell to run on")).toBe(repo);
    } finally {
      laptop.stop();
      hive(["host", "stop"], { env });
    }
  });

  test("is refused while the app runs here, which serves this machine's workspaces itself", () => {
    // Electron's single-instance lock, as the app holds it: `<host>-<pid>` of a live process.
    fs.mkdirSync(appData, { recursive: true });
    const lock = path.join(appData, "SingletonLock");
    fs.symlinkSync(`${os.hostname()}-${process.pid}`, lock);
    try {
      const r = hive(["host", "run", "--json"], { env });
      expect(r.code).toBe(3);
      expect(r.json).toMatchObject({ ok: false, code: "app_running" });
    } finally {
      fs.rmSync(lock);
    }
  });
});
