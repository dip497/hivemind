// Settings → Profile (R3, spec/identity.md): this computer's device and person ids, made the first
// time they are asked for, kept in <userData>/identity readable by the user alone, and the same
// after a restart; the workspace the window shows is that person's; the name offered is git's; a
// name and colour chosen land in settings.json.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readDoc } from "../../../../packages/workspace-host/src/doc-file";

const HEX_ID = /^[0-9a-f]{64}$/;

/** Whose each workspace document in `dir` says it is. */
function owners(dir: string): unknown[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".loro")).map((f) => {
    const bytes = fs.readFileSync(path.join(dir, f));
    const { repo } = JSON.parse(bytes.subarray(0, bytes.indexOf(0x0a)).toString("utf8")) as { repo: string };
    return readDoc(dir, repo, (m) => { throw new Error(m); }).getMap("meta").get("owner");
  });
}

test("Profile shows this computer's ids, the same after a restart, and saves the name and colour chosen", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-profile-"));
  const config = path.join(root, "config");
  const settings = path.join(root, "settings.json");
  const gitconfig = path.join(root, "gitconfig");
  fs.writeFileSync(gitconfig, "[user]\n\tname = Priya From Git\n");
  const env = { ...process.env, XDG_CONFIG_HOME: config, HIVE_SETTINGS: settings, GIT_CONFIG_GLOBAL: gitconfig } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = async (): Promise<[ElectronApplication, Page]> => {
    const app = await electron.launch({ args: [path.resolve("out/main/index.js"), "--no-sandbox"], cwd: root, env });
    const page = await app.firstWindow();
    await page.waitForSelector(".react-flow");
    await page.getByLabel("settings", { exact: true }).click();
    await page.locator('[data-settings-page="profile"]').click();
    return [app, page];
  };
  const ids = (page: Page) => page.evaluate(() =>
    Object.fromEntries([...document.querySelectorAll<HTMLElement>("[data-identity]")].map((e) => [e.dataset.identity, e.dataset.id])));

  let [app, page] = await launch();
  try {
    await expect.poll(() => ids(page)).toEqual({ device: expect.stringMatching(HEX_ID), person: expect.stringMatching(HEX_ID) });
    const first = await ids(page);
    expect(first.device).not.toBe(first.person);
    const dir = path.join(config, "hivemind-dev", "identity");
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    for (const f of ["device.key", "person.key", "device.cert"]) expect(fs.statSync(path.join(dir, f)).mode & 0o777).toBe(0o600);
    // The workspace the window shows is this person's.
    await expect.poll(() => owners(path.join(config, "hivemind-dev", "workspaces"))).toEqual([first.person]);

    const name = page.locator("#profile-name");
    await expect(name).toHaveAttribute("placeholder", "Priya From Git");
    // Typed key by key, as a person does: the space between the words stays.
    await name.pressSequentially(" Priya Shah ");
    await name.press("Enter");
    await page.locator('[data-profile-color="#14b8a6"]').click();
    await expect.poll(() => fs.existsSync(settings) && JSON.parse(fs.readFileSync(settings, "utf8")).profile).toEqual({ name: "Priya Shah", color: "#14b8a6" });

    await app.close();
    [app, page] = await launch();
    await expect.poll(() => ids(page)).toEqual(first);
    await expect(page.locator("#profile-name")).toHaveValue("Priya Shah");
    await expect(page.locator('[data-profile-color="#14b8a6"]')).toHaveAttribute("aria-checked", "true");
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
