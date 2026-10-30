// After an update, the first start of the new version says what changed since the version this
// person last ran, once; a first install says nothing. About shows a version's notes on asking.
import { test, expect, _electron as electron } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Started by its package folder, as an installed app is: it is then the version package.json says. */
async function launchWindow(o: { cwd: string; args: string[] }) {
  const env = { ...process.env } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [process.cwd(), "--no-sandbox", ...o.args], cwd: o.cwd, env });
  return { page: await app.firstWindow(), close: () => app.close() };
}

const VERSION = (JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version: string }).version;
/** The release before this one, as the changelog this build ships lists it. */
const changelog = fs.readFileSync(path.join(process.cwd(), "../../CHANGELOG.md"), "utf8");
const versions = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]!);
const before = versions[versions.indexOf(VERSION) + 1]!;
/** A line this version's own notes have. */
const firstLine = changelog.split(`## [${VERSION}]`)[1]!.split("\n").find((l) => l.startsWith("- "))!.replace(/^- /, "").replace(/[*`]/g, "").slice(0, 40);

test("updated from the release before, the app says once what changed; a first install says nothing", async () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hm-whats-new-")));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const ud = `${repo}-ud`;
  try {
    let app = await launchWindow({ cwd: repo, args: [`--user-data-dir=${ud}`] });
    await app.page.waitForSelector(".react-flow", { timeout: 30_000 });
    await app.page.waitForTimeout(1500);
    await expect(app.page.locator("[data-whats-new]")).toHaveCount(0);
    await app.close();

    fs.writeFileSync(path.join(ud, "whats-new.json"), JSON.stringify({ seen: before }));
    app = await launchWindow({ cwd: repo, args: [`--user-data-dir=${ud}`] });
    const dialog = app.page.locator("[data-whats-new]");
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog).toContainText(`What's new in v${VERSION}`);
    await expect(dialog).toContainText(firstLine);
    await app.page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await app.close();

    app = await launchWindow({ cwd: repo, args: [`--user-data-dir=${ud}`] });
    await app.page.waitForSelector(".react-flow", { timeout: 30_000 });
    await app.page.waitForTimeout(1500);
    await expect(app.page.locator("[data-whats-new]")).toHaveCount(0);
    // Asked for in About, it is shown again.
    await app.page.getByLabel("settings", { exact: true }).click();
    await app.page.locator('[data-settings-page="about"]').click();
    await app.page.locator(`[data-release-notes="${VERSION}"]`).click();
    await expect(app.page.locator("[data-whats-new]")).toContainText(firstLine);
    await app.close();
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(ud, { recursive: true, force: true });
  }
});
