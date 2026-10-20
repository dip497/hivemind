/**
 * Every `hive` command that reads this machine's data first looks at the data root's migration
 * ledger, under the root's migration lock: what a newer build did is said once and kept, a lock a
 * dead runner left is cleared, a live one is waited for, and `--version` touches nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { cmd, hive, sealedEnv } from "./helpers.js";

let home: string;
let root: string;
const env = () => ({ XDG_CONFIG_HOME: home, HIVEMIND_APP_DATA: root });
const ledgerPath = () => path.join(root, "migrations", "ledger.json");
const lockPath = () => path.join(root, "migrations", "lock");
const writeLedger = (applied: unknown[]) => {
  fs.mkdirSync(path.dirname(ledgerPath()), { recursive: true });
  fs.writeFileSync(ledgerPath(), JSON.stringify({ format: "hivemind-migrations", v: 1, applied }));
};
const fromNewerBuild = { id: "9001-from-a-newer-build", app: "2099.1.0", by: "app", at: "2099-01-01T00:00:00.000Z", ms: 3 };

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hive-migrations-start-"));
  root = path.join(home, "hivemind");
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("hive on start", () => {
  test("data a newer build migrated is said once, and its ledger entry is kept", () => {
    writeLedger([fromNewerBuild]);
    const first = hive(["config", "path"], { env: env() });
    expect(first.code).toBe(0);
    expect(first.stderr).toContain("your data was updated by Hivemind 2099.1.0");
    expect(first.stderr).toContain("hive migrations restore 9001-from-a-newer-build");
    const again = hive(["config", "path"], { env: env() });
    expect(again.stderr).not.toContain("your data was updated");
    const ledger = JSON.parse(fs.readFileSync(ledgerPath(), "utf8")) as { applied: { id: string }[] };
    expect(ledger.applied.map((a) => a.id)).toContain("9001-from-a-newer-build");
  });

  test("a lock left by a runner that died is cleared, and the command goes on", () => {
    writeLedger([fromNewerBuild]);
    const dead = spawn(process.execPath, ["-e", "0"]);
    const pid = dead.pid!;
    fs.writeFileSync(lockPath(), `${pid}:${Date.now() - 10_000}:gone`);
    return new Promise<void>((done) => dead.on("exit", () => {
      const r = hive(["config", "path"], { env: env() });
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("your data was updated by Hivemind 2099.1.0");
      expect(fs.existsSync(lockPath())).toBe(false);
      done();
    }));
  });

  test("a live holder is waited for, with a line saying so", async () => {
    writeLedger([fromNewerBuild]);
    fs.writeFileSync(lockPath(), `${process.pid}:${Date.now()}:held`);
    const c = spawn(...cmd(["config", "path"]), { env: { ...sealedEnv(), ...env() } as NodeJS.ProcessEnv });
    let err = "";
    c.stderr.setEncoding("utf8").on("data", (d: string) => { err += d; });
    const exit = new Promise<number | null>((r) => c.on("close", r));
    const until = Date.now() + 20_000;
    while (!err.includes("another hivemind process is upgrading your data") && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    expect(err).toContain("another hivemind process is upgrading your data");
    expect(err).not.toContain("your data was updated");
    fs.rmSync(lockPath());
    expect(await exit).toBe(0);
    expect(err).toContain("your data was updated by Hivemind 2099.1.0");
  }, 30_000);

  test("an unreadable ledger stops a command that reads the data, and --version reads nothing", () => {
    fs.mkdirSync(path.dirname(ledgerPath()), { recursive: true });
    fs.writeFileSync(ledgerPath(), "{ not json");
    const r = hive(["config", "path"], { env: env() });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("ledger.json cannot be read");
    expect(hive(["--version"], { env: env() }).code).toBe(0);
  });
});
