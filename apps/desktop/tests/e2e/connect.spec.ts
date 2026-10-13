// Connect (spec/pairing.md 0.10, docs/design/connect-2026-10-13.md §5): one computer offers, another
// uses the offer by its link or its six words, and both screens show the same three words. The
// person at the offering computer answers: it's me makes the other computer theirs, once its own
// person says the words match there; someone else lets it into the workspace of the window the offer
// was made in, at the role chosen; deny keeps nothing, and the offer stays for the next. A cancelled
// offer is used by nobody. A phone (`hive-phone`, the phone's own core) is never someone else.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { hiveNetBuilt, person } from "./helpers/multiplayer";
import { stopDaemons } from "./helpers/daemons";
import { pick } from "./helpers/select";

let root: string;
const apps: ElectronApplication[] = [];
test.beforeEach(() => { root = fs.mkdtempSync("/tmp/hm-connect-"); });
test.afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  stopDaemons(root);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const repo = (name: string) => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
};

/** `w` pastes `text` in Open recent's Join, and goes. */
async function enter(w: Page, text: string): Promise<void> {
  await w.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-recent")));
  await w.locator("[data-join]").click();
  await w.locator("[data-join-link]").fill(text);
  await w.locator("[data-join-go]").click();
}

test("a laptop pastes the desktop's offer; both show the same words, and it's me there and yes here make the laptop the desktop's person's", async () => {
  test.skip(!hiveNetBuilt(), "build hive-net first: cargo build in crates/hive-net");
  test.setTimeout(120_000);
  const desktop = await person(root, "desktop", repo("api"), apps);
  const laptop = await person(root, "laptop", repo("notes"), apps);
  const desktopIs = await desktop.evaluate(() => window.hive.identity());
  await desktop.evaluate(() => window.hive.settingsSet("profile.name", "Priya"));

  const offer = await desktop.evaluate(() => window.hive.connectOffer(null));
  expect(offer.link).toMatch(/^hivemind:\/\/connect\/[0-9a-f]{64}#/);
  await enter(laptop, offer.link);

  const request = desktop.locator(".hm-connect-request");
  await expect(request).toContainText("wants to connect", { timeout: 20_000 });
  const shown = laptop.locator("[data-connect-words-text]");
  await expect(shown).toBeVisible();
  const words = (await shown.textContent())!;
  expect(words.split(" · ")).toHaveLength(3);
  await expect(request.locator("[data-connect-request-words]")).toHaveText(words);
  // Asked from Home there is no workspace to let it into.
  await expect(request.getByRole("button", { name: "Someone else" })).toHaveCount(0);

  await request.getByRole("button", { name: "It's me — the words match" }).click();
  await expect(request.locator("[data-connect-request-confirming]")).toBeVisible();
  // Nothing is the desktop's person's until the laptop's own person says yes.
  expect((await laptop.evaluate(() => window.hive.identity())).personId).not.toBe(desktopIs.personId);
  await laptop.locator("[data-connect-sure]").getByRole("button", { name: "Yes, make this computer Priya's" }).click();

  await expect(laptop.locator('[data-join-result="theirs"]')).toBeVisible({ timeout: 20_000 });
  expect((await laptop.evaluate(() => window.hive.identity())).personId).toBe(desktopIs.personId);
  await expect(desktop.locator(".hm-connect-ended")).toContainText("is yours now");
  await expect(request).toHaveCount(0);
  // Used, the offer is over.
  expect((await desktop.evaluate(() => window.hive.connectState())).offer).toBeNull();
});

const HIVE_PHONE = path.resolve("../../crates/hive-phone/target/debug/hive-phone");

/** `hive-phone connect <link>` with the phone's keys under `root/phone`, saying `sure` when told it is
 *  theirs: the words it shows, once shown, and how it ended (its exit code and last line). */
function phoneConnects(link: string, sure: "yes" | "no") {
  const run = spawn(HIVE_PHONE, ["connect", link, "--sure", sure, "--identity", path.join(root, "phone"), "--name", "Priya's phone", "--json"]);
  const lines: string[] = [];
  let err = "";
  run.stdout.on("data", (d: Buffer) => lines.push(...d.toString().split("\n").filter(Boolean)));
  run.stderr.on("data", (d: Buffer) => { err += d.toString(); });
  const words = expect.poll(() => lines.length, { timeout: 30_000 }).toBeGreaterThan(0).then(() => (JSON.parse(lines[0]!) as { words: string[] }).words);
  const ended = new Promise<{ code: number | null; last: string }>((resolve) => run.on("close", (code) => resolve({ code, last: code === 0 ? lines.at(-1)! : err.trim() })));
  return { words, ended };
}

test("a phone uses the computer's offer: it shows the same words, is never someone else, and is the person's only once it says the words match there", async () => {
  test.skip(!hiveNetBuilt() || !fs.existsSync(HIVE_PHONE), "build hive-net and hive-phone first: cargo build in crates/hive-net and crates/hive-phone");
  test.setTimeout(120_000);
  const api = repo("api");
  const desktop = await person(root, "desktop", api, apps);
  await desktop.evaluate(() => window.hive.settingsSet("profile.name", "Priya"));
  const me = await desktop.evaluate(() => window.hive.identity());
  const request = desktop.locator(".hm-connect-request");

  // Told it is Priya's, the person at the phone says the words do not match: nothing is kept.
  const first = await desktop.evaluate((r) => window.hive.connectOffer(r), api);
  const no = phoneConnects(first.link, "no");
  await expect(request.locator("[data-connect-request-words]")).toHaveText((await no.words).join(" · "), { timeout: 20_000 });
  await expect(request).toContainText("A phone");
  // Offered from a workspace, still: a phone is never someone else.
  await expect(request.getByRole("button", { name: "Someone else" })).toHaveCount(0);
  await request.getByRole("button", { name: "It's me — the words match" }).click();
  expect(await no.ended).toEqual({ code: 1, last: "hive-phone: the words did not match: nothing was kept" });
  await expect(desktop.locator(".hm-connect-ended")).toContainText("said the words did not match");
  expect(await desktop.evaluate(() => window.hive.devices())).toEqual([]);

  // Asked again with a new offer, it says they match: it is the person's phone.
  const second = await desktop.evaluate((r) => window.hive.connectOffer(r), api);
  const yes = phoneConnects(second.link, "yes");
  await expect(request.locator("[data-connect-request-words]")).toHaveText((await yes.words).join(" · "), { timeout: 20_000 });
  await request.getByRole("button", { name: "It's me — the words match" }).click();
  const { code, last } = await yes.ended;
  expect(code).toBe(0);
  expect(JSON.parse(last)).toMatchObject({ device: me.deviceId, kind: "app", person: me.personId, profile: { name: "Priya" } });
  await expect.poll(async () => (await desktop.evaluate(() => window.hive.devices())).map((d) => [d.name, d.kind])).toEqual([["Priya's phone", "phone"]]);
  await expect(desktop.locator(".hm-connect-ended", { hasText: "Priya's phone is yours now" })).toBeVisible();
});

test("denied, a computer is let in by nothing; asking again with the offer's words, it is let in as someone else at the role chosen; a cancelled offer is used by nobody", async () => {
  test.skip(!hiveNetBuilt(), "build hive-net first: cargo build in crates/hive-net");
  test.setTimeout(150_000);
  const api = repo("api");
  const host = await person(root, "host", api, apps);
  const guest = await person(root, "guest", repo("elsewhere"), apps);
  const offer = await host.evaluate((r) => window.hive.connectOffer(r), api);
  const request = host.locator(".hm-connect-request");

  await enter(guest, offer.link);
  await request.getByRole("button", { name: "Deny" }).click({ timeout: 20_000 });
  await expect(guest.locator('[data-join-result="out"]')).toContainText("did not let this one in", { timeout: 20_000 });
  await expect(request).toHaveCount(0);
  expect(await host.evaluate((r) => window.hive.people(r), api)).toEqual([]);
  await guest.keyboard.press("Escape");

  // The offer stays: its six words, found on this network, ask again.
  const words = (await host.evaluate(() => window.hive.connectState())).offer!.code.replaceAll("-", " ");
  await enter(guest, words);
  await pick(request.locator("[data-connect-request-role]"), "Can view");
  await request.getByRole("button", { name: "Someone else" }).click({ timeout: 20_000 });
  await expect(guest.locator('[data-join-result="in"]')).toContainText("api · Can view", { timeout: 20_000 });
  const me = await guest.evaluate(() => window.hive.identity());
  expect((await host.evaluate((r) => window.hive.people(r), api)).map((p) => [p.person, p.role])).toEqual([[me.personId, "view"]]);
  expect(me.personId).not.toBe((await host.evaluate(() => window.hive.identity())).personId);
  await expect(host.locator(".hm-connect-ended")).toContainText("was let in");
  // Opened there, it is the host's, and this computer may only look.
  await guest.locator("[data-join-open]").click();
  const banner = guest.locator('[data-shared-banner][data-state="connected"]');
  await expect(banner).toHaveAttribute("data-access", "view", { timeout: 20_000 });

  // A new offer, cancelled: the guest is told so, and nobody is asked.
  const again = await host.evaluate((r) => window.hive.connectOffer(r), api);
  await host.evaluate(() => window.hive.connectCancel());
  await enter(guest, again.link);
  await expect(guest.locator('[data-join-result="out"]')).toContainText("has expired, or was used", { timeout: 20_000 });
  await expect(request).toHaveCount(0);
});
