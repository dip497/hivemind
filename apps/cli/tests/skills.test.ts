// `hive add skill`: the app owns the hive skills, so an older copy is replaced by this version's.
import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hive } from "./helpers";

test("hive add skill replaces an older copy of a hive skill and leaves a current one alone", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hive-skills-"));
  const file = path.join(repo, ".claude", "skills", "hivemind", "SKILL.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "---\nname: hivemind\ndescription: an older copy\n---\n");

  const first = hive(["add", "skill", "--json"], { cwd: repo });
  expect(first.code).toBe(0);
  expect((first.json as { data: { skills: string[] } }).data.skills.sort()).toEqual(["hive-browser", "hive-work", "hive-workflow", "hivemind"]);
  expect(fs.readFileSync(file, "utf8")).toContain("hive ctl sessions claude --json");

  const again = hive(["add", "skill", "--json"], { cwd: repo });
  expect((again.json as { data: { skills: string[] } }).data.skills).toEqual([]);
  fs.rmSync(repo, { recursive: true, force: true });
});
