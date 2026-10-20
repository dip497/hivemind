// `hive guide`: an agent in a tile reads how to work here from the `hive` it runs, the same text
// `hive add skill` writes into a folder, whether or not anyone wrote it there.
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hive } from "./helpers.js";

test("hive guide agents prints the skill hive add skill writes; a topic there is none of is a usage error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hive-guide-"));
  try {
    expect(hive(["add", "skill"], { cwd: dir }).code).toBe(0);
    const written = fs.readFileSync(path.join(dir, ".claude", "skills", "hivemind", "SKILL.md"), "utf8");
    const guide = hive(["guide", "agents"], { cwd: os.tmpdir() });
    expect([guide.code, guide.stdout === written, guide.stdout.length > 1000]).toEqual([0, true, true]);
    const none = hive(["guide", "planets"]);
    expect([none.code, none.stdout, none.stderr]).toEqual([2, "", "error [USAGE] no guide planets: there are agents, work, browser, workflow\nfix: hive guide agents\n"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
