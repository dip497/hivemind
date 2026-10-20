/**
 * 0001 on a config root shaped like one from before packages (fixtures/0001/before): every view,
 * widget and tool becomes a package of one, on or off as it was, its settings kept, and the old
 * folders only in the backup. Run by the runner in a process of its own, as the app and `hive` run
 * it; killed at 20 points and run again, it ends as a clean run does.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ALL, files, TestRoot } from "./fixtures/runs.js";

const FIXTURE = path.join(import.meta.dir, "fixtures", "0001", "before");
const ADOPT = "0001-adopt-plugins-as-packages";
let t: TestRoot;

/** What a person and the app see of the root afterwards. */
function endState() {
  const records = (t.read("packages/installed.json").packages as { id: string; on: boolean; digest: string; members: { kind: string; id: string }[] }[])
    .map((r) => ({ id: r.id, on: r.on, digest: r.digest, members: r.members.map((m) => `${m.kind}:${m.id}`) }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const store = fs.readdirSync(path.join(t.root, "packages", "store")).sort()
    .map((p) => `${p}/${fs.readdirSync(path.join(t.root, "packages", "store", p)).join(",")}`);
  return {
    records, store,
    state: t.read("settings.json").plugins.state,
    old: ["views", "widgets", "tools"].filter((f) => t.has(f)),
    backup: t.backup(ADOPT),
    ledger: t.ledger().map((a) => a.id),
  };
}

beforeEach(() => { t = new TestRoot(FIXTURE); });
afterEach(() => t.remove());

describe(ADOPT, () => {
  test("every old plugin is a package of one, on or off as it was, its settings kept", () => {
    const applied = t.runOnce();
    expect(applied.map((a) => a.id)).toEqual(ALL);
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
    const result = applied[0]!.result;
    expect(result.adopted).toBe(8);
    expect(result.skipped!.map((x) => x.path)).toEqual(["widgets/agents", "widgets/clock", "widgets/odd", "tools/dip497--old-format"]);
    // A view and a widget of one name: the second is kept in the backup, and the reason says what to do.
    expect(result.skipped!.find((x) => x.path === "widgets/clock")!.why).toContain("clock 1.0.0 is already installed as a package (the view clock)");
    expect(result.skipped!.find((x) => x.path === "widgets/clock")!.why).toContain("@you/clock, and run `hive plugins install <that folder>`");
    // The old folders are gone, and only in the backup, byte for byte.
    expect(s.old).toEqual([]);
    expect(s.backup).toEqual(files(FIXTURE));
    // A tool that said dip497/pages: its files are the old folder's, its manifest says @dip497/pages.
    const pages = fs.readdirSync(path.join(t.root, "packages", "store", "dip497--pages"));
    const stored = path.join(t.root, "packages", "store", "dip497--pages", pages[0]!);
    const { "hivemind-tool.json": _m, ...rest } = files(stored);
    const { "hivemind-tool.json": _o, ...oldRest } = files(path.join(FIXTURE, "tools", "dip497--pages"));
    expect(rest).toEqual(oldRest);
    const was = JSON.parse(fs.readFileSync(path.join(FIXTURE, "tools", "dip497--pages", "hivemind-tool.json"), "utf8"));
    expect(JSON.parse(fs.readFileSync(path.join(stored, "hivemind-tool.json"), "utf8"))).toEqual({ ...was, id: "@dip497/pages" });
    expect(fs.existsSync(path.join(t.root, "migrations", "0001-staging"))).toBe(false);
  });

  test("a second run does nothing", () => {
    t.runOnce();
    const before = endState();
    expect(t.runOnce()).toEqual([]);
    expect(endState()).toEqual(before);
  });

  test("two runs started at once adopt once, and the ledger has one entry each", async () => {
    // Both find the migrations pending, then wait on a lock held here, so both are inside the race.
    const lock = path.join(t.root, "migrations", "lock");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, `${process.pid}:${Date.now()}:held`);
    let waiting = 0;
    const runs = [0, 1].map(() => t.start((line) => { if (line.includes("upgrading your data")) waiting++; }));
    const until = Date.now() + 20_000;
    while (waiting < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    expect(waiting).toBe(2);
    fs.rmSync(lock);
    expect(await Promise.all(runs.map((r) => r.done))).toEqual([0, 0]);
    const s = endState();
    // The entry is the run that adopted: the second found it done.
    expect(t.ledger().map((a) => [a.id, a.result.adopted])).toEqual(ALL.map((id) => [id, id === ADOPT ? 8 : undefined]));
    t.fresh();
    t.runOnce();
    expect(s).toEqual(endState());
  }, 60_000);

  test("killed at 20 points and run again, it ends as a clean run does", async () => {
    const { clean, ends, cutOff } = await t.killedAndRunAgain(endState);
    for (const end of ends) expect(end).toEqual(clean);
    expect(cutOff).toBe(20);
  }, 240_000);
});
