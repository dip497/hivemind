// `hive add skill`: the app owns the hive skills, so an older copy is replaced by this version's.
import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
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
  expect((first.json as { skills: string[] }).skills.sort()).toEqual(["hive-browser", "hive-work", "hive-workflow", "hivemind"]);
  expect(fs.readFileSync(file, "utf8")).toContain("hive ctl sessions claude --json");

  const again = hive(["add", "skill", "--json"], { cwd: repo });
  expect((again.json as { skills: string[] }).skills).toEqual([]);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("hive add skill installs the skills of the tool plugins on for this workspace, out of git status, and takes them away when the plugin is off", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hive-plugin-skills-")));
  const env = { XDG_CONFIG_HOME: path.join(tmp, "config"), HIVE_SETTINGS: undefined, HIVE_HCP_SOCK: path.join(tmp, "no-app.sock"), HIVE_DRIVE_SOCK: path.join(tmp, "no-drive.sock") };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: ws, encoding: "utf8" });
  const tool = (name: string, extra: object) => {
    const dir = path.join(tmp, name);
    fs.mkdirSync(path.join(dir, "skills", name), { recursive: true });
    fs.writeFileSync(path.join(dir, "hivemind-tool.json"), JSON.stringify({ id: `@ada/${name}`, name, version: "1.0.0", apiVersion: 1, entry: "index.js", tools: [{ key: name, label: name, tileKind: `ada-${name}` }], skills: [`skills/${name}`], ...extra }));
    fs.writeFileSync(path.join(dir, "index.js"), "export default { tiles: {} };\n");
    fs.writeFileSync(path.join(dir, "service.js"), "\n");
    fs.writeFileSync(path.join(dir, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} work\n---\n`);
    return dir;
  };
  const ws = path.join(tmp, "ws");
  fs.mkdirSync(ws);
  git("init", "-q");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  const run = (...args: string[]) => hive([...args, "--json"], { cwd: ws, env });
  const added = (cwd = ws) => (hive(["add", "skill", "--json"], { cwd, env }).json as { pluginSkills: Record<string, unknown[]> }).pluginSkills;
  try {
    expect(run("plugins", "install", tool("prs", {})).code).toBe(0);
    expect(run("plugins", "install", tool("sync", { service: { command: ["node", "service.js"], role: "agents" } })).code).toBe(0);
    // Installed but off: nothing of it is written.
    expect(added()).toMatchObject({ installed: [] });

    expect(run("plugins", "enable", "@ada/prs").code).toBe(0);
    expect(run("plugins", "enable", "@ada/sync").code).toBe(0);
    // On, but a plugin with a service brings its skills only where its service drives.
    expect(added()).toMatchObject({ installed: ["prs"] });
    expect(run("plugins", "workspaces", "@ada/sync", ws).code).toBe(0);
    expect(added()).toMatchObject({ installed: ["sync"] });
    expect(fs.readdirSync(path.join(ws, ".claude", "skills")).sort()).toEqual(["hive-browser", "hive-work", "hive-workflow", "hivemind", "prs", "sync"]);
    expect(git("status", "--porcelain", "--untracked-files=all")).not.toMatch(/skills\/(prs|sync)/);
    // A linked worktree of the workspace its service drives is where an agent works an issue.
    const wt = path.join(tmp, "wt");
    git("worktree", "add", "-q", "-b", "feat", wt);
    expect(added(wt)).toMatchObject({ installed: ["prs", "sync"] });
    expect(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: wt, encoding: "utf8" })).not.toMatch(/skills\/(prs|sync)/);

    expect(run("plugins", "disable", "@ada/prs").code).toBe(0);
    // Off, its folder waits for the next install to take it away, still out of git status.
    expect(git("status", "--porcelain", "--untracked-files=all")).not.toMatch(/skills\/(prs|sync)/);
    expect(added()).toMatchObject({ removed: ["prs"] });
    expect(fs.existsSync(path.join(ws, ".claude", "skills", "prs"))).toBe(false);
    expect(git("status", "--porcelain", "--untracked-files=all")).not.toMatch(/skills\/(prs|sync)/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}, 60_000);

test("hive plugins check reports a skill whose SKILL.md names another skill", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hive-check-skill-"));
  try {
    fs.mkdirSync(path.join(dir, "skills", "prs"), { recursive: true });
    fs.writeFileSync(path.join(dir, "hivemind-tool.json"), JSON.stringify({ id: "@ada/prs", name: "prs", version: "1.0.0", apiVersion: 1, entry: "index.js", tools: [{ key: "prs", label: "prs", tileKind: "ada-prs" }], skills: ["skills/prs"] }));
    fs.writeFileSync(path.join(dir, "index.js"), "export default { tiles: {} };\n");
    fs.writeFileSync(path.join(dir, "skills", "prs", "SKILL.md"), "---\nname: pr\ndescription: x\n---\n");
    const r = hive(["plugins", "check", dir, "--json"], { cwd: dir });
    expect(r.code).toBe(1);
    expect((r.json as { problems: { step: string; message: string }[] }).problems).toContainEqual(
      expect.objectContaining({ step: "manifest", message: expect.stringContaining("frontmatter says name: pr, not prs") }),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
