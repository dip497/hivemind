// An agent CLI found on this machine gets its catalog agent without being asked;
// removing it keeps it removed; switching auto-install off stops it.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildRegistry, type Registry } from "./helpers/registry";

let app: ElectronApplication | undefined;
let page: Page;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-auto-"));
const bin = path.join(root, "bin");
let xdg = "";
const settingsFile = () => path.join(xdg, "hivemind", "settings.json");
const CONTINUE = "continue";
const installed = () => fs.existsSync(path.join(xdg, "hivemind", "agents", CONTINUE, "agent.yaml"));
let indexUrl = "";
let registry: Registry;
// A second catalog agent whose manifest carries a disclosure: it reads a folder under the
// user's home to find sessions to resume. It must be auto-installed too, with the notice
// telling the user what it can do.
const DISCLOSED = "recall";
const DISCLOSED_YAML = `manifestVersion: 1
id: ${DISCLOSED}
label: "Recall"
bin: rc
enabled: true
caps:
  promptDelivery: typed
  turnSignal: false
  resume: auto
  supervise: human
  blockedDetection: false
session:
  resume:
    args: ["--resume"]
    find:
      strategy: dir-meta
      root: "{home}/.recall"
`;
// Boot, a shell-env read and a --version probe all come first; a loaded machine needs the room.
const INSTALL_WAIT = 45_000;

async function launch(): Promise<void> {
  const env = {
    ...process.env, XDG_CONFIG_HOME: xdg, HIVE_SETTINGS: settingsFile(),
    HIVEMIND_PLUGIN_INDEX: indexUrl,
    // Only the stub is discoverable, so no agent CLI this machine happens to have joins in.
    PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`, HIVEMIND_SHELL_ENV: "0",
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.resolve("out/main/index.js"), "--no-sandbox"], cwd: root, env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow");
}

test.beforeAll(() => {
  registry = buildRegistry(path.join(root, "registry"));
  indexUrl = registry.indexUrl;
  fs.mkdirSync(bin);
  // Continue's CLI is `cn`; this stub answers --version the way a CLI does.
  fs.writeFileSync(path.join(bin, "cn"), "#!/bin/sh\n[ \"$1\" = --version ] && echo '1.4.2'\nexit 0\n", { mode: 0o755 });
  execFileSync("git", ["init", "-q", root]);
});

// A fresh profile per attempt, so a retry never starts with the agent already added.
test.beforeEach(() => { xdg = fs.mkdtempSync(path.join(root, "x-")); });
test.afterEach(async () => { await app?.close(); app = undefined; });
test.afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test("a catalog agent whose CLI is on this machine is added, and says so", async () => {
  test.setTimeout(90_000);
  await launch();
  await expect(page.getByText(/Added Continue — found on this machine/)).toBeVisible({ timeout: INSTALL_WAIT });
  expect(installed()).toBe(true);
  await page.locator('[aria-label="settings"]').click();
  await page.locator('[data-settings-page="agents"]').click();
  await expect(page.locator(`[data-agent-card="${CONTINUE}"]`)).toHaveAttribute("data-state", "on");
});

test("an agent with a disclosure is added too, and the notice says what it can do", async () => {
  test.setTimeout(90_000);
  // Added only for this case (the index is refetched per launch), so the earlier tests
  // keep their single-agent expectations.
  registry.add({ id: DISCLOSED, type: "agent", name: "Recall", files: { "agent.yaml": DISCLOSED_YAML }, bin: "rc" });
  fs.writeFileSync(path.join(bin, "rc"), "#!/bin/sh\n[ \"$1\" = --version ] && echo '0.9.0'\nexit 0\n", { mode: 0o755 });
  await launch();
  await expect(page.getByText(/Added .*Recall — found on this machine/)).toBeVisible({ timeout: INSTALL_WAIT });
  await expect(page.getByText(/reads \S+ to find a session to resume/)).toBeVisible();
  expect(fs.existsSync(path.join(xdg, "hivemind", "agents", DISCLOSED, "agent.yaml"))).toBe(true);
  // Removing straight from the notice: same uninstall + decline path as Settings ▸ Agents.
  // Declined is recorded AFTER the dir is gone, so poll the settings for it, not the dir.
  await page.getByRole("button", { name: "Remove Recall" }).click();
  await expect.poll(() => {
    try { return JSON.parse(fs.readFileSync(settingsFile(), "utf8")).agents.declined ?? []; }
    catch { return []; }
  }, { timeout: 10_000 }).toContain(DISCLOSED);
  expect(fs.existsSync(path.join(xdg, "hivemind", "agents", DISCLOSED, "agent.yaml"))).toBe(false);
});

test("an agent you remove is not added back on the next start", async () => {
  test.setTimeout(120_000);
  await launch();
  await expect.poll(installed, { timeout: INSTALL_WAIT }).toBe(true);
  await page.evaluate((id) => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: `agent:${id}` } })), CONTINUE);
  await page.getByRole("button", { name: "Remove Continue" }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.locator(`[data-agent-card="${CONTINUE}"]`)).toHaveCount(0);
  expect(installed()).toBe(false);
  await app!.close(); app = undefined;
  await launch();
  await page.waitForTimeout(8000);
  expect(installed()).toBe(false);
  expect(JSON.parse(fs.readFileSync(settingsFile(), "utf8")).agents.declined).toContain(CONTINUE);
});

test("with auto-install switched off, nothing is added", async () => {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify({ agents: { autoInstall: false } }));
  await launch();
  await page.waitForTimeout(8000);
  expect(installed()).toBe(false);
});
