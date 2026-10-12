import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import globalTeardown from "../e2e/global-teardown";

/** A process that looks like a terminal daemon serving a socket in `dir`, its environment `env`. */
function daemonIn(dir: string, env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)", path.join(dir, "pty-daemon.js"), path.join(dir, "pty-daemon.sock")], { env, stdio: "ignore" });
}
const alive = (p: ChildProcess) => p.exitCode === null && p.signalCode === null;
const settle = () => new Promise((r) => setTimeout(r, 300));

test("an e2e run stops the daemons it started, never another app's in the temp dir", async () => {
  const run = fs.mkdtempSync(path.join(os.tmpdir(), "hivemind-e2e-xdg-"));
  const someone = fs.mkdtempSync(path.join(os.tmpdir(), "hm-someone-"));
  const { HIVEMIND_E2E_XDG: _, XDG_CONFIG_HOME: __, ...base } = process.env;
  const ours = daemonIn(path.join(run, "hivemind"), { ...base, HIVEMIND_E2E_XDG: run });
  const theirs = daemonIn(someone, base);
  const was = { run: process.env.HIVEMIND_E2E_XDG, xdg: process.env.XDG_CONFIG_HOME };
  try {
    await settle();
    process.env.HIVEMIND_E2E_XDG = run;
    process.env.XDG_CONFIG_HOME = run;
    globalTeardown();
    await settle();
    assert.equal(alive(ours), false, "the run's daemon is stopped");
    assert.equal(alive(theirs), true, "a daemon this run did not start keeps running");
    assert.equal(fs.existsSync(run), false, "the run's profile is removed");
  } finally {
    for (const [k, v] of [["HIVEMIND_E2E_XDG", was.run], ["XDG_CONFIG_HOME", was.xdg]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    ours.kill("SIGKILL");
    theirs.kill("SIGKILL");
    fs.rmSync(someone, { recursive: true, force: true });
    fs.rmSync(run, { recursive: true, force: true });
  }
});
