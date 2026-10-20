/**
 * 0001 on a config root shaped like one from before packages (fixtures/0001/before): every view,
 * widget and tool becomes a package of one, on or off as it was, its settings kept, and the old
 * folders only in the backup. Run by the runner in a process of its own, as the app and `hive` run
 * it; killed at 20 points and run again, it ends as a clean run does.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FIXTURE = path.join(import.meta.dir, "fixtures", "0001", "before");
const RUN = `const { runMigrations } = await import(${JSON.stringify(path.join(import.meta.dir, "runner.ts"))});
console.log("started");
const r = await runMigrations({ by: "cli", app: "2026.10.4", say: (line) => console.error(line) });
console.log(JSON.stringify(r));`;

let home: string;
const root = () => path.join(home, "hivemind");
const env = () => ({ ...process.env, XDG_CONFIG_HOME: home, HIVEMIND_APP_DATA: root(), HIVE_SETTINGS: "" });

function freshRoot(): void {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hive-0001-"));
  fs.cpSync(FIXTURE, root(), { recursive: true });
}
const runOnce = () => {
  const r = spawnSync("bun", ["-e", RUN], { env: env(), encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as { applied: { id: string; result: { adopted: number; skipped: { path: string; why: string }[] } }[] }[];
};
const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(root(), rel), "utf8"));

/** Every file under `dir` by its path, as a SHA-256. */
function files(dir: string): Record<string, string> {
  if (!fs.existsSync(dir)) return {};
  const out: Record<string, string> = {};
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const at = path.join(e.parentPath, e.name);
    out[path.relative(dir, at)] = createHash("sha256").update(fs.readFileSync(at)).digest("hex");
  }
  return out;
}

/** What a person and the app see of the root afterwards. */
function endState() {
  const records = (read("packages/installed.json").packages as { id: string; on: boolean; digest: string; members: { kind: string; id: string }[] }[])
    .map((r) => ({ id: r.id, on: r.on, digest: r.digest, members: r.members.map((m) => `${m.kind}:${m.id}`) }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const store = fs.readdirSync(path.join(root(), "packages", "store")).sort()
    .map((p) => `${p}/${fs.readdirSync(path.join(root(), "packages", "store", p)).join(",")}`);
  return {
    records, store,
    state: read("settings.json").plugins.state,
    old: ["views", "widgets", "tools"].filter((f) => fs.existsSync(path.join(root(), f))),
    backup: files(path.join(root(), "migrations", "backups", "0001-adopt-plugins-as-packages")),
    ledger: (read("migrations/ledger.json").applied as { id: string; result: unknown }[]).map((a) => [a.id, a.result]),
  };
}

beforeEach(freshRoot);
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("0001-adopt-plugins-as-packages", () => {
  test("every old plugin is a package of one, on or off as it was, its settings kept", () => {
    const [report] = runOnce();
    expect(report!.applied.map((a) => a.id)).toEqual(["0001-adopt-plugins-as-packages"]);
    const s = endState();
    expect(s.records.map((r) => [r.id, r.members, r.on])).toEqual([
      ["@dip497/ci-runs", ["tool:@dip497/ci-runs"], false],
      ["@dip497/dog", ["widget:@dip497/dog"], false],
      ["@dip497/github-prs", ["tool:@dip497/github-prs"], true],
      ["@dip497/island", ["view:@dip497/island"], false],
      ["@dip497/pages", ["tool:@dip497/pages"], true],
      ["@dip497/widgets", ["view:@dip497/widgets"], true],
      ["clock", ["view:clock"], true],
      ["pomodoro", ["widget:pomodoro"], true],
    ]);
    expect(s.state).toEqual({
      "tool:@dip497/github-prs": { options: { count: 80 } },
      "tool:@dip497/worktrees": { enabled: true },
      "tool:@dip497/ci-runs": { options: { count: 120, since: "7d" } }, // its old and new keys merged
      "widget:pomodoro": { options: { minutes: 50 } },
      "widget:@dip497/dog": { options: { name: "Rex" } },
    });
    const result = report!.applied[0]!.result;
    expect(result.adopted).toBe(8);
    expect(result.skipped.map((x) => x.path)).toEqual(["widgets/agents", "widgets/clock", "widgets/odd", "tools/dip497--old-format"]);
    // A view and a widget of one name: the second is kept in the backup, and the reason says what to do.
    expect(result.skipped.find((x) => x.path === "widgets/clock")!.why).toContain("clock 1.0.0 is already installed as a package (the view clock)");
    expect(result.skipped.find((x) => x.path === "widgets/clock")!.why).toContain("@you/clock, and run `hive plugins install <that folder>`");
    // The old folders are gone, and only in the backup, byte for byte.
    expect(s.old).toEqual([]);
    expect(s.backup).toEqual(files(FIXTURE));
    // A tool that said dip497/pages: its files are the old folder's, its manifest says @dip497/pages.
    const pages = fs.readdirSync(path.join(root(), "packages", "store", "dip497--pages"));
    const stored = path.join(root(), "packages", "store", "dip497--pages", pages[0]!);
    const { "hivemind-tool.json": _m, ...rest } = files(stored);
    const { "hivemind-tool.json": _o, ...oldRest } = files(path.join(FIXTURE, "tools", "dip497--pages"));
    expect(rest).toEqual(oldRest);
    const was = JSON.parse(fs.readFileSync(path.join(FIXTURE, "tools", "dip497--pages", "hivemind-tool.json"), "utf8"));
    expect(JSON.parse(fs.readFileSync(path.join(stored, "hivemind-tool.json"), "utf8"))).toEqual({ ...was, id: "@dip497/pages" });
    expect(fs.existsSync(path.join(root(), "migrations", "0001-staging"))).toBe(false);
  });

  test("a second run does nothing", () => {
    runOnce();
    const before = endState();
    const [again] = runOnce();
    expect(again!.applied).toEqual([]);
    expect(endState()).toEqual(before);
  });

  test("two runs started at once adopt once, and the ledger has one entry", async () => {
    // Both find the migration pending, then wait on a lock held here, so both are inside the race.
    const lock = path.join(root(), "migrations", "lock");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, `${process.pid}:${Date.now()}:held`);
    let waiting = 0;
    const start = () => new Promise<number | null>((r) => {
      const c = spawn("bun", ["-e", RUN], { env: env() });
      c.stderr!.on("data", (d: Buffer) => { if (d.toString().includes("upgrading your data")) waiting++; });
      c.on("close", r);
    });
    const both = Promise.all([start(), start()]);
    const until = Date.now() + 20_000;
    while (waiting < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    expect(waiting).toBe(2);
    fs.rmSync(lock);
    expect(await both).toEqual([0, 0]);
    const s = endState();
    // One entry, the run that adopted: the second found it done.
    expect(s.ledger.map(([id, r]) => [id, (r as { adopted: number }).adopted])).toEqual([["0001-adopt-plugins-as-packages", 8]]);
    fs.rmSync(home, { recursive: true, force: true });
    freshRoot();
    runOnce();
    const clean = endState();
    expect({ ...s, ledger: null }).toEqual({ ...clean, ledger: null });
  }, 60_000);

  test("killed at 20 points and run again, it ends as a clean run does", async () => {
    // How long a run takes once started (the fastest of three), to spread the kills over it.
    let took = Infinity;
    for (let n = 0; n < 3; n++) {
      fs.rmSync(home, { recursive: true, force: true });
      freshRoot();
      let t = Date.now();
      const timed = spawn("bun", ["-e", RUN], { env: env() });
      timed.stdout!.on("data", (d: Buffer) => { if (d.toString().includes("started")) t = Date.now(); });
      await new Promise((r) => timed.on("close", r));
      took = Math.min(took, Date.now() - t);
    }
    const clean = endState();
    let interrupted = 0;
    for (let i = 0; i < 20; i++) {
      fs.rmSync(home, { recursive: true, force: true });
      freshRoot();
      const c = spawn("bun", ["-e", RUN], { env: env() });
      const closed = new Promise((r) => c.on("close", r));
      await new Promise<void>((r) => c.stdout!.on("data", (d: Buffer) => { if (d.toString().includes("started")) r(); }));
      await new Promise((r) => setTimeout(r, (took * i) / 20));
      c.kill("SIGKILL");
      await closed;
      if (!fs.existsSync(path.join(root(), "migrations", "ledger.json"))) interrupted++;
      runOnce();
      const s = endState();
      expect(s.ledger.map(([id]) => id)).toEqual(["0001-adopt-plugins-as-packages"]);
      expect({ ...s, ledger: null }).toEqual({ ...clean, ledger: null });
    }
    expect(interrupted).toBeGreaterThanOrEqual(10);
  }, 240_000);
});
