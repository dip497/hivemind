// The window's effects go through the host's intents (R7): each one it asks for leaves a line in
// the app's audit log, as the person's, naming what it acted on; what it only reads leaves none.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { seedAgents } from "./helpers/agents";

let app: ElectronApplication;
let page: Page;
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hm-window-audit-")));
const repo = path.join(root, "repo");
const xdg = path.join(root, "config");
seedAgents(xdg);
// A terminal's session lives in the daemon here, so it has an id the test can name (hm:<tile>).
const env = { ...process.env, XDG_CONFIG_HOME: xdg, HIVEMIND_PTY_DAEMON: "1" } as Record<string, string>;
const person = { kind: "person" };
/** What the audit log says was done, without when. */
const audited = (): Array<Record<string, unknown>> => {
  try {
    return fs.readFileSync(path.join(xdg, "hivemind-dev", "audit.jsonl"), "utf8").split("\n").filter(Boolean)
      .map((l) => { const { at: _at, ...rest } = JSON.parse(l); return rest; });
  } catch { return []; }
};

test.beforeAll(async () => {
  fs.mkdirSync(repo);
  execSync("git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m start", { cwd: repo });
  app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox"], cwd: repo, env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow");
});
test.afterAll(async () => {
  // This profile's daemon only, before the app closes (close waits on it), and again after it.
  const reap = () => { try { execSync(`pkill -f "out/main/pty-daemon.js ${xdg}/"`, { stdio: "ignore" }); } catch { /* none */ } };
  reap();
  const closed = await Promise.race([app?.close().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 10_000))]);
  if (!closed) { try { app?.process().kill("SIGKILL"); } catch { /* gone */ } }
  reap();
  fs.rmSync(root, { recursive: true, force: true });
});

test("each effect the window asks for is recorded as the person's, with what it acted on; what it reads is not", async () => {
  const before = audited().length;
  const done = await page.evaluate(async ({ repo }) => {
    const h = window.hive;
    const { root } = await h.initWorkspace(repo, "aud");
    await h.resolveProject(repo); // as the window does after it: the workspace is registered
    const first = await h.createIssue(root, { title: "first" });
    const second = await h.createIssue(root, { title: "second" });
    await h.updateIssueState(root, first.id, "in_progress");
    await h.commentOnIssue(root, first.id, "a note");
    await h.updateIssue(root, first.id, { title: "renamed" });
    await h.linkIssue(root, first.id, second.id, "blocks");
    await h.unlinkIssue(root, first.id, second.id);
    await h.deleteIssue(root, second.id);
    await h.fileWrite(repo, "a.txt", "hello");
    await h.gitStage(repo, ["a.txt"]);
    await h.gitUnstage(repo, ["a.txt"]);
    await h.gitStage(repo, ["a.txt"]);
    await h.gitCommit(repo, "add a");
    const wt = await h.worktreeCreate(repo, { branch: "audit-branch" });
    await h.worktreeRemove(repo, wt.path);
    await h.worktreePrune(repo);
    await h.reviewSave(repo, []);
    await h.settingsSet("agents.autoInstall", false);
    // Reads change nothing.
    await h.gitStatus(repo);
    await h.listIssues(root);
    await h.readIssue(root, first.id);
    await h.fileRead(repo, "a.txt");
    // One that is refused is recorded as asked, and as failed, with its code; the window is told why.
    const escaped = await h.fileWrite(repo, "../escaped.txt", "x").then(() => "written", () => "refused");
    const outside = await h.gitStage(repo, ["../escaped.txt"]).then(() => "staged", (e: Error) => e.message);
    return { first: first.id, second: second.id, worktree: wt.path, escaped, outside };
  }, { repo });
  expect(done.escaped).toBe("refused");
  expect(done.outside).toContain("path escapes repo: ../escaped.txt");

  expect(audited().slice(before)).toEqual([
    { actor: person, verb: "initWorkspace", target: repo, detail: "AUD", outcome: "ok" },
    { actor: person, verb: "issue.create", target: done.first, outcome: "ok" },
    { actor: person, verb: "issue.create", target: done.second, outcome: "ok" },
    { actor: person, verb: "issue.setState", target: done.first, detail: "in_progress", outcome: "ok" },
    { actor: person, verb: "issue.comment", target: done.first, outcome: "ok" },
    { actor: person, verb: "issue.update", target: done.first, outcome: "ok" },
    { actor: person, verb: "issue.link", target: `${done.first}->${done.second}`, detail: "blocks", outcome: "ok" },
    { actor: person, verb: "issue.unlink", target: `${done.first}->${done.second}`, outcome: "ok" },
    { actor: person, verb: "issue.delete", target: done.second, outcome: "ok" },
    { actor: person, verb: "file.write", target: path.join(repo, "a.txt"), outcome: "ok" },
    { actor: person, verb: "git.stage", target: repo, detail: "1 file", outcome: "ok" },
    { actor: person, verb: "git.unstage", target: repo, detail: "1 file", outcome: "ok" },
    { actor: person, verb: "git.stage", target: repo, detail: "1 file", outcome: "ok" },
    { actor: person, verb: "git.commit", target: repo, outcome: "ok" },
    { actor: person, verb: "worktree.create", target: repo, detail: "audit-branch", outcome: "ok" },
    { actor: person, verb: "worktree.remove", target: done.worktree, outcome: "ok" },
    { actor: person, verb: "worktree.prune", target: repo, outcome: "ok" },
    { actor: person, verb: "review.save", target: repo, outcome: "ok" },
    { actor: person, verb: "settings:set", target: "agents.autoInstall", outcome: "ok" },
    { actor: person, verb: "file.write", target: path.join(root, "escaped.txt"), outcome: "error", code: "BAD_REQUEST" },
    { actor: person, verb: "git.stage", target: repo, detail: "1 file", outcome: "error", code: "BAD_REQUEST" },
  ]);
});

test("a terminal the window starts is recorded, and so is its end; showing it again starts nothing", async () => {
  await page.mouse.move(900, 600);
  await page.keyboard.press("1");
  const tile = (await page.locator(".react-flow__node-terminal").first().getAttribute("data-id"))!;
  const started = () => audited().filter((l) => l.verb === "terminal.open" && l.target === tile);
  await expect.poll(started, { timeout: 20_000 }).toEqual([{ actor: person, verb: "terminal.open", target: tile, detail: expect.any(String), outcome: "ok" }]);
  // A second window shows the same session: it joins it, and starts nothing.
  await page.evaluate(() => window.hive.newWindow());
  await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(2);
  const second = app.windows().find((w) => w !== page)!;
  await second.waitForSelector(`.react-flow__node-terminal[data-id="${tile}"]`, { timeout: 20_000 });
  await second.close();
  expect(started()).toHaveLength(1);

  await page.evaluate((pty) => window.hive.ptyKill(pty), `hm:${tile}`);
  await expect.poll(() => audited().filter((l) => l.verb === "terminal.close"), { timeout: 10_000 }).toEqual([{ actor: person, verb: "terminal.close", target: tile, outcome: "ok" }]);
  // A window that follows an end already made (another window's, the control plane's) ends nothing.
  await page.evaluate((pty) => window.hive.ptyKill(pty), `hm:${tile}`);
  await page.waitForTimeout(300);
  expect(audited().filter((l) => l.verb === "terminal.close")).toHaveLength(1);
});
