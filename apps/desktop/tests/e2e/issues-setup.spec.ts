// A folder with no .hivemind: the empty canvas starts an agent, opens a folder or joins with a code,
// and says nothing about setting anything up. Issues are the Issues tool's: it offers to keep them
// in its folder, and once it has, they can be made, and an agent started there reads the hive skills
// as this app wrote them.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import { seedAgents } from "./helpers/agents";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_DIR = path.resolve(__dirname, "../..");

let app: ElectronApplication;
let page: Page;
let workspace: string;

test.beforeAll(async () => {
  // Bare folder — NO .hivemind/. Also no .git (so repoPath falls back to cwd).
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "hivemind-init-"));
  // Isolated userData so localStorage (hivemind:last-project) from other
  // runs doesn't bleed in and auto-reopen a stale workspace.
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), "hivemind-ud-"));
  // An installed Claude, so the empty canvas offers it.
  const xdg = path.join(userData, "config");
  const bin = path.join(userData, "bin");
  seedAgents(xdg, ["claude"]);
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, "claude"), "#!/bin/sh\n[ \"$1\" = --version ] && echo '2.0.0 (Claude Code)' && exit 0\nexec sleep 60\n", { mode: 0o755 });
  const env = { ...process.env, XDG_CONFIG_HOME: xdg, HIVEMIND_SHELL_ENV: "0", PATH: `${bin}${path.delimiter}${process.env.PATH}` } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    args: [
      path.join(APP_DIR, "out/main/index.js"),
      "--no-sandbox",
      `--user-data-dir=${userData}`,
    ],
    cwd: workspace,
    env,
  });
  page = await app.firstWindow();
  page.on("pageerror", (e) => console.log("[r.pageerror]", e.message));
  await page.waitForSelector(".react-flow", { timeout: 10_000 });
  await page.waitForTimeout(400);
});

test.afterAll(async () => {
  await app?.close();
  await fs.rm(workspace, { recursive: true, force: true }).catch(() => {/*ignored*/});
});

test("the empty canvas leads with a new agent, wearing its logo, and opens a folder; it sets nothing up", async () => {
  const empty = page.locator("[data-canvas-empty]");
  const agent = empty.locator("[data-canvas-empty-agent]");
  await expect(agent).toContainText("New agent");
  await expect(agent).toContainText("Claude");
  // Claude's own mark, a filled shape as its manifest draws it; the stand-in pen is an outline.
  await expect(agent.locator('svg[fill="currentColor"]')).toHaveCount(1);
  await expect(empty.getByRole("button", { name: "Open folder" })).toBeVisible();
  await expect(empty).not.toContainText(/initiali[sz]e/i);
  expect(fsSync.existsSync(path.join(workspace, ".hivemind"))).toBe(false);
  // Before any workspace, a code from elsewhere is entered from here.
  await empty.getByRole("button", { name: "Have a code? Join" }).click();
  await expect(page.locator("[data-join-link]")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-join-link]")).toHaveCount(0);
});

test("the Issues tool keeps issues in its folder when asked, and then its issues can be made", async () => {
  const tile = page.locator('[data-tool-plugin="@hivemind/issues"]');
  await expect.poll(async () => {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "issues" })));
    return tile.count();
  }, { timeout: 10_000 }).toBeGreaterThan(0);
  const setup = tile.locator("[data-issues-setup]");
  await expect(setup).toContainText(`Keep issues in ${path.basename(workspace)}`);
  await setup.locator("[data-issues-prefix]").fill("TST");
  await setup.locator("[data-issues-setup-go]").click();

  // Config file is written synchronously by the IPC handler — assert that
  // first to isolate IPC success from UI re-render.
  await expect.poll(
    async () =>
      fs.readFile(path.join(workspace, ".hivemind", "config.yaml"), "utf8").catch(() => ""),
    { timeout: 8_000 },
  ).toMatch(/prefix:\s*TST/);

  const cfg = await fs.readFile(path.join(workspace, ".hivemind", "config.yaml"), "utf8");
  expect(cfg).toMatch(/next_id:\s*1/);
  // Mirrored issues and sync state stay out of git, as `hive init` keeps them (design jira-sync §5.3).
  const gitignore = (await fs.readFile(path.join(workspace, ".gitignore"), "utf8")).split("\n");
  expect(gitignore).toContain(".hivemind/mirror/");
  expect(gitignore).toContain(".hivemind/sync/");

  // The tile is the issue list now, empty, and makes one.
  await expect(setup).toHaveCount(0);
  await tile.getByRole("button", { name: /New issue/ }).first().click();
  await expect(page.getByRole("heading", { name: "New issue" })).toBeVisible();
  await page.keyboard.type("First issue after init", { delay: 4 });
  await page.getByRole("button", { name: "Create issue" }).click();
  // The create dialog closes and the new issue opens in the issue dialog, so "no dialog at all"
  // never holds. Wait for the CREATE dialog's heading to go, then dismiss the issue dialog.
  await expect(page.getByRole("heading", { name: "New issue" })).toBeHidden({ timeout: 3_000 });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 3_000 });

  const md = await fs.readFile(path.join(workspace, ".hivemind", "issues", "TST-1.md"), "utf8");
  expect(md).toMatch(/id:\s*TST-1/);
  expect(md).toMatch(/title:\s*['"]?First issue after init/);
});

test("an agent started in the folder reads the hive skills it has as this app wrote them; one it lacks is not added", async () => {
  const skills = path.join(workspace, ".claude", "skills");
  const hivemind = path.join(skills, "hivemind", "SKILL.md");
  const current = await fs.readFile(hivemind, "utf8");
  // A copy an older app wrote, and one skill taken away.
  await fs.writeFile(hivemind, "---\nname: hivemind\ndescription: an older copy\n---\n");
  await fs.rm(path.join(skills, "hive-work"), { recursive: true });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:spawn-agent", { detail: { agent: "claude" } })));
  await expect.poll(() => fs.readFile(hivemind, "utf8"), { timeout: 20_000 }).toBe(current);
  expect(fsSync.existsSync(path.join(skills, "hive-work"))).toBe(false);
});

test("a project opened last and since moved or deleted opens as the folder the app was started in", async () => {
  const gone = path.join(os.tmpdir(), "hivemind-gone-project-that-was-never-there");
  expect(await page.evaluate((p) => window.hive.resolveProject(p), gone)).toMatchObject({ cwd: workspace });
});
