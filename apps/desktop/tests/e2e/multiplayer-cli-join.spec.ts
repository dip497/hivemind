// `hive join` against a running app (no `hive host`): once let in, the app's window opens the
// workspace joined, as the Join dialog's Open does, and is not left on its own canvas.
import { test, expect, type ElectronApplication } from "@playwright/test";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { hiveNetBuilt, person, share } from "./helpers/multiplayer";

const CLI = path.resolve("../cli/src/index.ts");
let root: string;
const apps: ElectronApplication[] = [];
// Short: the app's sockets live under it, and a socket path is at most ~108 bytes.
test.beforeEach(() => { root = fs.mkdtempSync("/tmp/hm-cj-"); });
test.afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
});

test("hive join through the app opens the workspace in its window", async () => {
  test.skip(!hiveNetBuilt() || process.platform === "win32", "build hive-net first: cargo build in crates/hive-net");
  const repo = path.join(root, "api");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const host = await person(root, "host", repo, apps);
  const elsewhere = path.join(root, "w");
  fs.mkdirSync(elsewhere);
  const guest = await person(root, "guest", elsewhere, apps);
  const link = await share(host, "edit");
  await expect(guest.locator("[data-shared-banner]")).toHaveCount(0);

  const data = path.join(root, "guest", "hivemind-dev");
  const env = {
    ...process.env, XDG_CONFIG_HOME: path.join(root, "guest"), HIVEMIND_APP_DATA: data,
    HIVE_HCP_SOCK: path.join(data, "hcp.sock"), HCP_TOKEN: fs.readFileSync(path.join(data, "hcp.token"), "utf8").trim(), HIVEMIND_TILE: "",
  };
  const joined = new Promise<string>((resolve) => execFile("bun", [CLI, "join", link, "--json"], { env }, (_e, out) => resolve(out)));
  await host.locator(".hm-join-request").getByRole("button", { name: "Allow" }).click();
  expect(JSON.parse(await joined)).toMatchObject({ ok: true, data: { ok: true, role: "edit" } });
  await expect(guest.locator("[data-shared-banner]")).toBeVisible();
});
