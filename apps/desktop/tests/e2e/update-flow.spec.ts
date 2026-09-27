// What the app offers about an update, in each state it can be in: one thing to do, named.
// The GitHub answer is arranged through the dev-only seam in main (HIVEMIND_TEST_UPDATE).
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

test.use({ trace: "off" });

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-update-"));
let app: ElectronApplication | undefined;
let page: Page;

const about = () => page.locator(".settings-dialog");

async function launch(update: Record<string, unknown>, progress?: string[]): Promise<void> {
  const xdg = fs.mkdtempSync(path.join(root, "x-"));
  const env = { ...process.env, XDG_CONFIG_HOME: xdg, HIVEMIND_TEST_UPDATE: JSON.stringify({ ...update, ...(progress ? { progress } : {}) }) } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.resolve("out/main/index.js"), "--no-sandbox"], cwd: root, env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow");
  await page.getByLabel("settings", { exact: true }).click();
  await page.locator('[data-settings-page="about"]').click();
}

test.beforeAll(() => execFileSync("git", ["init", "-q", root]));
test.afterEach(async () => { await app?.close(); app = undefined; });
test.afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test("a newer release offers the download, once", async () => {
  await launch({ latest: "9999.1.0" });
  await expect(about().getByText(/Update available — v9999\.1\.0/)).toBeVisible();
  await expect(about().getByRole("button", { name: "Update", exact: true })).toBeVisible();
  // Nothing is downloading yet, so nothing claims progress.
  await expect(about().getByRole("progressbar")).toHaveCount(0);
});

test("a version already downloaded asks for the one thing left: a restart", async () => {
  await launch({ latest: "9999.1.0", staged: "9999.1.0" });
  await expect(about().getByText(/v9999\.1\.0 is downloaded — restart to finish/)).toBeVisible();
  await expect(about().getByRole("button", { name: "Restart", exact: true })).toBeVisible();
  await expect(about().getByRole("button", { name: "Update", exact: true })).toHaveCount(0);
  // And the toolbar says the same thing, not "update available".
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: /Restart to finish/ })).toBeVisible();
});

test("nothing newer says so, and offers a check", async () => {
  await launch({ latest: "0.0.0" });
  await expect(about().getByText("Up to date")).toBeVisible();
  await expect(about().getByRole("button", { name: "Check now" })).toBeVisible();
});

test("while it works, the step is named and the bar fills to it; then a restart is offered", async () => {
  await launch({ latest: "9999.1.0" }, [
    "resolving latest release of dip497/hivemind",
    "target version: v9999.1.0",
    "downloading desktop AppImage",
    "extracting AppImage (no libfuse2 needed)",
    "hivemind is running — upgrade STAGED. Quit & reopen hivemind to apply it.",
    "downloaded v9999.1.0 — restart hivemind to finish",
  ]);
  const bar = about().getByRole("progressbar");
  await about().getByRole("button", { name: "Update", exact: true }).click();
  await expect(bar).toBeVisible();
  await expect(about().getByText("Downloading 9999.1.0")).toBeVisible();
  await expect(about().getByText("Installing")).toBeVisible();
  // Downloaded beside a running app: the restart is the user's to make, and the only thing left.
  await expect(about().getByText("Downloaded — restart to finish")).toBeVisible();
  await expect(bar).toHaveAttribute("aria-valuenow", "4");
  await expect(about().getByRole("button", { name: "Restart", exact: true })).toBeVisible();
});
