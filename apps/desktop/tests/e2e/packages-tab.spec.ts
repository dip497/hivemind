// A package of three (a tool, a widget and a view) added from a folder in Settings ▸ Plugins: the
// review lists each member, where it runs and what it asks for, and it arrives off because the
// tool runs in the app. Switched on from its row in the Packages tab, it is updated from a folder
// whose widget asks for more: the review names that change and says the package switches off,
// and after the update it is off. Roll back puts the version before back, on as it was.
import { test, expect, chromium, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { freePort } from "./helpers/window";

let app: ElectronApplication;
let page: Page;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-packages-tab-"));
const xdg = path.join(root, "config");
/** Set to a folder to keep a picture of each step. */
const shots = process.env.PACKAGES_SHOTS;

function kit(version: string, dogAsks: string[]): string {
  const dir = path.join(root, `kit-${version}`);
  const put = (rel: string, files: Record<string, string>) => {
    fs.mkdirSync(path.join(dir, rel), { recursive: true });
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel, f), text);
  };
  put("tools/prs", {
    "hivemind-tool.json": JSON.stringify({ id: "@e2e/prs", name: "Pull requests", version: "1.0.0", apiVersion: 1, entry: "index.js", tools: [{ key: "prs", label: "Pull requests", tileKind: "e2e-prs" }] }),
    "index.js": "export default { tiles: {} };",
  });
  put("widgets/dog", { "widget.json": JSON.stringify({ id: "@e2e/dog", name: "Dog", permissions: dogAsks, draw: { type: "text", text: "woof" } }) });
  put("views/island", { "hivemind-view.json": JSON.stringify({ id: "@e2e/island", name: "Island", version: "1.0.0", entry: "index.html", permissions: ["workspace:issues"] }), "index.html": "<!doctype html>" });
  fs.writeFileSync(path.join(dir, "hivemind-package.json"), JSON.stringify({
    apiVersion: 2, id: "@e2e/kit", name: "Kit", version,
    tools: [{ path: "tools/prs" }], widgets: [{ path: "widgets/dog" }], views: [{ path: "views/island" }],
  }));
  return dir;
}

test.beforeAll(async () => {
  execFileSync("git", ["init", "-q", path.join(root, "repo")]);
  fs.mkdirSync(path.join(root, "home"));
  // HiveHub lists one package, with what it holds as HiveHub read it.
  const manifest = JSON.stringify({ apiVersion: 2, id: "@e2e/hubkit", name: "Hub kit", version: "1.0.0", widgets: [{ path: "widgets/cat" }] });
  fs.mkdirSync(path.join(root, "hub", "packages", "hubkit"), { recursive: true });
  fs.writeFileSync(path.join(root, "hub", "packages", "hubkit", "hivemind-package.json"), manifest);
  fs.writeFileSync(path.join(root, "hub", "index.json"), JSON.stringify({ version: 1, plugins: [{
    id: "@e2e/hubkit", type: "package", name: "Hub kit", description: "A test package from the catalog.", author: "e2e", version: "1.0.0",
    path: "packages/hubkit", files: [{ path: "hivemind-package.json", sha256: createHash("sha256").update(manifest).digest("hex") }],
    members: [{ kind: "widget", id: "@e2e/cat", name: "Cat", permissions: [] }, { kind: "tool", id: "@e2e/runner", name: "Runner", permissions: ["workspace:spawn"] }],
  }] }));
  const env = {
    ...process.env, HOME: path.join(root, "home"), XDG_CONFIG_HOME: xdg, HIVEMIND_SHELL_ENV: "0",
    HIVEMIND_PLUGIN_INDEX: pathToFileURL(path.join(root, "hub", "index.json")).href,
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.resolve("out/main/index.js"), "--no-sandbox"], cwd: path.join(root, "repo"), env });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForSelector(".react-flow");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "plugins" } })));
  await expect(page.locator("[data-plugins-home]")).toBeVisible();
});

test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

const body = () => page.locator("[data-settings-body]");
const shot = async (name: string) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
/** The folder the native picker answers with; the person would choose it there. */
async function addFromFolder(dir: string): Promise<void> {
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog;
  }, dir);
  await body().locator("[data-add-plugin]").click();
  await page.locator("[data-folder-install]").click();
}
const review = () => body().locator("[data-package-review='@e2e/kit']");
const row = () => body().locator("[data-package='@e2e/kit']");
const packageSwitch = () => row().locator("[data-package-switch]");

test("install from a folder, switch on, review an update that asks for more, roll back", async () => {
  await addFromFolder(kit("1.0.0", []));
  await expect(review()).toHaveAttribute("data-review-kind", "install");
  await expect(review().locator("[data-package-members] li")).toHaveText([
    /Pull requests.*Tool · Runs in the app.*Asks for nothing more/,
    /Dog.*Widget · Sandboxed.*Asks for nothing more/,
    /Island.*View · Sandboxed.*May read, create, change and delete the workspace's issues/,
  ]);
  await expect(review().locator("[data-package-outcome]")).toHaveAttribute("data-package-outcome", "off");
  await expect(review().locator("[data-package-outcome]")).toContainText("Pull requests runs outside the sandbox");
  await shot("1-install-review");
  await body().locator("[data-folder-install-do]").click();

  await body().locator('[data-plugins-kind="package"]').click();
  await expect(packageSwitch()).toHaveAttribute("aria-checked", "false");
  await shot("2-packages-tab");
  // What the install said is no longer so once it is switched on, so it goes then, not later.
  const said = page.getByText("Kit 1.0.0 is installed, switched off.");
  await expect(said).toBeVisible();
  await packageSwitch().click();
  await expect(packageSwitch()).toHaveAttribute("aria-checked", "true");
  await expect(said).toHaveCount(0, { timeout: 1500 });
  await row().locator("[data-package-open]").click();
  await expect(row().locator("[data-member-switch]")).toHaveCount(3);
  await shot("3-expanded");
  await row().locator("[data-member-switch='widget:@e2e/dog']").click();
  await expect(row().locator("[data-member-switch='widget:@e2e/dog']")).toHaveAttribute("aria-checked", "false");
  await expect(row().locator("[data-package-open]")).toContainText("1 switched off");
  await shot("4-member-off");
  await row().locator("[data-member-switch='widget:@e2e/dog']").click();
  await expect(row().locator("[data-member-switch='widget:@e2e/dog']")).toHaveAttribute("aria-checked", "true");

  // The widget's tab lists it too, as part of Kit, with no switch of the package's.
  await body().locator('[data-plugins-kind="widget"]').click();
  await expect(body().locator("[data-plugin-row='widget:@e2e/dog']")).toContainText("Part of Kit");
  await expect(body().locator("[data-plugin-row='widget:@e2e/dog'] [role=switch]")).toHaveCount(0);
  await shot("5-widget-tab");

  await addFromFolder(kit("1.1.0", ["workspace:spawn"]));
  await expect(review()).toHaveAttribute("data-review-kind", "update");
  await expect(review().locator("[data-package-change='widget:@e2e/dog']")).toHaveText("Now may start agents in your workspace");
  await expect(review().locator("[data-switches-off]")).toHaveText(["Switches it off: it asks for more"]);
  await expect(review().locator("[data-package-outcome]")).toHaveAttribute("data-package-outcome", "off");
  await shot("6-update-review");
  await body().locator("[data-folder-install-do]").click();
  await body().locator('[data-plugins-kind="package"]').click();
  await expect(row().locator("[data-package-open]")).toContainText("1.1.0");
  await expect(packageSwitch()).toHaveAttribute("aria-checked", "false");
  await shot("7-after-update");

  if ((await row().getAttribute("data-open")) === null) await row().locator("[data-package-open]").click();
  await row().locator("[data-rollback]").click();
  await expect(row().locator("[data-rollback-confirm]")).toContainText("Go back to 1.0.0? It comes back on, as it was.");
  await shot("8-rollback-confirm");
  await row().locator("[data-rollback-do]").click();
  await expect(row().locator("[data-package-open]")).toContainText("1.0.0");
  await expect(packageSwitch()).toHaveAttribute("aria-checked", "true");
  await expect(row().locator("[data-rollback]")).toContainText("Roll back to 1.1.0");
  await shot("9-after-rollback");
});

test("HiveHub lists a package under Packages, with what it holds before anything is downloaded", async () => {
  await body().getByRole("tab", { name: "HiveHub", exact: true }).click();
  await body().locator('[data-plugins-kind="package"]').click();
  await expect(body().locator("[data-plugin-row='package:@e2e/hubkit']")).toContainText("Hub kit");
  await body().locator("[data-package-holds-open='@e2e/hubkit']").click();
  await expect(body().locator("[data-package-holds='@e2e/hubkit'] li")).toHaveText([
    /Cat.*Widget · Sandboxed.*Asks for nothing more/,
    /Runner.*Tool · Runs in the app.*May start agents in your workspace/,
  ]);
  await shot("10-hivehub-packages");
});

test("in a browser tab the Packages tab lists the package, and its switch reaches the app", async () => {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "browser" } })));
  const section = page.locator("[data-browser-app]");
  await section.locator("[data-browser-app-more] > summary").click();
  await section.locator("#browser-app-port").fill(String(await freePort()));
  await section.locator("#browser-app-port").press("Enter");
  await section.getByRole("switch", { name: "Serve the app to a browser" }).click();
  const link = (await section.locator("[data-browser-app-open]").first().getAttribute("href"))!;
  const browser = await chromium.launch(process.env.HIVE_HARNESS_CHROMIUM ? { executablePath: process.env.HIVE_HARNESS_CHROMIUM } : {});
  try {
    const tab = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await tab.goto(link);
    await tab.waitForSelector(".react-flow", { timeout: 30_000 });
    await tab.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "plugins" } })));
    const there = tab.locator("[data-settings-body]");
    await there.locator('[data-plugins-kind="package"]').click();
    const kit = there.locator("[data-package='@e2e/kit']");
    await expect(kit.locator("[data-package-switch]")).toHaveAttribute("aria-checked", "true");
    await kit.locator("[data-package-open]").click();
    await expect(kit.locator("[data-member-switch]")).toHaveCount(3);
    if (shots) await tab.screenshot({ path: path.join(shots, "11-browser-tab-packages.png") });
    await kit.locator("[data-package-switch]").click();
    await expect(kit.locator("[data-package-switch]")).toHaveAttribute("aria-checked", "false");
    await expect.poll(() => page.evaluate(async () => (await window.hive.installedPackages()).find((p) => p.id === "@e2e/kit")?.on)).toBe(false);
    if (shots) await tab.screenshot({ path: path.join(shots, "12-browser-tab-off.png") });
    // A folder is chosen on the computer the app runs on, so the tab does not offer one.
    await there.locator("[data-add-plugin]").click();
    await expect(tab.locator("[data-folder-install]")).toHaveCount(0);
    if (shots) await tab.screenshot({ path: path.join(shots, "13-browser-tab-add.png") });
  } finally { await browser.close(); }
});

test("a package that opens with a view offers it once installed, and Open switches to it", async () => {
  const dir = path.join(root, "harbour");
  fs.mkdirSync(path.join(dir, "views", "isle"), { recursive: true });
  fs.writeFileSync(path.join(dir, "views", "isle", "hivemind-view.json"), JSON.stringify({ id: "@e2e/isle", name: "Isle", version: "1.0.0", entry: "index.html" }));
  fs.writeFileSync(path.join(dir, "views", "isle", "index.html"), "<!doctype html>");
  fs.writeFileSync(path.join(dir, "hivemind-package.json"), JSON.stringify({
    apiVersion: 2, id: "@e2e/harbour", name: "Harbour", version: "1.0.0", views: [{ path: "views/isle" }], startup: { view: "@e2e/isle" },
  }));
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "plugins" } })));
  await expect(page.locator("[data-plugins-home]")).toBeVisible();
  await addFromFolder(dir);
  await body().locator("[data-folder-install-do]").click();
  const offer = body().getByRole("status").filter({ hasText: "Open Isle?" });
  await shot("10-open-start-view-offer");
  await offer.getByRole("button", { name: "Open" }).click();
  // Settings closes on the view it opened.
  await expect(page.locator('[data-community-view="@e2e/isle"]')).toBeVisible();
  await expect(body()).toHaveCount(0);
  await shot("11-open-start-view-opened");
});
