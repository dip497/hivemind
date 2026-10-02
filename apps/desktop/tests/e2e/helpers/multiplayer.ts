// Two app instances on one network, as two people (M1): each its own profile and data folder, each
// with hive-net's daemon (crates/hive-net's debug build). And the steps of sharing and joining.
import { expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const HIVE_NET = path.resolve("../../crates/hive-net/target/debug/hive-net");
export const hiveNetBuilt = (): boolean => fs.existsSync(HIVE_NET);

/** A network of its own: a relay, a lookup server, an access service admitting by `policy` and a
 *  push server (allowed to tell phones at distributors on this machine), run by an admin key kept in
 *  `root`; its link (with an enrolment voucher for one device), and where each serves. The server
 *  joins `procs`, to be stopped with the test. */
export async function ownNetwork(root: string, procs: ChildProcess[], policy: "closed" | "open-pow" = "closed"): Promise<{ relay: string; lookup: string; access: string; push: string; link: string; data: string }> {
  const admin = path.join(root, "admin.key");
  fs.writeFileSync(admin, `${"cd".repeat(32)}\n`);
  const voucher = (kind: string) => execFileSync(HIVE_NET, ["access", "voucher", "--kind", kind, "--admin", admin], { encoding: "utf8" }).trim();
  const adminId = (JSON.parse(voucher("enrol")) as { by: string }).by;
  const data = path.join(root, "network");
  const server = spawn(HIVE_NET, ["serve", "--relay", "--lookup", "--access", "--push", "--push-allow", "127.0.0.0/8", "--admin-id", adminId, "--policy", policy, "--pow-bits", "8", "--data", data, "--bind", "127.0.0.1:0"], { stdio: ["ignore", "pipe", "ignore"] });
  procs.push(server);
  const lines: string[] = [];
  await new Promise<void>((resolve) => server.stdout!.on("data", (d: Buffer) => { lines.push(...d.toString().trim().split("\n")); if (lines.length >= 4) resolve(); }));
  const serving = (role: string) => lines.find((l) => l.startsWith(`${role} serving on `))!.replace(`${role} serving on `, "");
  const [relay, lookup, access, push] = [serving("relay"), serving("lookup"), serving("access"), serving("push")];
  const text = path.join(root, "profile.json");
  fs.writeFileSync(text, JSON.stringify({ v: 1, name: "Example Corp", relays: [{ url: relay }], lookup, access: { url: access, policy }, push: { url: push, kinds: ["unifiedpush"] }, admin: adminId, local: { mdns: true } }));
  const signed = JSON.parse(execFileSync(HIVE_NET, ["profile", "sign", text, "--admin", admin], { encoding: "utf8" })) as object;
  const link = `hivemind://network/${Buffer.from(JSON.stringify({ ...signed, enrol: JSON.parse(voucher("enrol")) })).toString("base64url")}`;
  return { relay, lookup, access, push, link, data };
}

/** Start the app as person `name` (their data under `root/name`), with `cwd` as its project, `more`
 *  in its environment and `args` on its command line. */
export async function person(root: string, name: string, cwd: string, apps: ElectronApplication[], more: Record<string, string> = {}, args: string[] = []): Promise<Page> {
  const config = path.join(root, name);
  const env = { ...process.env, XDG_CONFIG_HOME: config, HIVE_SETTINGS: path.join(config, "settings.json"), HIVEMIND_HIVE_NET: HIVE_NET, ...more } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.resolve("out/main/index.js"), "--no-sandbox", ...args], cwd, env });
  apps.push(app);
  const page = await app.firstWindow();
  await page.waitForSelector(".react-flow");
  return page;
}

/** The host makes an invite link for `role` from Share. */
export async function share(host: Page, role: "view" | "edit" | "terminals"): Promise<string> {
  await host.locator("[data-share]").click();
  await host.locator("#share-role").selectOption(role);
  await host.locator("[data-share-create]").click();
  const link = (await host.locator("[data-share-link]").textContent())!;
  await host.keyboard.press("Escape");
  return link;
}

/** The guest pastes `link` and asks to join; the host allows. The guest is left at "You're in". */
export async function join(guest: Page, host: Page, link: string): Promise<void> {
  await guest.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-recent")));
  await guest.locator("[data-join]").click();
  await guest.locator("[data-join-link]").fill(link);
  await guest.locator("[data-join-go]").click();
  await host.locator(".hm-join-request").getByRole("button", { name: "Allow" }).click();
  await expect(guest.locator('[data-join-result="in"]')).toBeVisible();
}

/** The tiles on a person's board (board objects aside), sorted. */
export const tiles = (w: Page) => w.locator(".react-flow__node").evaluateAll((ns) => ns.map((n) => n.getAttribute("data-id")).filter((id) => id && !id.startsWith("note")).sort());
/** The text of each sticky note on a person's board. */
export const notes = (w: Page) => w.locator(".react-flow__node-note [data-board-text]").allTextContents();
const emptySpot = (w: Page) => w.evaluate(() => {
  const pane = document.querySelector(".react-flow__pane")!.getBoundingClientRect();
  for (let y = pane.bottom - 140; y > pane.top + 100; y -= 30) {
    for (let x = pane.left + 320; x < pane.right - 100; x += 30) {
      if (document.elementFromPoint(x, y)?.classList.contains("react-flow__pane")) return { x, y };
    }
  }
  return null;
});
/** A person writes a sticky note with `text` somewhere free on their board. */
export async function note(w: Page, text: string): Promise<void> {
  // Room on the canvas first: a workspace's frame can fill the view.
  for (let i = 0; i < 3; i++) await w.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:zoom", { detail: "out" })));
  await w.waitForTimeout(400);
  const at = (await emptySpot(w))!;
  await w.mouse.click(at.x, at.y);
  await w.keyboard.press("8");
  await w.keyboard.type(text);
  await w.keyboard.press("Escape");
}

/** A host with a shell tile in the workspace `api`, shared for `role` with a guest who joined and
 *  opened it: both see the same tiles. Both apps have `env` in their environment; with `names`,
 *  each is named so before the invite. */
export async function sharedWorkspace(root: string, apps: ElectronApplication[], role: "view" | "edit" | "terminals", { env = {}, names }: { env?: Record<string, string>; names?: { host: string; guest: string } } = {}) {
  const repo = path.join(root, "api");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const host = await person(root, "host", repo, apps, env);
  if (names) await host.evaluate((n) => window.hive.settingsSet("profile.name", n), names.host);
  await host.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await expect.poll(async () => (await tiles(host)).length).toBeGreaterThan(0);
  const guestDir = path.join(root, "elsewhere");
  fs.mkdirSync(guestDir);
  const guest = await person(root, "guest", guestDir, apps, env);
  if (names) await guest.evaluate((n) => window.hive.settingsSet("profile.name", n), names.guest);
  const link = await share(host, role);
  await join(guest, host, link);
  await guest.locator("[data-join-open]").click();
  await expect.poll(() => tiles(guest), { timeout: 15_000 }).toEqual(await tiles(host));
  return { host, guest, repo };
}
