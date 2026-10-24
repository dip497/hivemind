/**
 * `hive migrations` shows what ran on this machine's data; `restore` puts it back byte for byte
 * and the next start runs it again; and a `hive` command leaves files an older running app reads
 * where they are.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hive } from "./helpers.js";

const BEFORE = path.join(import.meta.dir, "..", "..", "..", "packages", "hive-core", "src", "migrations", "fixtures", "0001", "before");
const ADOPT = "0001-adopt-plugins-as-packages";
const ALL = [ADOPT, "0002-plugin-state-from-old-keys", "0003-remove-old-one-off-backups", "0004-remove-machines-marker", "0006-notifications-into-settings"];

let home: string;
const root = () => path.join(home, "hivemind");
const env = () => ({ XDG_CONFIG_HOME: home, HIVEMIND_APP_DATA: root() });

function files(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const at = path.join(e.parentPath, e.name);
    out[path.relative(dir, at)] = createHash("sha256").update(fs.readFileSync(at)).digest("hex");
  }
  return out;
}
/** The root as the fixture holds it: the old folders and settings.json. */
const oldLayout = () => Object.fromEntries(Object.entries(files(root())).filter(([p]) => !p.startsWith("migrations") && !p.startsWith("packages")));
const records = () => (JSON.parse(fs.readFileSync(path.join(root(), "packages", "installed.json"), "utf8")).packages as { id: string; on: boolean; digest: string }[])
  .map((r) => `${r.id} ${r.on} ${r.digest}`).sort();
/** An app runs on the root, as Electron's single-instance lock says: this test's own process. */
const appRuns = () => fs.symlinkSync(`${os.hostname()}-${process.pid}`, path.join(root(), "SingletonLock"));

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hive-migrations-"));
  fs.cpSync(BEFORE, root(), { recursive: true });
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("hive migrations", () => {
  test("lists what is still to run, and what ran, by which build", () => {
    const before = hive(["migrations", "--json"], { env: env() }).json as { roots: { pending: string[]; applied: unknown[] }[] };
    expect(before.roots.map((r) => [r.pending, r.applied])).toEqual([[ALL, []]]);
    // `hive migrations` itself moved nothing.
    expect(fs.existsSync(path.join(root(), "views"))).toBe(true);
    hive(["config", "path"], { env: env() });
    const after = hive(["migrations", "--json"], { env: env() }).json as { roots: { pending: string[]; applied: { id: string; by: string; backupKept: boolean; result: { adopted: number } }[] }[] };
    expect(after.roots.map((r) => r.pending)).toEqual([[]]);
    expect(after.roots[0]!.applied[0]).toMatchObject({ id: ADOPT, by: "cli", backupKept: true, result: { adopted: 8 } });
    expect(after.roots[0]!.applied.map((a) => a.id)).toEqual(ALL);
    const shown = hive(["migrations"], { env: env() }).stdout;
    expect(shown).toContain(`ran      ${ADOPT}`);
    // A plugin it could not keep is named, with what to do.
    expect(shown).toContain("not kept: widgets/clock: clock 1.0.0 is already installed as a package (the view clock)");
    expect(shown).toContain("run `hive plugins install <that folder>`");
  });

  test("restore puts the old folders and settings back byte for byte, and the next start adopts them again", () => {
    const old = oldLayout();
    hive(["config", "path"], { env: env() });
    const adopted = records();
    expect(fs.existsSync(path.join(root(), "views"))).toBe(false);
    const r = hive(["migrations", "restore", ADOPT, "--json"], { env: env() });
    expect(r.code).toBe(0);
    // Every migration after it is undone first.
    expect((r.json as { restored: string[] }).restored).toEqual([...ALL].reverse());
    expect(oldLayout()).toEqual(old);
    const ledger = JSON.parse(fs.readFileSync(path.join(root(), "migrations", "ledger.json"), "utf8")) as { applied: unknown[] };
    expect(ledger.applied).toEqual([]);
    hive(["config", "path"], { env: env() });
    expect(records()).toEqual(adopted);
    expect(fs.existsSync(path.join(root(), "views"))).toBe(false);
  });

  test("restore is refused while the app runs, and changes nothing", () => {
    hive(["config", "path"], { env: env() });
    appRuns();
    const r = hive(["migrations", "restore", ADOPT], { env: env() });
    expect(r.code).toBe(7);
    expect(r.stderr).toContain("the app runs");
    expect(fs.existsSync(path.join(root(), "views"))).toBe(false);
  });

  test("restore of an id that never ran is refused with what to run instead", () => {
    const r = hive(["migrations", "restore", "0999-nothing", "--json"], { env: env() });
    expect(r.code).toBe(7);
    expect((r.json as { error: { message: string } }).error.message).toContain("`hive migrations` lists those that have");
  });
});

describe("an older app running", () => {
  const sayVersion = (version: string) => {
    fs.mkdirSync(path.join(root(), "migrations"), { recursive: true });
    fs.writeFileSync(path.join(root(), "migrations", "running-app.json"), JSON.stringify({ pid: process.pid, version }));
  };

  test("one from before the app said its version: the files it reads stay, and the person is told to quit it", () => {
    appRuns();
    const r = hive(["config", "path"], { env: env() });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("quit Hivemind to finish updating your data");
    expect(oldLayout()).toEqual(files(BEFORE));
  });

  test("one that says an older version: the same", () => {
    appRuns();
    sayVersion("2000.1.0");
    expect(hive(["config", "path"], { env: env() }).stderr).toContain("quit Hivemind");
    expect(fs.existsSync(path.join(root(), "views"))).toBe(true);
  });

  test("one that says this version or newer: the data moves", () => {
    appRuns();
    sayVersion("2099.1.0");
    expect(hive(["config", "path"], { env: env() }).stderr).not.toContain("quit Hivemind");
    expect(fs.existsSync(path.join(root(), "views"))).toBe(false);
  });
});
