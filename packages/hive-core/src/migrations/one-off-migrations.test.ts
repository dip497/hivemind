/**
 * 0002–0004 on a root shaped like one from before plugin state (fixtures/one-offs/before):
 * settings.json keeps each switch in a key of its own, beside the backups and marker that one-off
 * moves left. Each switch becomes a record (and 0001 switches each adopted plugin by it), the old
 * keys and files go, each kept in its migration's backup; killed at 20 points and run again, it
 * ends as a clean run does.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { ALL, files, TestRoot } from "./fixtures/runs.js";

const FIXTURE = path.join(import.meta.dir, "fixtures", "one-offs", "before");
let t: TestRoot;

function endState() {
  const raw = t.read("settings.json");
  return {
    settings: raw,
    packages: (t.read("packages/installed.json").packages as { id: string; on: boolean }[]).map((r) => `${r.id} ${r.on ? "on" : "off"}`).sort(),
    left: ["agents-before-v2-0128", "settings.json.bak", "machines-migrated", "views", "tools"].filter((p) => t.has(p)),
    backups: Object.fromEntries(ALL.map((id) => [id, t.backup(id)])),
  };
}

beforeEach(() => { t = new TestRoot(FIXTURE); });
afterEach(() => t.remove());

describe("the one-off moves of builds before the ledger", () => {
  test("switches in their old keys become records, and adopted plugins are switched by them", () => {
    expect(t.runOnce().map((a) => a.id)).toEqual(ALL);
    const s = endState();
    expect(s.packages).toEqual(["@dip497/island off", "@dip497/pages on"]);
    expect(s.settings.plugins.state).toEqual({
      "agent:codex": { enabled: false },
      "agent:claude": { options: { model: "opus" } },
      "tool:@dip497/pages": { options: { comments: false } },
    });
  });

  test("the old keys and files go, and each is kept in its migration's backup", () => {
    t.runOnce();
    const s = endState();
    expect(["tools", "migrated"].filter((k) => k in s.settings)).toEqual([]);
    expect([s.settings.agents.disabled, s.settings.agents.options, s.settings.plugins.disabled]).toEqual([undefined, undefined, undefined]);
    expect(s.settings.browserCdp).toBe(true);
    expect(s.left).toEqual([]);
    const fixture = files(FIXTURE);
    const pick = (paths: string[]) => Object.fromEntries(Object.entries(fixture).filter(([p]) => paths.some((x) => p === x || p.startsWith(`${x}/`))));
    expect(s.backups["0001-adopt-plugins-as-packages"]).toEqual(pick(["views", "tools", "settings.json"]));
    // 0002 found the state 0001 had written: its copy is of that file.
    expect(Object.keys(s.backups["0002-plugin-state-from-old-keys"]!)).toEqual(["settings.json"]);
    expect(s.backups["0003-remove-old-one-off-backups"]).toEqual(pick(["agents-before-v2-0128", "settings.json.bak"]));
    expect(s.backups["0004-remove-machines-marker"]).toEqual(pick(["machines-migrated"]));
  });

  test("killed at 20 points and run again, it ends as a clean run does", async () => {
    const { clean, ends, cutOff } = await t.killedAndRunAgain(endState);
    for (const end of ends) expect(end).toEqual(clean);
    expect(cutOff).toBe(20);
  }, 240_000);
});
