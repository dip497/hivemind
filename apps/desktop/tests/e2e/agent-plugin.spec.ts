// Disk → main → manifests over IPC → renderer rebuilds the catalog.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

test.use({ trace: "off" });

let app: ElectronApplication;
let page: Page;
let repo: string;
const APP_DIR = process.cwd();
const XDG = fs.mkdtempSync(path.join(os.tmpdir(), "hm-agent-plugin-xdg-"));
// A stub acme CLI on PATH, so acme counts as installed; `ghost` has none.
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), "hm-agent-plugin-bin-"));
fs.writeFileSync(path.join(BIN, "acme-coder"), "#!/bin/sh\n[ \"$1\" = --version ] && echo 'acme 1.0.0'\nexit 0\n", { mode: 0o755 });
// A stand-in claude, so the first installed agent is the same on every machine and nothing real starts.
fs.writeFileSync(path.join(BIN, "claude"), "#!/bin/sh\n[ \"$1\" = --version ] && { echo '2.0.0 (Claude Code)'; exit 0; }\nexec sleep 60\n", { mode: 0o755 });
const ENV = { ...process.env, XDG_CONFIG_HOME: XDG, PATH: `${BIN}${path.delimiter}${process.env.PATH}` } as Record<string, string>;

/** A complete provider, written the way a user would write one. */
const ACME = `manifestVersion: 1
id: acme
label: Acme Coder
bin: acme-coder
aliases: [acme]
enabled: true
caps:
  promptDelivery: typed
  turnSignal: false
  resume: none
  supervise: human
  blockedDetection: true
spawn:
  args: ["--no-color"]
options:
  - { id: mode, label: Mode, flag: --mode, values: { plan: ["--dry-run"] } }
  - { id: model, label: Model, flag: --model }
detect:
  default: idle
  rules:
    - when: { contains: "approve this?" }
      then: blocked
`;

/** Launchable, but its CLI is not on this machine. */
const GHOST = ACME.replace("id: acme", "id: ghost").replace("label: Acme Coder", "label: Ghost").replace("bin: acme-coder", "bin: hm-ghost-cli")
  .replace("detect:", "install:\n  url: https://ghost.example.dev/install\n  command: npm i -g hm-ghost-cli\ndetect:");

/** Claims a capability nothing backs — must be refused, and must not stop acme. */
const LIAR = ACME.replace("id: acme", "id: liar").replace("bin: acme-coder", "bin: liar")
  .replace("turnSignal: false", "turnSignal: true");

function installAgent(id: string, yaml: string): void {
  const dir = path.join(XDG, "hivemind", "agents", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "agent.yaml"), yaml);
}

const openSettings = async (pageId: string): Promise<void> => {
  if (await page.locator("[data-settings-body]").count() === 0) {
    await page.locator('[aria-label="settings"]').click();
  }
  await page.locator(`[data-settings-page="${pageId}"]`).click();
};

test.beforeAll(async () => {
  repo = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hm-agent-plugin-"));
  const git = (...args: string[]): void => { execFileSync("git", args, { cwd: repo }); };
  git("init", "-q"); git("config", "user.email", "e2e@test.dev"); git("config", "user.name", "e2e");
  fs.writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
  git("add", "-A"); git("commit", "-q", "-m", "seed");

  installAgent("acme", ACME);
  installAgent("liar", LIAR);
  installAgent("ghost", GHOST);

  app = await electron.launch({ args: [path.join(APP_DIR, "out/main/index.js"), "--no-sandbox"], cwd: repo, env: ENV });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
});

test.afterAll(async () => {
  await app?.close();
  await fs.promises.rm(repo, { recursive: true, force: true }).catch(() => {});
  await fs.promises.rm(XDG, { recursive: true, force: true }).catch(() => {});
  await fs.promises.rm(BIN, { recursive: true, force: true }).catch(() => {});
});

const card = (id: string) => page.locator(`[data-agent-card="${id}"]`);
const detail = () => page.locator("[data-agent-detail]");
/** Overview → the agent's own page. */
async function openAgent(id: string): Promise<void> {
  await openSettings("agents");
  await card(id).click();
  await expect(detail()).toHaveAttribute("data-agent-detail", id);
}

/** The toolbar's agent switcher lists exactly the spawnable catalog. */
async function switcherHas(id: string): Promise<boolean> {
  if (await page.locator("[data-settings-body]").count()) await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "switch agent" }).click();
  const n = await page.locator(`[data-agent-choice="${id}"]`).count();
  await page.keyboard.press("Escape");
  return n > 0;
}

test("a manifest dropped on disk becomes a real provider in the running app", async () => {
  await openSettings("agents");
  await expect(card("acme")).toContainText("Acme Coder");
  // The row says what it runs, not where it came from.
  await expect(card("acme")).toContainText("acme");
  await expect(card("claude")).toHaveCount(1);
  // The Agents group folds to its overview; opening it lists installed agents.
  await expect(page.locator('[data-settings-page="agent:acme"]')).toHaveCount(0);
  await page.getByRole("group", { name: "Agents" }).getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.locator('[data-settings-page="agent:acme"]')).toHaveCount(1);
  expect(await switcherHas("acme")).toBe(true);
});

test("an agent whose CLI is missing says so, links to its install page, and is not offered as ready", async () => {
  await openSettings("agents");
  await expect(card("ghost")).toHaveAttribute("data-state", "missing");
  await expect(card("ghost")).toContainText("Not installed");
  await expect(page.locator('[data-settings-page="agent:ghost"]')).toHaveCount(0);
  await openAgent("ghost");
  await expect(detail().locator(".agent-req")).toHaveAttribute("data-state", "missing");
  await expect(detail().getByRole("link", { name: /Get Ghost/ })).toHaveAttribute("href", "https://ghost.example.dev/install");
  await openAgent("acme");
  await expect(detail().locator(".agent-req")).toHaveAttribute("data-state", "ok");
  await expect(detail().locator(".agent-req")).toContainText("acme 1.0.0");
  if (await page.locator("[data-settings-body]").count()) await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "switch agent" }).click();
  await expect(page.locator('[data-agent-choice="ghost"]')).toHaveAttribute("data-missing");
  await expect(page.locator('[data-agent-choice="acme"]')).not.toHaveAttribute("data-missing");
  await page.keyboard.press("Escape");
});

test("⌘\\ with a default whose CLI is gone starts the first installed agent instead", async () => {
  if (await page.locator("[data-settings-body]").count()) await page.getByRole("button", { name: "Close" }).click();
  const nodes = () => page.locator(".react-flow__node").count();
  const before = await nodes();
  await page.evaluate(() => window.hive.settingsSet("agents.defaultAgent", "ghost"));
  await expect(page.getByRole("group", { name: "Workspace tools" }).getByRole("button", { name: "Claude", exact: true })).toBeVisible();
  await page.locator(".react-flow__pane").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+Backslash");
  await expect.poll(nodes).toBeGreaterThan(before);
  await expect(page.getByText("Ghost is not installed.")).toHaveCount(0);
  await page.evaluate(() => window.hive.settingsSet("agents.defaultAgent", "acme"));
  await expect(page.getByRole("group", { name: "Workspace tools" }).getByRole("button", { name: "Acme Coder", exact: true })).toBeVisible();
  await page.evaluate(() => window.hive.settingsSet("agents.defaultAgent", "claude"));
});

test("an agent the repository ships runs in that repository, and nowhere else", async () => {
  fs.writeFileSync(path.join(BIN, "repo-bot-cli"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const dir = path.join(repo, ".hivemind", "agents", "repo-bot");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "agent.yaml"),
    ACME.replace("id: acme", "id: repo-bot").replace("label: Acme Coder", "label: Repo Bot").replace("bin: acme-coder", "bin: repo-bot-cli"));
  // Main tags a repo's defs with that repo when it scans for it.
  await page.evaluate((root) => window.hive.listAgents(root), repo);

  const spawn = (cwd: string) => page.evaluate(async (target) => {
    try {
      await window.hive.ptySpawn({ tileId: `probe-${Date.now()}`, cwd: target, cmd: "repo-bot-cli", cols: 80, rows: 24 });
      return "spawned";
    } catch (e) { return (e as Error).message; }
  }, cwd);
  expect(await spawn(os.tmpdir())).toContain("only runs in tiles there");
  expect(await spawn(repo)).toBe("spawned");
  // Looking at another workspace must not take this repo's agents away from its own tiles.
  await page.evaluate((other) => window.hive.listAgents(other), os.tmpdir());
  expect(await spawn(repo)).toBe("spawned");
});

test("a manifest that claims a capability nothing backs is refused, and does not take the others down", async () => {
  await openSettings("agents");
  await expect(card("liar")).toHaveAttribute("data-state", "unavailable");
  await expect(card("acme")).toHaveAttribute("data-state", "on");
  await openAgent("liar");
  await expect(detail()).toContainText("turnSignal must be false");
  expect(await switcherHas("liar")).toBe(false);
});

test("each agent shows its own launch options, and a choice is saved for that agent only", async () => {
  await openAgent("acme");
  await expect(detail().locator("[data-agent-option-row]")).toHaveCount(2);
  const mode = page.locator("#agent-acme-mode");
  // the stub CLI's --help lists nothing, so the values are the ones the manifest maps specially
  await expect(mode.locator("option")).toHaveText(["Acme Coder decides", "plan"]);
  await mode.selectOption("plan");
  await expect.poll(() => page.evaluate(() => window.hive.settingsGet().then((s) => s.agents.options))).toEqual({ acme: { mode: "plan" } });

  await openAgent("kiro");
  await expect(detail()).toContainText("has nothing to set at launch");
});

test("switching an agent off in Settings removes it everywhere, and back on restores it", async () => {
  await openAgent("acme");
  const toggle = detail().getByRole("switch");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await openSettings("agents");
  await expect(card("acme")).toHaveAttribute("data-state", "off");
  expect(await switcherHas("acme")).toBe(false);

  await openAgent("acme");
  await detail().getByRole("switch").click();
  await openSettings("agents");
  await expect(card("acme")).toHaveAttribute("data-state", "on");
  expect(await switcherHas("acme")).toBe(true);
});

test("a built-in can be switched off too, and any launchable agent can be the default", async () => {
  await openAgent("codex");
  await detail().getByRole("button", { name: "Make default" }).click();
  await expect(detail().locator(".agent-badge")).toHaveText("Default");
  await openSettings("agents");
  await expect(page.locator('[data-default-choice="codex"]')).toHaveAttribute("aria-checked", "true");
  await openAgent("codex");
  await detail().getByRole("switch").click();
  await openSettings("agents");
  await expect(card("codex")).toHaveAttribute("data-state", "off");
  expect(await switcherHas("codex")).toBe(false);
  expect(await switcherHas("claude")).toBe(true);
  await openAgent("codex");
  await detail().getByRole("switch").click();
  await openSettings("agents");
  await page.locator('[data-default-choice="claude"]').click();
  await expect(page.locator('[data-default-choice="claude"]')).toHaveAttribute("aria-checked", "true");
});
