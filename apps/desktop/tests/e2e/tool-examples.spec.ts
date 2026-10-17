// The CI runs and Worktrees example tools, loaded into the real app. CI runs drives a `gh` on PATH
// that answers from files, so its list, a failed job's log and its rerun are checked without the
// network. Worktrees reads a repository with three worktrees and removes the one that loses nothing.
import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedAgents } from "./helpers/agents";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-tool-examples-"));
const xdg = path.join(root, "config");
seedAgents(xdg);
const repo = path.join(root, "repo");
const fakeGh = path.join(root, "gh");
// A worktree outside the main one's folder keeps its whole path.
const far = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hm-far-")), "far");
const env = { ...process.env, XDG_CONFIG_HOME: xdg, HIVEMIND_SHELL_ENV: "0", PATH: `${fakeGh}${path.delimiter}${process.env.PATH}` } as Record<string, string>;
delete env.ELECTRON_RUN_AS_NODE;
const cli = path.resolve(process.cwd(), "../cli/src/index.ts");
const examples = path.resolve(process.cwd(), "../../examples/tools");
let hcp: Record<string, string> = {};
const hive = (...args: string[]) => {
  const result = spawnSync("bun", [cli, ...args, "--json"], { cwd: repo, env: { ...env, ...hcp }, encoding: "utf8" });
  if (!result.stdout.trim()) throw new Error(result.stderr);
  return { status: result.status, data: JSON.parse(result.stdout) };
};
const git = (cmd: string, cwd = repo) => execSync(`git -c user.email=t@t -c user.name=t ${cmd}`, { cwd, encoding: "utf8" });

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  fs.mkdirSync(repo, { recursive: true });
  execSync("git init -q -b main", { cwd: repo });
  fs.writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
  git("add -A");
  git("commit -q -m 'first change'");
  git(`worktree add -q -b done ${path.join(root, "wt-merged")}`);
  git(`worktree add -q -b feat ${path.join(root, "wt-work")}`);
  git(`worktree add -q -b far ${far}`);
  fs.writeFileSync(path.join(far, "new.txt"), "not committed\n");
  const work = path.join(root, "wt-work");
  fs.appendFileSync(path.join(work, "a.ts"), "export const committed = 2;\n");
  git("commit -q -am 'feat: committed'", work);
  fs.appendFileSync(path.join(work, "a.ts"), "export const uncommitted = 3;\n");

  fs.mkdirSync(fakeGh);
  fs.writeFileSync(path.join(fakeGh, "runs.json"), JSON.stringify([
    { databaseId: 101, displayTitle: "fix: the build", headBranch: "main", status: "completed", conclusion: "failure", workflowName: "CI", createdAt: new Date().toISOString(), event: "push", url: "https://example.test/runs/101" },
    { databaseId: 100, displayTitle: "docs: a typo", headBranch: "main", status: "completed", conclusion: "success", workflowName: "CI", createdAt: new Date().toISOString(), event: "push", url: "https://example.test/runs/100" },
  ]));
  fs.writeFileSync(path.join(fakeGh, "jobs.json"), JSON.stringify({ jobs: [
    { databaseId: 7, name: "lint", status: "completed", conclusion: "success", steps: [{ number: 1, name: "Lint", status: "completed", conclusion: "success" }] },
    { databaseId: 8, name: "typecheck", status: "completed", conclusion: "failure", steps: [{ number: 1, name: "Typecheck", status: "completed", conclusion: "failure" }] },
  ] }));
  const setup = Array.from({ length: 300 }, (_, i) => `typecheck\tUNKNOWN STEP\t2026-10-07T10:00:00.0000000Z setting up ${i}`);
  const cleanup = Array.from({ length: 300 }, (_, i) => `typecheck\tUNKNOWN STEP\t2026-10-07T10:00:02.0000000Z cleaning up ${i}`);
  fs.writeFileSync(path.join(fakeGh, "log.txt"), [
    ...setup,
    "typecheck\tTypecheck\t2026-10-07T10:00:01.0000000Z src/a.ts(1,1): error TS2345: boom",
    "typecheck\tTypecheck\t2026-10-07T10:00:01.0000000Z ##[error]Process completed with exit code 2.",
    ...cleanup, "",
  ].join("\n"));
  fs.writeFileSync(path.join(fakeGh, "gh"), [
    "#!/bin/sh",
    `d='${fakeGh}'`,
    'case "$1 $2" in',
    '  "run list") cat "$d/runs.json" ;;',
    '  "run view") if [ "$3" = "--job" ]; then sleep 1; cat "$d/log.txt"; else cat "$d/jobs.json"; fi ;;',
    '  "run rerun"|"run cancel") echo "$@" >> "$d/calls" ;;',
    '  *) echo "unexpected: $*" >&2; exit 1 ;;',
    "esac",
  ].join("\n"), { mode: 0o755 });
  // An agent to send to: what the app starts as `claude`, waiting on its input.
  fs.writeFileSync(path.join(fakeGh, "claude"), "#!/bin/sh\nexec cat\n", { mode: 0o755 });

  for (const name of ["ci-runs", "worktrees"]) {
    expect(hive("tools", "install", path.join(examples, name)).status).toBe(0);
    expect(hive("plugins", "enable", `tool:dip497/${name}`).status).toBe(0);
  }
  await launch();
});

async function launch(): Promise<void> {
  app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox"], cwd: repo, env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
  const userData = path.join(xdg, "hivemind-dev");
  await expect.poll(() => fs.existsSync(path.join(userData, "hcp.token"))).toBe(true);
  hcp = { HIVEMIND_APP_DATA: userData };
}
test.afterAll(async () => {
  await app?.close();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(path.dirname(far), { recursive: true, force: true });
});

const tile = (id: string) => page.locator(`[data-tool-plugin="${id}"]`);
/** Bring a tile into view, as clicking it in Layers does. */
const focus = async (el: Locator) => {
  const id = await el.evaluate((n) => n.closest(".react-flow__node")?.getAttribute("data-id"));
  await page.evaluate((t) => window.dispatchEvent(new CustomEvent("hivemind:focus-tile", { detail: t })), id);
  await page.waitForTimeout(400);
};
// The diff view draws inside shadow roots: read the text through them.
const deepText = (el: Locator) => () => el.evaluate((n) => {
  const walk = (x: Element | ShadowRoot): string => [...x.children].map((c) => (c.shadowRoot ? walk(c.shadowRoot) : "") + (c.children.length ? walk(c) : c.textContent ?? "")).join(" ");
  return walk(n);
});

test("CI runs lists the runs, shows a failed job's lines, and reruns the failed jobs", async () => {
  expect(hive("ctl", "open-tool", "dip497/ci-runs/runs").status).toBe(0);
  const ci = tile("dip497/ci-runs");
  await expect(ci).toContainText("fix: the build", { timeout: 20_000 });
  await expect(ci).toContainText("docs: a typo");
  await ci.locator('[data-run="101"]').click();
  // While its log is on its way, a spinner says so in the middle of where it will be.
  const waiting = ci.locator("[data-log-box] [data-loading]");
  await expect(waiting).toHaveText("Loading the log");
  const [spin, box] = await Promise.all([waiting.locator("svg").boundingBox(), ci.locator("[data-log-box]").boundingBox()]);
  expect(Math.abs(spin!.x + spin!.width / 2 - (box!.x + box!.width / 2))).toBeLessThan(2);
  expect(Math.abs(spin!.y + spin!.height / 2 - (box!.y + box!.height / 2))).toBeLessThan(box!.height / 4);
  // The failed job is the one chosen, and its failed lines are shown under its step.
  await expect(ci.locator("[data-log]")).toContainText("error TS2345: boom");
  await expect(ci.locator("[data-log]")).toContainText("── Typecheck");
  // A long log opens at its first error line, marked, not at its top or its cleanup.
  await expect(ci.locator("[data-error]")).toHaveText("Process completed with exit code 2.");
  await expect(ci.locator("[data-error]")).toBeInViewport();
  await expect(ci.locator("[data-log]").getByText("setting up 0", { exact: true })).not.toBeInViewport();
  await expect(ci.locator("[data-log]").getByText("cleaning up 299", { exact: true })).not.toBeInViewport();
  await expect(ci).toContainText("Failed at: Typecheck");
  await expect(ci.getByRole("button", { name: "Ask an agent to fix" })).toBeVisible();
  await ci.getByRole("button", { name: "Rerun failed" }).click();
  await expect.poll(() => fs.readFileSync(path.join(fakeGh, "calls"), "utf8").trim()).toBe("run rerun 101 --failed");
  // A job that passed shows its steps, and offers no fix.
  await ci.locator('[data-job="lint"]').click();
  await expect(ci).toContainText("passed · 1 steps");
  await expect(ci.getByRole("button", { name: "Ask an agent to fix" })).toHaveCount(0);
});

test("Worktrees shows each worktree's state, its diffs, and removes only one that loses nothing", async () => {
  expect(hive("ctl", "open-tool", "dip497/worktrees/worktrees").status).toBe(0);
  const wt = tile("dip497/worktrees");
  const row = (name: string) => wt.locator(`[data-worktree="${name}"]`);
  await expect(row("wt-work")).toContainText("1 uncommitted", { timeout: 20_000 });
  await expect(row("wt-work")).toContainText("↑1");
  await expect(row("wt-work")).not.toContainText("merged");
  await expect(row("wt-merged")).toContainText("merged");
  await expect(row("repo")).toContainText("main worktree");
  await expect(row(far)).toContainText("1 uncommitted");

  await row("wt-work").click();
  await expect.poll(deepText(wt), { timeout: 15_000 }).toContain("uncommitted = 3");
  await wt.getByRole("button", { name: /^Branch vs main/ }).click();
  await expect.poll(deepText(wt), { timeout: 15_000 }).toContain("committed = 2");
  await expect(wt.getByRole("button", { name: "Remove" })).toHaveCount(0);

  await wt.getByRole("button", { name: /^Merged/ }).click();
  await expect(wt.locator("[data-worktree]")).toHaveCount(1);
  await row("wt-merged").click();
  await wt.getByRole("button", { name: "Remove" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
  await expect.poll(() => fs.existsSync(path.join(root, "wt-merged"))).toBe(false);
  await expect.poll(() => git("branch --list done").trim()).toBe("");
  await expect(wt.locator("[data-worktree]")).toHaveCount(0);
  expect(fs.existsSync(path.join(root, "wt-work"))).toBe(true);
});

test("the Add menu offers every tool beside the widgets, by category, found by search, on the Layers panel's material", async () => {
  await page.locator('[data-toolbar-action="board"]').first().click();
  const menu = page.locator("[data-add-menu]");
  await expect(menu.locator('[data-add-category="git"]')).toContainText("Worktrees");
  await expect(menu.locator('[data-add-category="monitoring"]')).toContainText("CI runs");
  await expect(menu.locator('[data-add-category="productivity"]')).toContainText("Sticky note");
  // It is a dialog on the app's opaque sheet: the board never reads through it.
  await expect(menu).toHaveAttribute("role", "dialog");
  expect(await menu.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toMatch(/^transparent$|^rgba\(.*, 0(\.\d+)?\)$/);
  // Its tabs show one type at a time.
  await menu.locator('[data-add-tab="tool"]').click();
  await expect(menu).toContainText("Worktrees");
  await expect(menu).not.toContainText("Sticky note");
  await menu.locator('[data-add-tab="widget"]').click();
  await expect(menu).toContainText("Sticky note");
  await expect(menu).not.toContainText("Worktrees");
  await menu.locator('[data-add-tab="all"]').click();
  // Its side panel shows one category at a time, with how many each has.
  await expect(menu.locator('[data-add-shelf="git"]')).toContainText("1");
  await menu.locator('[data-add-shelf="git"]').click();
  await expect(menu.locator("[data-board-choice]")).toHaveText([/Worktrees/]);
  await menu.locator('[data-add-shelf="all"]').click();
  // A tool's icon is the .svg it ships, drawn in the menu's text colour.
  expect(await menu.locator('[data-board-choice="tile:ci-runs"] span[aria-hidden]').first().evaluate((el) => getComputedStyle(el).maskImage)).toContain("data:image/svg+xml");
  await menu.getByRole("textbox").focus();
  await page.keyboard.type("work");
  await expect(menu.locator("[data-board-choice]")).toHaveText([/Worktrees/]);
  // A tool opens from it as from a frame's Open menu.
  await page.keyboard.press("Control+A");
  await page.keyboard.type("code");
  await expect(page.locator(".react-flow__node-workbench")).toHaveCount(0);
  await menu.locator('[data-board-choice="tile:editor"]').click();
  await expect(menu).toHaveCount(0);
  await expect(page.locator(".react-flow__node-workbench")).toHaveCount(1);
});

test("text sent to an agent asks which one: agents by frame, searchable, a new one below, chosen by keyboard", async () => {
  expect(hive("ctl", "spawn", "--agent", "claude", "--name", "first").status).toBe(0);
  const second = hive("ctl", "spawn", "--agent", "claude", "--name", "second").data.tile as string;
  await page.evaluate(() => {
    (window as unknown as { sentTo?: string }).sentTo = undefined;
    window.addEventListener("hivemind:send-to-agent", (e) => { (window as unknown as { sentTo?: string }).sentTo = (e as CustomEvent<{ target: string }>).detail.target; });
  });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:deliver-to-agent", { detail: { text: "Fix the failing test in src/a.ts" } })));
  const picker = page.getByRole("dialog", { name: "Send to agent" });
  await expect(picker).toContainText("Fix the failing test in src/a.ts");
  await expect(picker.locator("[data-picker-row]")).toHaveText([/first/, /second/, /New Claude/i]);
  // Opaque, as a modal is: the board never reads through what it asks.
  expect(await picker.evaluate((el) => el.classList.contains("hm-surface-3"))).toBe(true);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(picker).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { sentTo?: string }).sentTo)).toBe(second);
});

test("a tool's tile keeps what it showed: what was chosen, its filter and its tab are there after the app restarts", async () => {
  let wt = tile("dip497/worktrees");
  let ci = tile("dip497/ci-runs");
  await focus(wt);
  await wt.getByRole("button", { name: /^Uncommitted \d/ }).first().click();
  await wt.locator('[data-worktree="wt-work"]').click();
  await wt.getByRole("button", { name: /^Branch vs main/ }).click();
  await focus(ci);
  await ci.locator('[data-run="100"]').click();
  await ci.locator('[data-run="101"]').click();
  await ci.locator('[data-job="lint"]').click();
  await page.waitForTimeout(600); // what a tile saves is written a moment after its last change
  await app.close();
  await launch();
  wt = tile("dip497/worktrees");
  ci = tile("dip497/ci-runs");
  await expect(wt.locator('[data-worktree="wt-work"]')).toHaveAttribute("aria-current", "true", { timeout: 20_000 });
  await expect(wt.getByRole("button", { name: /^Uncommitted \d/ }).first()).toHaveAttribute("aria-pressed", "true");
  await expect(wt.getByRole("button", { name: /^Branch vs main/ })).toHaveAttribute("aria-pressed", "true");
  await expect(ci.locator('[data-run="101"]')).toHaveAttribute("aria-current", "true");
  await expect(ci.locator('[data-job="lint"]')).toHaveAttribute("aria-pressed", "true");
});
