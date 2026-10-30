/**
 * 0008 on a settings.json from before the live scenes moved into a package (fixtures/0008/before):
 * Koi Pond as the wallpaper and Shoal as the one a Clean preset put aside name the package's
 * wallpapers, which this build reads, and every other value stays. A file naming neither is left
 * alone, with no backup. Killed at 20 points and run again, it ends as a clean run does.
 */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { mergeSettings } from "../settings-schema.js";
import { TestRoot } from "./fixtures/runs.js";

const FIXTURE = path.join(import.meta.dir, "fixtures", "0008", "before");
const ID = "0008-live-scenes-into-a-package";
const BEFORE = JSON.parse(fs.readFileSync(path.join(FIXTURE, "settings.json"), "utf8"));
let t: TestRoot;
afterEach(() => t.remove());

const endState = () => ({ settings: t.read("settings.json"), backup: t.backup(ID) });

describe("the live scenes' names move to the Live scenes package", () => {
  test("the wallpaper and the one put aside name the package's, which this build reads; the rest stays", () => {
    t = new TestRoot(FIXTURE);
    t.runOnce();
    const s = t.read("settings.json");
    expect([s.appearance.wallpaper.kind, s.appearance.lookBefore.wallpaper]).toEqual(["@dip497/live-scenes/koi", "@dip497/live-scenes/shoal"]);
    const read = mergeSettings(s).appearance;
    expect([read.wallpaper.kind, read.lookBefore?.wallpaper]).toEqual(["@dip497/live-scenes/koi", "@dip497/live-scenes/shoal"]);
    // Everything else as it was, the key this build does not read too.
    const back = structuredClone(s);
    back.appearance.wallpaper.kind = "koi";
    back.appearance.lookBefore.wallpaper = "shoal";
    expect(back).toEqual(BEFORE);
    expect(t.ledger().find((a) => a.id === ID)?.result).toEqual({ renamed: ["@dip497/live-scenes/koi", "@dip497/live-scenes/shoal"] });
    // The backup is the file as 0008 found it: restoring it gives back the old names.
    const backup = t.read(`migrations/backups/${ID}/settings.json`).appearance;
    expect([backup.wallpaper.kind, backup.lookBefore.wallpaper]).toEqual(["koi", "shoal"]);
  });

  test("a file naming none of them is left alone, with no backup", () => {
    t = new TestRoot(FIXTURE);
    const file = path.join(t.root, "settings.json");
    const mine = { ...BEFORE, appearance: { ...BEFORE.appearance, wallpaper: { kind: "@acme/hive/bees", brightness: 0.8 }, lookBefore: { glass: true, wallpaper: "aurora", radius: 6 } } };
    fs.writeFileSync(file, JSON.stringify(mine));
    t.runOnce();
    expect(t.read("settings.json")).toEqual(mine);
    expect(t.ledger().find((a) => a.id === ID)?.result).toEqual({ renamed: [] });
    expect(fs.existsSync(path.join(t.root, "migrations", "backups", ID))).toBe(false);
  });

  test("killed at 20 points and run again, it ends as a clean run does", async () => {
    t = new TestRoot(FIXTURE);
    const { clean, ends, cutOff } = await t.killedAndRunAgain(endState);
    expect(clean.settings.appearance.wallpaper.kind).toBe("@dip497/live-scenes/koi");
    for (const end of ends) expect(end).toEqual(clean);
    expect(cutOff).toBe(20);
  }, 240_000);
});
