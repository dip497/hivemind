// agent-browser from the Browser tool's settings: which one is on this computer, installed or
// updated from there, and the switch that points every terminal's agent-browser at the Browser tiles.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = String(9200 + Math.floor(Math.random() * 100));
const bin = fs.mkdtempSync(path.join(os.tmpdir(), "hm-ab-bin-"));
const ud = fs.mkdtempSync(path.join(os.tmpdir(), "hm-ab-ud-"));
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  // npm as the install runs it: it puts agent-browser on the PATH, as a global install does.
  fs.writeFileSync(path.join(bin, "npm"), `#!/bin/sh
[ "$1 $2 $3" = "install -g agent-browser@latest" ] || exit 9
printf '#!/bin/sh\\necho "agent-browser 0.41.0"\\n' > "${bin}/agent-browser"
chmod +x "${bin}/agent-browser"
echo "added 1 package"
`, { mode: 0o755 });
  // An ffmpeg that does not run, in front of any this computer has.
  fs.writeFileSync(path.join(bin, "ffmpeg"), "#!/bin/sh\nexit 127\n", { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, HIVEMIND_SHELL_ENV: "0", HIVEMIND_BROWSER_CDP: "1", HIVEMIND_BROWSER_CDP_PORT: PORT } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.resolve("out/main/index.js"), "--no-sandbox", `--user-data-dir=${ud}`], cwd: path.resolve("."), env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 20_000 });
  await page.evaluate(() => window.hive.settingsSet("plugins.state.tool:@hivemind/web", { enabled: true }));
  await page.evaluate(() => window.hive.settingsSet("network.updateCheck", false));
});
test.afterAll(async () => {
  await page.evaluate(() => window.hive.settingsSet("network.updateCheck", true)).catch(() => {});
  await page.evaluate(() => window.hive.settingsSet("agentBrowser.useTiles", true)).catch(() => {});
  await app?.close();
  fs.rmSync(bin, { recursive: true, force: true });
  fs.rmSync(ud, { recursive: true, force: true });
});

test("not installed, the Browser tool's settings install agent-browser, and say which is there", async () => {
  await page.getByLabel("settings", { exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "tool:@hivemind/web" } })));
  const row = page.locator("[data-agent-browser]");
  await expect(row.locator("[data-agent-browser-version]")).toContainText("Not installed");
  await expect(row.locator("[data-ffmpeg-missing]")).toContainText("needs ffmpeg");
  await row.locator("[data-agent-browser-install]").click();
  await expect(row.locator("[data-agent-browser-version]")).toContainText("0.41.0 is installed", { timeout: 20_000 });
  await expect(row.locator("[data-agent-browser-install]")).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("with Use these Browser tiles off, a terminal's agent-browser is left as it is", async () => {
  await page.evaluate(() => window.hive.settingsSet("agentBrowser.useTiles", false));
  await page.keyboard.press("6");
  await page.waitForSelector(".react-flow__node-frame");
  const frame = await page.locator(".react-flow__node-frame").last().getAttribute("data-id");
  await page.evaluate((f) => window.dispatchEvent(new CustomEvent("hivemind:frame-open", { detail: { frameId: f, kind: "shell" } })), frame);
  const term = page.locator(".react-flow__node-terminal").last();
  await term.locator(".xterm-screen").click();
  const screen = () => term.evaluate((el) => ([el, ...el.querySelectorAll("*")].find((e) => "__hmScreen" in e) as (Element & { __hmScreen(): string }) | undefined)?.__hmScreen() ?? "");
  await expect.poll(async () => { await page.keyboard.type('echo "[cdp=$AGENT_BROWSER_CDP]"\n'); return screen(); }, { timeout: 20_000, intervals: [1500] }).toContain("[cdp=]");
});
