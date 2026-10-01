// Agents on your machine in someone else's workspace (M4, design §5.4), with two app instances,
// each running its terminals in its own PTY daemon, as outside tests: a guest who may edit the
// board puts a frame of their own on their own computer (the only place the chooser offers them),
// and a shell they open in it runs there, in their folder. The host watches it, live, through the
// guest's own connection, and its keyboard is the guest's machine's: the host's keys never reach
// it, until the guest lets the others type there, and then not once they take that back. A shell
// the host puts in the guest's frame runs nowhere: the guest's machine runs only what its person
// placed, and shows the host nothing else; until they let the others run terminals and agents
// there, when one the host puts there runs on their computer, in their folder, started by the
// host, and their window shows it. The host's board names their computer by them, there or not.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hiveNetBuilt, sharedWorkspace, tiles } from "./helpers/multiplayer";

let root: string;
const apps: ElectronApplication[] = [];
test.beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-guest-machine-")); });
const DAEMON = { HIVEMIND_PTY_DAEMON: "1" };
test.afterEach(async () => {
  // These two people's daemons only (`[.]`: the pattern matches no shell that runs it), before the
  // apps close, as they close (closing waits on them, and an app that still shows a session there
  // starts its daemon again), and after.
  const reap = () => { try { execSync(`pkill -f "out/main/pty-daemon[.]js ${root}/"`, { stdio: "ignore" }); } catch { /* none */ } };
  reap();
  const reaping = setInterval(reap, 500);
  try {
    for (const a of apps.splice(0)) await a.close().catch(() => {});
  } finally {
    clearInterval(reaping);
  }
  reap();
  fs.rmSync(root, { recursive: true, force: true });
});

const frames = (w: Page) => w.locator(".react-flow__node-frame").evaluateAll((ns) => ns.map((n) => n.getAttribute("data-id")!).sort());
/** What the terminal of `tile` shows in `w` (it draws on a canvas: its host element reads its screen). */
const screenOf = (w: Page, tile: string) => w.locator(`.react-flow__node-terminal[data-id="${tile}"]`).evaluate((el) => {
  const host = [el, ...el.querySelectorAll("*")].find((e) => "__hmScreen" in e) as (Element & { __hmScreen(): string }) | undefined;
  return host?.__hmScreen() ?? "";
}).catch(() => "");
const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "");
/** The scale `w` draws the terminal of `tile` at in its tile: 1 when it fills it. */
const drawnScale = (w: Page, tile: string) => w.locator(`.react-flow__node-terminal[data-id="${tile}"] .xterm`).evaluate((el) => (el as HTMLElement).style.transform.match(/scale\(([\d.]+)\)/)?.[1] ?? "1");
/** `w` brings the tile `tile` into view, selected: one someone else placed may be anywhere. */
async function focusTile(w: Page, tile: string): Promise<void> {
  await expect.poll(async () => {
    await w.evaluate((id) => window.dispatchEvent(new CustomEvent("hivemind:focus-tile", { detail: id })), tile);
    return w.locator(`.react-flow__node[data-id="${tile}"] .hm-node-selected`).count();
  }, { timeout: 20_000, intervals: [500] }).toBe(1);
}
/** `w` puts its keyboard on the terminal of `tile` (selected, its own keys go to it), wherever on
 *  the board the tile is. */
async function clickInto(w: Page, tile: string): Promise<void> {
  await focusTile(w, tile);
  const keys = w.locator(`.react-flow__node-terminal[data-id="${tile}"] textarea.xterm-helper-textarea`);
  await keys.evaluate((t) => (t as HTMLElement).focus());
  await expect(keys).toBeFocused({ timeout: 10_000 });
}
/** `w` makes the letters of the terminal of `tile` bigger, by its button. */
const fontUp = (w: Page, tile: string) => w.locator(`.react-flow__node-terminal[data-id="${tile}"]`).getByRole("button", { name: "increase font size" }).evaluate((b) => (b as HTMLElement).click());
/** On the guest's own frame `frame`, what the others in the workspace may do on their computer. */
async function letOthers(w: Page, frame: string, grant: "watch" | "terminals" | "agents"): Promise<void> {
  await w.locator(`.react-flow__node-frame[data-id="${frame}"] [aria-label="machine This computer"]`).evaluate((b) => (b as HTMLElement).click());
  await w.locator(`[data-machine-grant="${grant}"]`).evaluate((b) => (b as HTMLElement).click());
  await expect(w.locator(`[data-machine-grant="${grant}"]`)).toHaveAttribute("aria-checked", "true");
  await w.locator(".fixed.inset-0.z-\\[9998\\]").evaluate((b) => (b as HTMLElement).click());
}
/** The tile `w` opened in `frame` by asking for a shell there. */
async function openShell(w: Page, frame: string): Promise<string> {
  const before = await tiles(w);
  await w.evaluate((id) => window.dispatchEvent(new CustomEvent("hivemind:frame-open", { detail: { frameId: id, kind: "shell" } })), frame);
  let tile = "";
  await expect.poll(async () => (tile = (await tiles(w)).find((t) => !before.includes(t) && !t!.startsWith("frame-")) ?? ""), { timeout: 20_000 }).not.toBe("");
  return tile;
}

test("a guest puts a frame of their own on their computer: a shell they open in it runs there, in their folder, and the host watches it without typing into it; a shell the host puts there runs nowhere, until they let the others run terminals there", async () => {
  test.skip(!hiveNetBuilt(), "build hive-net first: cargo build in crates/hive-net");
  test.setTimeout(180_000);
  const { host, guest } = await sharedWorkspace(root, apps, "edit", { env: DAEMON, names: { host: "Adarsh", guest: "Priya" } });
  const folder = path.join(root, "priya-api");
  fs.mkdirSync(folder);

  // In someone else's workspace, where a frame runs is this computer, a folder of theirs.
  const had = await frames(guest);
  await guest.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:machines", { detail: { kind: "pick", frameId: null } })));
  await guest.locator("[data-this-computer-folder]").fill(folder);
  await guest.locator("[data-this-computer-go]").click();
  let frame = "";
  await expect.poll(async () => (frame = (await frames(guest)).find((f) => !had.includes(f)) ?? ""), { timeout: 10_000 }).not.toBe("");
  await expect.poll(() => frames(host), { timeout: 15_000 }).toContain(frame);
  // On the host's board, the frame says whose computer it runs on, and that they are there.
  const theirComputer = host.locator(`.react-flow__node-frame[data-id="${frame}"] [aria-label="machine Priya's computer"]`);
  await expect(theirComputer).toHaveAttribute("data-machine-state", "online", { timeout: 15_000 });

  // A shell they open in it runs on their computer, in their folder.
  const shell = await openShell(guest, frame);
  await focusTile(guest, shell);
  await expect(guest.locator(`.react-flow__node-terminal[data-id="${shell}"] textarea.xterm-helper-textarea`)).toBeFocused({ timeout: 10_000 });
  await expect.poll(async () => {
    if (!read(path.join(folder, "where.txt"))) await guest.keyboard.type("pwd > where.txt\n");
    return read(path.join(folder, "where.txt"));
  }, { timeout: 30_000, intervals: [1_000] }).toBe(folder);

  // The host's board has it, and the host watches it as it runs, through the guest's connection:
  // its keyboard is the guest's machine's, which nobody takes from the host.
  await guest.keyboard.type("echo watched-$((6*7))\n");
  await expect.poll(() => tiles(host), { timeout: 15_000 }).toContain(shell);
  await expect.poll(() => screenOf(host, shell), { timeout: 30_000 }).toContain("watched-42");
  const watched = host.locator(`.react-flow__node-terminal[data-id="${shell}"]`);
  await expect(watched.locator("[data-keyboard-holder]")).toHaveAttribute("data-keyboard-holder", "Priya");
  await expect(watched.locator("[data-keyboard-machine]")).toHaveCount(1);
  await expect(watched.locator("[data-keyboard-take]")).toHaveCount(0);
  // At the size it has on the guest's computer: the host, whose letters are bigger, draws it
  // scaled down to its tile, and does not size it.
  for (let i = 0; i < 4; i++) await fontUp(host, shell);
  await expect.poll(() => drawnScale(host, shell).then(Number), { timeout: 10_000 }).toBeLessThan(1);

  // What the host types goes nowhere.
  await clickInto(host, shell);
  await host.keyboard.type(`touch ${folder}/host-was-here\n`);
  await clickInto(guest, shell);
  await expect.poll(async () => {
    if (!read(path.join(folder, "done.txt"))) await guest.keyboard.type("echo done > done.txt\n");
    return read(path.join(folder, "done.txt"));
  }, { timeout: 20_000, intervals: [1_000] }).toBe("done");
  await host.waitForTimeout(1_000); // anything the host's window sent has long arrived
  expect(fs.existsSync(path.join(folder, "host-was-here"))).toBe(false);

  // The guest lets the others type there: the host's keys reach it, at its size there.
  await letOthers(guest, frame, "terminals");
  await expect(watched.locator("[data-keyboard-machine]")).toHaveCount(0, { timeout: 10_000 });
  await expect.poll(async () => {
    if (!fs.existsSync(path.join(folder, "host-typed"))) {
      await clickInto(host, shell);
      await host.keyboard.type(`touch ${folder}/host-typed\n`);
    }
    return fs.existsSync(path.join(folder, "host-typed"));
  }, { timeout: 30_000, intervals: [2_000] }).toBe(true);
  expect(Number(await drawnScale(host, shell))).toBeLessThan(1);
  // Taken back: the host's keys go nowhere again.
  await letOthers(guest, frame, "watch");
  await expect(watched.locator("[data-keyboard-machine]")).toHaveCount(1, { timeout: 10_000 });
  await clickInto(host, shell);
  await host.keyboard.type(`touch ${folder}/host-again\n`);
  await clickInto(guest, shell);
  await expect.poll(async () => {
    if (!read(path.join(folder, "done2.txt"))) await guest.keyboard.type("echo done > done2.txt\n");
    return read(path.join(folder, "done2.txt"));
  }, { timeout: 20_000, intervals: [1_000] }).toBe("done");
  await host.waitForTimeout(1_000);
  expect(fs.existsSync(path.join(folder, "host-again"))).toBe(false);

  // Opened again (the window reloads), it is theirs to run on their computer, as they placed it.
  await guest.reload();
  await expect.poll(() => screenOf(guest, shell), { timeout: 20_000 }).toContain(folder);
  expect(await screenOf(guest, shell)).not.toContain("someone else placed");

  // A shell the host puts in the guest's frame reaches the guest's board, and runs nowhere: not
  // there, where its person did not place it, nor through the host, which their machine does not
  // show it.
  const had2 = await tiles(guest);
  const planted = await openShell(host, frame);
  await expect.poll(() => tiles(guest), { timeout: 15_000 }).toContain(planted);
  expect(had2).not.toContain(planted);
  await expect.poll(() => screenOf(guest, planted), { timeout: 15_000 }).toContain("someone else placed this tile on your computer");
  // (Refused as the host starts it, or, once the host's board holds it, as their machine shows it not.)
  await expect.poll(() => screenOf(host, planted), { timeout: 20_000 }).toMatch(/what runs there is theirs to start|not running on the machine it belongs to/);

  // The guest lets the others run terminals and agents there: a shell the host puts in their frame
  // now runs on their computer, in their folder, started by the host, and their window shows it.
  await letOthers(guest, frame, "agents");
  // The one the host put there before, opened again: their window, opening it first, shows it once
  // the host's window starts it.
  await guest.reload();
  await expect(guest.locator(`.react-flow__node-terminal[data-id="${planted}"] .xterm`)).toHaveCount(1, { timeout: 20_000 });
  await host.reload();
  await focusTile(guest, planted);
  await expect.poll(() => screenOf(guest, planted), { timeout: 30_000 }).toContain(`${folder}#`);
  expect(await screenOf(guest, planted)).not.toMatch(/someone else placed|not running/);
  const started = await openShell(host, frame);
  await expect.poll(() => tiles(guest), { timeout: 15_000 }).toContain(started);
  await expect.poll(async () => {
    if (!read(path.join(folder, "host-shell.txt"))) {
      await clickInto(host, started);
      await host.keyboard.type("pwd > host-shell.txt; echo started-$((6*7))\n");
    }
    return read(path.join(folder, "host-shell.txt"));
  }, { timeout: 40_000, intervals: [2_000] }).toBe(folder);
  await focusTile(guest, started);
  await expect.poll(() => screenOf(guest, started), { timeout: 20_000 }).toContain("started-42");
  expect(await screenOf(guest, started)).not.toContain("someone else placed");
  // Theirs to type into on their computer, as ever.
  await expect.poll(async () => {
    if (!read(path.join(folder, "guest-typed.txt"))) {
      await clickInto(guest, started);
      await guest.keyboard.type("echo guest-$((6*7)) > guest-typed.txt\n");
    }
    return read(path.join(folder, "guest-typed.txt"));
  }, { timeout: 30_000, intervals: [2_000] }).toBe("guest-42");

  // They leave: it is still their computer on the host's board, which says they are not there.
  await guest.locator("[data-leave]").click();
  await expect(theirComputer).toHaveAttribute("data-machine-state", "offline", { timeout: 30_000 });
});
