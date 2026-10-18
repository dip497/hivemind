// Send to agent offers a new tile of every agent installed here, the one you chose first: never an
// agent that only sorts first in the catalog, nor one this machine does not have.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stopDaemons } from "./helpers/daemons";

let app: ElectronApplication;
let page: Page;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "hm-send-to-agent-"));
const XDG = path.join(ROOT, "xdg");
const BIN = path.join(ROOT, "bin");
const REPO = path.join(ROOT, "repo");
const log = (id: string) => path.join(ROOT, `${id}.log`);
const said = (id: string) => (fs.existsSync(log(id)) ? fs.readFileSync(log(id), "utf8") : "");

/** An agent's manifest, in the user's agents folder as an install puts it. */
function manifest(id: string, label: string, bin: string): void {
  const dir = path.join(XDG, "hivemind", "agents", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "agent.yaml"), `manifestVersion: 2
id: ${id}
label: ${label}
bin: ${bin}
enabled: true
caps:
  promptDelivery: typed
  turnSignal: false
  resume: none
  supervise: human
  blockedDetection: true
detect:
  default: idle
  rules:
    - when: { contains: "approve this?" }
      then: blocked
`);
}

/** A stand-in CLI: says it started, then logs every line typed into it. */
function standIn(id: string, bin: string): void {
  fs.writeFileSync(path.join(BIN, bin), `#!/bin/sh
[ "$1" = --version ] && { echo '${id} 1.0.0'; exit 0; }
echo started >> '${log(id)}'
printf '${id}> '
while read -r line; do echo "heard $line" >> '${log(id)}'; done
`, { mode: 0o755 });
}

test.beforeAll(async () => {
  for (const d of [XDG, BIN, REPO, path.join(ROOT, "home")]) fs.mkdirSync(d, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: REPO });
  // Able sorts first and is not installed; Baker and Zulu are, and Zulu is the one chosen.
  manifest("able", "Able", "hm-able-cli");
  manifest("baker", "Baker", "hm-baker-cli");
  manifest("zulu", "Zulu", "hm-zulu-cli");
  standIn("baker", "hm-baker-cli");
  standIn("zulu", "hm-zulu-cli");
  app = await electron.launch({
    args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox"], cwd: REPO,
    env: { ...process.env, XDG_CONFIG_HOME: XDG, HOME: path.join(ROOT, "home"), HIVEMIND_SHELL_ENV: "0", PATH: `${BIN}${path.delimiter}/usr/bin${path.delimiter}/bin` } as Record<string, string>,
  });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  await page.evaluate(() => window.hive.settingsSet("agents.defaultAgent", "zulu"));
});

test.afterAll(async () => {
  await app?.close();
  stopDaemons(ROOT);
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("Send to agent starts the agent you chose, offers every installed one, and its search finds them", async () => {
  test.setTimeout(120_000);
  const tiles = page.locator(".react-flow__node-terminal");
  // Enough agents running that the dialog has its search box, as it had for the founder.
  for (let i = 1; i <= 7; i++) {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:spawn-agent", { detail: { agent: "baker" } })));
    await expect(tiles).toHaveCount(i, { timeout: 20_000 });
  }
  await expect.poll(() => said("baker").match(/started/g)?.length ?? 0, { timeout: 30_000 }).toBe(7);

  const send = () => page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:deliver-to-agent", { detail: { text: "make a clock widget" } })));
  const dialog = page.getByRole("dialog");
  const newRows = dialog.locator("[data-picker-row]").filter({ hasText: /^New / });
  const search = dialog.getByRole("textbox", { name: "Search" });

  await send();
  await expect(newRows).toHaveText(["New Zulu", "New Baker"]);
  await search.fill("new");
  await expect(newRows).toHaveText(["New Zulu", "New Baker"]);
  await expect(dialog.getByText("Nothing matches.")).toHaveCount(0);
  await search.fill("zulu");
  await expect(newRows).toHaveText(["New Zulu"]);
  await newRows.first().click();
  await expect(tiles).toHaveCount(8, { timeout: 20_000 });
  await expect.poll(() => said("zulu"), { timeout: 30_000 }).toContain("started");
  await expect.poll(() => said("zulu"), { timeout: 30_000 }).toContain("heard make a clock widget");

  // An agent tile that is not the chosen agent still takes a prompt sent to it.
  await send();
  await dialog.locator("[data-picker-row]").filter({ hasNotText: /^New / }).first().click();
  await expect.poll(() => said("baker"), { timeout: 30_000 }).toContain("heard make a clock widget");
});
