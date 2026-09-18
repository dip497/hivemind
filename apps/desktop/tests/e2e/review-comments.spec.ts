import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { seedAgents } from "./helpers/agents";

// The seam this covers: review comments live in the workspace, not in this
// renderer, so an agent can answer one. If the store ever moves back behind
// localStorage, the CLI half of the loop goes dark and this fails.
let app: ElectronApplication;
let page: Page;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-review-e2e-"));
const repo = path.join(root, "repo");
const xdg = path.join(root, "config");
seedAgents(xdg);
const env = { ...process.env, XDG_CONFIG_HOME: xdg } as Record<string, string>;
const cli = path.resolve(process.cwd(), "../cli/src/index.ts");
const hive = (...args: string[]) =>
  JSON.parse(execFileSync("bun", [cli, ...args, "--json"], { env, cwd: repo, encoding: "utf8" }));

test.beforeAll(async () => {
  fs.mkdirSync(path.join(repo, ".hivemind"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "a.ts"), "const x = 1\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });
  app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox"], cwd: root, env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow");
});

test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

test("a comment left in the app is one an agent can list, answer and resolve", async () => {
  const ids = await page.evaluate(async (repoPath) => {
    await window.hive.reviewSave(repoPath, [{
      id: "c-ui", file: "a.ts", startLine: 1, endLine: 1, side: "additions",
      body: "this leaks", author: "dipendra", at: new Date().toISOString(),
    }]);
    return (await window.hive.reviewList(repoPath)).map((c) => c.id);
  }, repo);
  expect(ids).toEqual(["c-ui"]);
  // It is workspace state, not renderer state.
  expect(fs.existsSync(path.join(repo, ".hivemind/review.json"))).toBe(true);

  expect(hive("review", "list").data.map((c: { id: string }) => c.id)).toEqual(["c-ui"]);
  expect(hive("review", "reply", "c-ui", "fixed in abc123").ok).toBe(true);
  expect(hive("review", "resolve", "c-ui", "--summary", "fixed").data.resolved).toBe(true);
  // Resolved drops out of the default list, and the reply is visible to the app.
  expect(hive("review", "list").data).toEqual([]);
  const seen = await page.evaluate((repoPath) => window.hive.reviewList(repoPath), repo);
  expect(seen[0]?.replies?.[0]?.body).toBe("fixed in abc123");
  expect(seen[0]?.resolved).toBe(true);
});
