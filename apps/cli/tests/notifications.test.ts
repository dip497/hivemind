/**
 * `hive notifications`: `set` takes each key with a value of its kind and writes the
 * `notifications` section the app reads, refusing a key or value that is not one; `play` and
 * `recent` with no app running say UNAVAILABLE with what to do; and an agent is refused set and
 * play, as the person's.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hive } from "./helpers.js";

let tmp: string;
let env: Record<string, string | undefined>;
const file = () => path.join(tmp, "hivemind", "settings.json");

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-notifications-"));
  env = { XDG_CONFIG_HOME: tmp, HIVEMIND_APP_DATA: path.join(tmp, "hivemind"), HIVE_SETTINGS: undefined, HIVE_HCP_SOCK: path.join(tmp, "no-app.sock"), HIVE_DRIVE_SOCK: path.join(tmp, "no-drive.sock") };
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("hive notifications", () => {
  test("set writes each key as the app reads it, and refuses a key or a value that is not one", () => {
    const good: [string, string, unknown][] = [
      ["sound", "on", true], ["sounds.done", "true", true], ["sounds.needs", "off", false], ["volume", "0.25", 0.25], ["volume", "80%", 0.8],
      ["popupText", "on", true], ["kinds.error", "false", false], ["dnd.start", "23:30", "23:30"], ["osPopups", "off", false],
    ];
    for (const [key, value, stored] of good) {
      const r = hive(["notifications", "set", key, value, "--json"], { env });
      expect([key, r.code, (r.json as { value: unknown }).value]).toEqual([key, 0, stored]);
    }
    const n = JSON.parse(fs.readFileSync(file(), "utf8")).notifications;
    expect([n.sound, n.sounds, n.volume, n.popupText, n.kinds.error, n.dnd.start, n.osPopups]).toEqual([true, { needs: false, done: true, error: false }, 0.8, true, false, "23:30", false]);
    expect((hive(["notifications", "show", "--json"], { env }).json as { volume: number }).volume).toBe(0.8);

    const bad: [string, string, string][] = [
      ["sounds.loud", "on", 'no notification setting "sounds.loud"'],
      ["sound", "yes", "sound is on or off"],
      ["volume", "1.5", "volume is from 0 to 1"],
      ["volume", "", "volume is from 0 to 1"],
      ["dnd.end", "7am", "dnd.end is a time of day as HH:MM"],
      // An object's own names only, never what every object inherits.
      ["toString", "12:00", 'no notification setting "toString"'],
      ["kinds.constructor", "off", 'no notification setting "kinds.constructor"'],
    ];
    for (const [key, value, why] of bad) {
      const r = hive(["notifications", "set", key, value, "--json"], { env });
      expect([key, r.code, JSON.parse(r.stderr).error.message]).toEqual([key, 2, expect.stringContaining(why)]);
    }
    // `hive config set` on the section is held to the same rules, a group's keys too.
    const viaConfig: [string, string, string][] = [
      ["notifications.volume", "2", "volume is from 0 to 1"],
      ["notifications.dnd", '{"start":"25:00"}', "dnd.start is a time of day as HH:MM"],
      ["notifications.sounds", '{"started":true}', 'no notification setting "sounds.started"'],
    ];
    for (const [key, value, why] of viaConfig) {
      const r = hive(["config", "set", key, value, "--json"], { env });
      expect([key, r.code, JSON.parse(r.stderr).error.message]).toEqual([key, 2, expect.stringContaining(why)]);
    }
    const stored = JSON.parse(fs.readFileSync(file(), "utf8")).notifications;
    expect([stored.volume, stored.dnd.start, stored.sounds.started, Object.hasOwn(stored, "toString")]).toEqual([0.8, "23:30", undefined, false]);
  });

  test("play and recent with no app running are UNAVAILABLE and say to open the app", () => {
    for (const args of [["play", "needs"], ["recent"]]) {
      const r = hive(["notifications", ...args, "--json"], { env });
      expect([args[0], r.code]).toEqual([args[0], 3]);
      expect(JSON.parse(r.stderr).error).toMatchObject({ code: "UNAVAILABLE", fix: expect.stringContaining("open the hivemind app") });
    }
  });

  test("an agent is refused set and play, and nothing is written", () => {
    const asAgent = { ...env, HCP_TOKEN: "t", HIVEMIND_TILE: "tile-1" };
    for (const args of [["set", "sound", "on"], ["play", "needs"]]) {
      const r = hive(["notifications", ...args, "--json"], { env: asAgent });
      expect([args[0], r.code, JSON.parse(r.stderr).error.code]).toEqual([args[0], 6, "PERSON_ONLY"]);
    }
    expect(fs.existsSync(file()) && JSON.parse(fs.readFileSync(file(), "utf8")).notifications?.sound).toBeFalsy();
    // `hive config set` is held to the same rule for this section.
    expect(hive(["config", "set", "notifications.sound", "true", "--json"], { env: asAgent }).code).toBe(6);
  });
});
