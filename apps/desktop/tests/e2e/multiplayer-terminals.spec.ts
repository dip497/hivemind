// Terminals together (M2, design §4.2 D), with two app instances: a guest who may use terminals
// watches the host's shell live, and their keys do not reach it; they ask for the keyboard and the
// host gives it; then they type into the host's shell, which takes their size while the host's
// window draws it at that size; the host takes it back, and the guest's keys stop reaching it.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hiveNetBuilt, sharedWorkspace } from "./helpers/multiplayer";

let root: string;
const apps: ElectronApplication[] = [];
test.beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-terminals-")); });
// A terminal's session lives in its host's daemon, as it does outside tests: that is what gives it
// an id another machine can name (hm:<tile>).
const DAEMON = { HIVEMIND_PTY_DAEMON: "1" };
test.afterEach(async () => {
  // These two people's daemons only, before the apps close (closing waits on them) and after.
  const reap = () => { try { execSync(`pkill -f "out/main/pty-daemon.js ${root}/"`, { stdio: "ignore" }); } catch { /* none */ } };
  reap();
  for (const a of apps.splice(0)) await a.close().catch(() => {});
  reap();
  fs.rmSync(root, { recursive: true, force: true });
});

const terminal = (w: Page) => w.locator(".react-flow__node-terminal").first();
/** What a person's terminal shows (it draws on a canvas: its host element reads its screen). */
const screen = (w: Page) => terminal(w).evaluate((el) => {
  const host = [el, ...el.querySelectorAll("*")].find((e) => "__hmScreen" in e) as (Element & { __hmScreen(): string }) | undefined;
  return host?.__hmScreen() ?? "";
});
const holder = (w: Page) => terminal(w).locator("[data-keyboard-holder]");
/** The scale the terminal is drawn at in its tile: 1 when it fills it. */
const drawnScale = (w: Page) => terminal(w).locator(".xterm").evaluate((el) => (el as HTMLElement).style.transform.match(/scale\(([\d.]+)\)/)?.[1] ?? "1");
const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "");
/** A person clicks into their terminal: a tile not selected takes the first click, to select it. */
async function clickInto(w: Page): Promise<void> {
  await terminal(w).click();
  await terminal(w).locator(".xterm-screen").click();
}

/** `w` types `line` into its terminal until `file` says `want`: the shell is up once one runs. */
async function run(w: Page, line: string, file: string, want: RegExp): Promise<string> {
  await clickInto(w);
  await expect.poll(async () => {
    if (!want.test(read(file))) await w.keyboard.type(`${line}\n`);
    return read(file);
  }, { timeout: 20_000, intervals: [1_000] }).toMatch(want);
  return read(file);
}

test("a guest watches the host's shell; given the keyboard they type into it and size it, and the host takes it back", async () => {
  test.skip(!hiveNetBuilt(), "build hive-net first: cargo build in crates/hive-net");
  const { host, guest, repo } = await sharedWorkspace(root, apps, "terminals", { env: DAEMON, names: { host: "Adarsh", guest: "Priya" } });
  // The host's letters are bigger than the guest's: fewer of them fit its tile.
  for (let i = 0; i < 4; i++) await terminal(host).getByRole("button", { name: "increase font size" }).click({ force: true });

  // The host's shell, sized by the host, and what it prints reaches the guest as it prints it.
  const before = await run(host, `stty size > ${repo}/host-size`, `${repo}/host-size`, /^\d+ \d+$/);
  await host.keyboard.type("echo printed-$((6*7))\n");
  await expect.poll(() => screen(guest), { timeout: 15_000 }).toContain("printed-42");

  // The guest sees the host has the keyboard; what they type goes nowhere.
  await expect(holder(guest)).toHaveAttribute("data-keyboard-holder", "Adarsh");
  await clickInto(guest);
  await guest.keyboard.type(`touch ${repo}/guest-was-here\n`);

  // They ask; the host is asked, and gives it.
  await guest.locator("[data-keyboard-pill-ask]").click();
  await host.locator("[data-sonner-toast]", { hasText: "Priya asks for the keyboard" }).getByRole("button", { name: "Give" }).click();
  await expect(holder(guest)).toHaveAttribute("data-keyboard-holder", "You");
  await expect(holder(host)).toHaveAttribute("data-keyboard-holder", "Priya");
  expect(fs.existsSync(`${repo}/guest-was-here`)).toBe(false);

  // Theirs now: what they type runs in the host's shell, at their size, which the host's window
  // draws scaled down to its tile.
  const theirs = await run(guest, `stty size > ${repo}/guest-size`, `${repo}/guest-size`, /^\d+ \d+$/);
  expect(Number(theirs.split(" ")[1])).toBeGreaterThan(Number(before.split(" ")[1]));
  await expect.poll(() => drawnScale(host).then(Number)).toBeLessThan(1);
  await clickInto(host);
  await host.keyboard.type(`touch ${repo}/host-while-lent\n`);

  // The host takes it back: its own size again, and the guest's keys go nowhere.
  await terminal(host).locator("[data-keyboard-take]").click();
  await expect(holder(guest)).toHaveAttribute("data-keyboard-holder", "Adarsh");
  await expect.poll(() => drawnScale(host)).toBe("1");
  fs.rmSync(`${repo}/host-size`);
  expect(await run(host, `stty size > ${repo}/host-size`, `${repo}/host-size`, /^\d+ \d+$/)).toBe(before);
  await clickInto(guest);
  await guest.keyboard.type(`touch ${repo}/guest-after\n`);
  await host.keyboard.type(`echo done > ${repo}/host-done\n`);
  await expect.poll(() => read(`${repo}/host-done`)).toBe("done");
  await guest.waitForTimeout(1_000); // anything the guest's window sent has long arrived
  expect(fs.existsSync(`${repo}/guest-after`)).toBe(false);
  expect(fs.existsSync(`${repo}/host-while-lent`)).toBe(false);
});
