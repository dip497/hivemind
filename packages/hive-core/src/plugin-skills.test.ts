// A tool plugin's agent skills land in a workspace's .claude/skills/, inside the person's git work
// tree: hive writes, updates and removes only the folders it wrote, never one the person wrote or
// changed, and none of it ever shows in `git status`, in a clone or in a linked worktree of it.
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncPluginSkills, type PluginSkillSource } from "./plugin-skills.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const temp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hm-plugin-skills-"))); dirs.push(d); return d; };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const status = (cwd: string) => git(cwd, "status", "--porcelain", "--untracked-files=all");

/** A clone with one commit, its info/exclude holding a line of the person's own. */
function repo(): string {
  const dir = temp();
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "README.md"), "hi\n");
  fs.appendFileSync(path.join(dir, ".git", "info", "exclude"), "/mine.log\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  return dir;
}

/** A plugin folder shipping the skill `jira`, its SKILL.md saying `body`. */
function plugin(body: string, id = "@acme/jira"): PluginSkillSource {
  const dir = temp();
  fs.mkdirSync(path.join(dir, "skills", "jira", "refs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "skills", "jira", "SKILL.md"), `---\nname: jira\ndescription: Jira work\n---\n${body}\n`);
  fs.writeFileSync(path.join(dir, "skills", "jira", "refs", "records.md"), "record format\n");
  return { plugin: id, version: "1.0.0", dir, skills: ["skills/jira"] };
}
const skill = (ws: string) => path.join(ws, ".claude", "skills", "jira", "SKILL.md");

const PLACES: { name: string; workspace: () => { ws: string; clone: string } }[] = [
  { name: "a clone", workspace: () => { const clone = repo(); return { ws: clone, clone }; } },
  { name: "a workspace in a subfolder of a clone", workspace: () => {
    const clone = repo();
    fs.mkdirSync(path.join(clone, "app"));
    return { ws: path.join(clone, "app"), clone };
  } },
  { name: "a linked worktree", workspace: () => {
    const clone = repo();
    const ws = path.join(temp(), "wt");
    git(clone, "worktree", "add", "-q", "-b", "feat", ws);
    return { ws, clone };
  } },
];

for (const place of PLACES) {
  test(`in ${place.name}, installing, updating and removing a plugin skill never shows in git status`, async () => {
    const { ws, clone } = place.workspace();
    const v1 = plugin("version one");
    expect(await syncPluginSkills(ws, [v1])).toMatchObject({ installed: ["jira"] });
    expect(fs.readFileSync(skill(ws), "utf8")).toContain("version one");
    expect(fs.readFileSync(path.join(ws, ".claude", "skills", "jira", "refs", "records.md"), "utf8")).toBe("record format\n");
    expect(status(ws)).toBe("");
    expect(status(clone)).toBe("");

    fs.writeFileSync(path.join(v1.dir, "skills", "jira", "SKILL.md"), "---\nname: jira\ndescription: Jira work\n---\nversion two\n");
    expect(await syncPluginSkills(ws, [v1])).toMatchObject({ updated: ["jira"], kept: [] });
    expect(fs.readFileSync(skill(ws), "utf8")).toContain("version two");
    expect(status(ws)).toBe("");
    expect(await syncPluginSkills(ws, [v1])).toEqual({ installed: [], updated: [], removed: [], kept: [], refused: [] });

    // The plugin is off (or gone): its folder goes, and so does its line in info/exclude.
    expect(await syncPluginSkills(ws, [])).toMatchObject({ removed: ["jira"] });
    expect(fs.existsSync(path.dirname(skill(ws)))).toBe(false);
    expect(status(ws)).toBe("");
    const exclude = fs.readFileSync(path.join(clone, ".git", "info", "exclude"), "utf8");
    expect(exclude).not.toContain("skills/jira");
    expect(exclude).toContain("/mine.log");
  });
}

test("a plugin skill the person edited is neither updated nor removed, and the report says so", async () => {
  const ws = repo();
  const p = plugin("version one");
  await syncPluginSkills(ws, [p]);
  fs.writeFileSync(skill(ws), "---\nname: jira\ndescription: mine now\n---\nmy edits\n");

  fs.writeFileSync(path.join(p.dir, "skills", "jira", "SKILL.md"), "---\nname: jira\ndescription: Jira work\n---\nversion two\n");
  const update = await syncPluginSkills(ws, [p]);
  expect(update.updated).toEqual([]);
  expect(update.kept).toEqual([{ name: "jira", plugin: "@acme/jira", why: expect.stringContaining("changed since hive installed it") }]);
  expect(fs.readFileSync(skill(ws), "utf8")).toContain("my edits");

  const off = await syncPluginSkills(ws, []);
  expect(off.removed).toEqual([]);
  expect(off.kept.map((k) => k.name)).toEqual(["jira"]);
  expect(fs.readFileSync(skill(ws), "utf8")).toContain("my edits");
  // Still hive's folder, so still out of git status.
  expect(status(ws)).toBe("");
});

test("a skill of the person's with the plugin skill's name is never touched, whether in git or not, and the install is refused by name", async () => {
  const ws = repo();
  fs.mkdirSync(path.dirname(skill(ws)), { recursive: true });
  fs.writeFileSync(skill(ws), "---\nname: jira\ndescription: my own\n---\n");
  const r = await syncPluginSkills(ws, [plugin("the plugin's")]);
  expect(r.installed).toEqual([]);
  expect(r.refused).toEqual([{ name: "jira", plugin: "@acme/jira", why: expect.stringContaining(".claude/skills/jira is a skill hive did not install") }]);
  expect(fs.readFileSync(skill(ws), "utf8")).toContain("my own");
  expect(fs.readdirSync(path.dirname(skill(ws)))).toEqual(["SKILL.md"]);
  // Theirs stays visible to git: hive hides only what it wrote.
  expect(status(ws)).toContain(".claude/skills/jira/SKILL.md");

});

test("a plugin skill the person committed is theirs from then on: never updated or removed", async () => {
  const ws = repo();
  const p = plugin("version one");
  await syncPluginSkills(ws, [p]);
  git(ws, "add", "-f", ".claude");
  git(ws, "commit", "-qm", "keep the jira skill");
  fs.writeFileSync(path.join(p.dir, "skills", "jira", "SKILL.md"), "---\nname: jira\ndescription: Jira work\n---\nversion two\n");
  expect((await syncPluginSkills(ws, [p])).refused.map((x) => x.name)).toEqual(["jira"]);
  expect((await syncPluginSkills(ws, [])).removed).toEqual([]);
  expect(fs.readFileSync(skill(ws), "utf8")).toContain("version one");
  expect(status(ws)).toBe("");
});

test("outside a git work tree the skill is installed and removed all the same", async () => {
  const ws = temp();
  expect((await syncPluginSkills(ws, [plugin("x")])).installed).toEqual(["jira"]);
  expect((await syncPluginSkills(ws, [])).removed).toEqual(["jira"]);
});
