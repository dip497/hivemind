// Multi-workspace zones end to end, through the HIVEMIND_TEST_PICK_DIR seam (the native
// folder dialog can't be driven headless): launch on repo A, add a frame, bind it to
// repo B, and spawn an agent into it.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { seedAgents } from "./helpers/agents";

let app: ElectronApplication;
let page: Page;
let repoA: string;
let repoB: string;
let xdg: string;
let bin: string;

async function seedRepo(prefix: string, issueTitle: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `hm-ws-${prefix}-`));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir });
  git("init", "-q");
  git("config", "user.email", "e2e@test.dev");
  git("config", "user.name", "e2e");
  await fs.writeFile(path.join(dir, "README.md"), `# ${prefix}\n`, "utf8");
  await fs.mkdir(path.join(dir, ".hivemind", "issues"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".hivemind", "config.yaml"),
    `prefix: ${prefix}\nnext_id: 2\nagents: {}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, ".hivemind", "issues", `${prefix}-1.md`),
    `---\nid: ${prefix}-1\ntitle: "${issueTitle}"\nstate: todo\ncreated: 2026-05-22\nupdated: 2026-05-22\n---\n\n## Description\n${issueTitle}\n`,
    "utf8",
  );
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  return dir;
}

test.beforeAll(async () => {
  repoA = await seedRepo("AAA", "alpha-task");
  repoB = await seedRepo("BBB", "beta-task");
    // Own config dir: a view another spec persisted must not become this spec's startup view.
  xdg = await fs.mkdtemp(path.join(os.tmpdir(), "hm-ws-xdg-"));
  // spawn-agent must clear the installed check and start SOMETHING harmless: a stub agent,
  // kept first on PATH by skipping the login-shell env that would bury it.
  seedAgents(xdg);
  bin = await fs.mkdtemp(path.join(os.tmpdir(), "hm-ws-bin-"));
  await fs.writeFile(path.join(bin, "claude"), "#!/bin/sh\n[ \"$1\" = --version ] && echo '2.0.0 (Claude Code)'\nexec sleep 60\n", { mode: 0o755 });
  app = await electron.launch({
    args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox", `--user-data-dir=/tmp/hm-ws-ud-${Date.now()}`],
    cwd: repoA,
    env: {
      ...process.env, XDG_CONFIG_HOME: xdg, HIVEMIND_PTY_DAEMON: "0", HIVEMIND_TEST_PICK_DIR: repoB,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`, HIVEMIND_SHELL_ENV: "0",
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  // A COLD Electron boot — bundle parse, GPU init, first paint — behind every
  // other spec's launches. 15s was a bet on a quiet machine: when it lost, the
  // whole spec was reported as failing "at 0ms" with nothing to look at. Give
  // the boot real headroom and, if it still loses, say what the window actually
  // showed instead of just naming the selector.
  try {
    await page.waitForSelector(".react-flow", { timeout: 60_000 });
  } catch (e) {
    const seen = await page.evaluate(() => ({
      url: location.href,
      readyState: document.readyState,
      title: document.title,
      body: document.body?.innerText?.slice(0, 400) ?? null,
      roots: [...document.body?.children ?? []].map((el) => `${el.tagName}.${el.className}`).slice(0, 8),
    })).catch((probeError) => ({ probeFailed: String(probeError) }));
    throw new Error(`workspace-zones: the app never rendered .react-flow — window showed ${JSON.stringify(seen)}`, { cause: e });
  }
  await page.waitForTimeout(500);
});

test.afterAll(async () => {
  await app?.close();
  await fs.rm(repoA, { recursive: true, force: true }).catch(() => {});
  await fs.rm(repoB, { recursive: true, force: true }).catch(() => {});
  if (xdg) await fs.rm(xdg, { recursive: true, force: true }).catch(() => {});
  if (bin) await fs.rm(bin, { recursive: true, force: true }).catch(() => {});
});

test("a frame bound to workspace B is named after it, and an agent spawned while it is the only frame lands inside it", async () => {
  // 1. Add a frame.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:add-frame")));
  await page.waitForSelector(".react-flow__node-frame", { timeout: 6_000 });
  await page.waitForTimeout(300);

  // 2. Bind it to a workspace → pickProjectFolder returns repoB (seam).
  await page.locator('[aria-label="bind workspace"]').first().click();
  // Frame chip should now show repo B's name.
  await expect(page.locator(".react-flow__node-frame")).toContainText(path.basename(repoB), { timeout: 6_000 });

  // 3. frame = workspace: with a single frame, spawning goes straight into it
  //    (no picker until 2+ frames exist) → a claude tile lands INSIDE the frame.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:spawn-agent")));
  await page.waitForSelector(".react-flow__node-terminal", { timeout: 6_000 });

  // The spawn flies the camera to the new tile (400 ms), so both boxes are read at one
  // instant: read one call apart, they were taken under two camera positions, and a
  // terminal inside the frame could read as outside it.
  const [frameBox, termBox] = await page.evaluate(() =>
    [".react-flow__node-frame", ".react-flow__node-terminal"].map((selector) => {
      const { x, y, width } = document.querySelector(selector)!.getBoundingClientRect();
      return { x, y, width };
    }));
  // Terminal's top-left sits within the frame's bounds (it was placed at
  // frame.x+24, frame.y+48 and parented).
  expect(termBox!.x).toBeGreaterThanOrEqual(frameBox!.x - 4);
  expect(termBox!.y).toBeGreaterThanOrEqual(frameBox!.y - 4);
  expect(termBox!.x).toBeLessThan(frameBox!.x + frameBox!.width);
});
