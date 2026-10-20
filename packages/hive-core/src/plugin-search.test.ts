// The search HiveHub, the app and `hive plugins search` share, on entries as HiveHub lists them.
import { expect, test } from "bun:test";
import { searchPlugins, textMatches } from "./plugin-search";

const HUB = [
  { id: "claude", name: "Claude", description: "Anthropic's Claude Code, with approvals, status and session resume wired into Hivemind.", category: "agents", installs: 50 },
  { id: "droid", name: "Droid", description: "Factory's Droid, with approvals, status and session resume wired into Hivemind.", category: "agents", installs: 17 },
  { id: "aider", name: "Aider", description: "AI pair programming in your terminal, with git built in.", category: "agents", installs: 5 },
  { id: "kiro", name: "Kiro", description: "Kiro's CLI agent, with approvals and status wired into Hivemind.", category: "agents", installs: 3 },
  { id: "dip497/git-history", name: "Git history", description: "The repository's commits: search them, read each one's diff, and ask an agent to explain one.", category: "git", installs: 1 },
  { id: "dip497/github-prs", name: "Pull requests", description: "The repository's GitHub pull requests: read the conversation and the diff, comment, approve or merge.", category: "git", installs: 1 },
  { id: "dip497/flaky-tests", name: "Flaky tests", description: "Runs the tests several times and shows each test's pass rate; the ones that pass only sometimes are flaky, and an agent can fix one.", category: "code", installs: 0 },
  { id: "@dip497/progress", name: "Progress", description: "A task's steps, kept by the agents doing it: they add steps and tick them off while you watch.", category: "agents", installs: 0 },
];
const ids = (q: string) => searchPlugins(HUB, q).map((p) => p.id);

test("every word must start a word of the plugin, in any order", () => {
  expect(ids("git pr")).toEqual(["dip497/github-prs", "aider"]);
  expect(ids("tests flaky")).toEqual(["dip497/flaky-tests"]);
  expect(ids("GIT   History")).toEqual(["dip497/git-history"]);
});

test("a word inside another word is no match: \"pr\" does not find approvals", () => {
  expect(ids("pr")).not.toContain("claude");
  expect(ids("pr")).not.toContain("droid");
  expect(ids("pr")).not.toContain("kiro");
});

test("the closest match comes first: \"pr\" puts Pull requests before Progress, and the name before the description", () => {
  expect(ids("pr")).toEqual(["dip497/github-prs", "@dip497/progress", "aider"]);
  expect(ids("git")[0]).toBe("dip497/git-history");
});

test("a category is matched by its label, and an empty search keeps everything, most installed first", () => {
  expect(ids("monitoring")).toEqual([]);
  expect(ids("code")).toContain("dip497/flaky-tests");
  expect(ids("")).toEqual(["claude", "droid", "aider", "kiro", "dip497/git-history", "dip497/github-prs", "dip497/flaky-tests", "@dip497/progress"]);
});

test("a list that keeps its own order is filtered by the same rule", () => {
  expect(textMatches("tests flaky", "Flaky tests Runs the tests")).toBe(true);
  expect(textMatches("pr", "Claude approvals")).toBe(false);
});
