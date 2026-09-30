// `hive host` (R14): the headless host is this machine's device, the one the app is here (its keys
// are the app's, in the app's data folder), on the network as that device; it is the only host on
// the machine — a second one, or one while the app runs, is refused and the first keeps serving;
// and it stops when asked. Needs crates/hive-net's build.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { cmd, hive } from "./helpers.js";
import { idOf } from "@hivemind/workspace-host/identity";

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
async function until<T>(get: () => T | null | undefined, what: string, ms = 30_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) {
    const v = get();
    if (v) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}

afterAll(() => {
  for (const c of running) c.kill("SIGKILL");
  if (unix) hive(["daemon", "stop"], { env });
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Status { running: boolean; pid: number; device: string; network: { id: string } | null }

describe.skipIf(!built)("hive host", () => {
  test("serves as this machine's device, on the network; the only host here; stops when asked", async () => {
    const first = runHost();
    const status = await until(() => {
      const s = data<Status>(hive(["host", "status", "--json"], { env }));
      return s.running ? s : null;
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
