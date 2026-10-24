/**
 * 0006 on the two folders a mac or Windows machine has (fixtures/0006/before): the notification
 * preferences in the app data folder's settings.json become the `notifications` section of the one
 * settings.json, the old blob leaves its file (kept in the backup), and the rest of both files
 * stays. One folder (Linux) moves nothing. Killed at 20 points and run again, it ends as a clean
 * run does.
 */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { files, TestRoot } from "./fixtures/runs.js";
import { restoreMigration } from "./manage.js";

const FIXTURE = path.join(import.meta.dir, "fixtures", "0006", "before");
const ID = "0006-notifications-into-settings";
let t: TestRoot;
afterEach(() => t.remove());

const readData = (rel: string) => JSON.parse(fs.readFileSync(path.join(t.data, rel), "utf8"));
function endState() {
  return { settings: t.read("settings.json"), old: readData("settings.json"), backup: files(path.join(t.data, "migrations", "backups", ID)) };
}

describe("notifications move into the one settings.json", () => {
  test("two folders: the section is the old blob, normalized, and the old file keeps the rest", () => {
    t = new TestRoot(FIXTURE, true);
    t.runOnce();
    const s = endState();
    expect(s.settings.notifications).toEqual({
      enabled: true,
      kinds: { needs: true, done: false, error: true },
      dnd: { enabled: true, start: "23:00", end: "06:30" },
      osPopups: false,
      inApp: true,
      sound: true,
      sounds: { needs: true, done: false, error: false },
      volume: 0.6,
      popupText: false,
    });
    // The rest of the one settings.json is as it was.
    expect([s.settings.appearance.preset, s.settings.views.defaultView, s.settings.profile.name]).toEqual(["nord", "windows", "Ada"]);
    expect(s.old).toEqual({ browserCdp: true });
    expect(s.backup).toEqual(files(path.join(FIXTURE, "data")));
  });

  test("a section someone already changed in the one settings.json wins", () => {
    t = new TestRoot(FIXTURE, true);
    const file = path.join(t.root, "settings.json");
    fs.writeFileSync(file, JSON.stringify({ ...t.read("settings.json"), notifications: { enabled: false } }));
    t.runOnce();
    expect(t.read("settings.json").notifications.enabled).toBe(false);
    expect(t.read("settings.json").notifications.kinds.done).toBe(true);
    expect(readData("settings.json")).toEqual({ browserCdp: true });
  });

  test("one folder: the blob is already the section, and stays; no backup, so restoring 0006 keeps a later change", async () => {
    t = new TestRoot(path.join(FIXTURE, "data"));
    const before = t.read("settings.json").notifications;
    t.runOnce();
    expect(t.ledger().find((a) => a.id === ID)?.result).toEqual({ moved: false, why: "one file" });
    // Other migrations rewrite the file; the section keeps every value it had.
    expect(t.read("settings.json").notifications).toMatchObject(before);
    expect(t.read("settings.json").browserCdp).toBe(true);
    expect(fs.existsSync(path.join(t.root, "migrations", "backups", ID))).toBe(false);
    const file = path.join(t.root, "settings.json");
    fs.writeFileSync(file, JSON.stringify({ ...t.read("settings.json"), appearance: { preset: "dracula" } }));
    expect((await restoreMigration(ID, { config: t.root, data: t.root })).restored).toEqual([ID]);
    expect(t.read("settings.json").appearance.preset).toBe("dracula");
  });

  test("killed at 20 points and run again, it ends as a clean run does", async () => {
    t = new TestRoot(FIXTURE, true);
    const { clean, ends, cutOff } = await t.killedAndRunAgain(endState);
    expect(clean.old).toEqual({ browserCdp: true });
    for (const end of ends) expect(end).toEqual(clean);
    expect(cutOff).toBe(20);
  }, 240_000);
});
