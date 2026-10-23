// Tool plugins added to the app: installed by the CLI, off until switched on, then loaded into the
// app as a kind of tile, drawn by the plugin's own code with the app's React. A tile's `hm` is the
// client a view has, so its settings reach it live, and what it keeps with its tile is there after
// a restart; switched off, its code is not served and its tiles show what they need. In safe mode
// none loads. The tool is a test fixture, `@example/commits`, written against the tool API.
import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedAgents } from "./helpers/agents";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-tool-plugins-"));
const xdg = path.join(root, "config");
seedAgents(xdg, ["claude"]);
const repo = path.join(root, "repo");
const bin = path.join(root, "bin");
const env = { ...process.env, XDG_CONFIG_HOME: xdg, HIVEMIND_SHELL_ENV: "0", PATH: `${bin}${path.delimiter}${process.env.PATH}` } as Record<string, string>;
delete env.ELECTRON_RUN_AS_NODE;
const cli = path.resolve(process.cwd(), "../cli/src/index.ts");
const fixture = path.resolve(process.cwd(), "tests/e2e/fixtures/tools/commits");
let hcp: Record<string, string> = {};
const hive = (...args: string[]) => {
  const result = spawnSync("bun", [cli, ...args, "--json"], { cwd: repo, env: { ...env, ...hcp }, encoding: "utf8" });
  // What it answers on stdout; a failure, `{ error: { code, message } }`, on stderr.
  if (result.stdout.trim()) return { status: result.status, data: JSON.parse(result.stdout) };
  try { return { status: result.status, data: JSON.parse(result.stderr).error }; } catch { throw new Error(result.stderr); }
};

let app: ElectronApplication;
let page: Page;

async function launch(extra: Record<string, string> = {}): Promise<void> {
  app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox"], cwd: repo, env: { ...env, ...extra } });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
  const userData = path.join(xdg, "hivemind-dev");
  await expect.poll(() => fs.existsSync(path.join(userData, "hcp.token"))).toBe(true);
  hcp = { HIVEMIND_APP_DATA: userData };
}

test.beforeAll(async () => {
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  const git = (cmd: string) => execSync(`git -c user.email=t@t -c user.name=t ${cmd}`, { cwd: repo });
  execSync("git init -q -b main", { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
  git("add -A && git -c user.email=t@t -c user.name=t commit -q -m 'first change'");
  fs.appendFileSync(path.join(repo, "src", "a.ts"), "export const b = 2; // it leaks\n");
  git("add -A && git -c user.email=t@t -c user.name=t commit -q -m 'second change'");
  // An agent to send to: what the app starts as `claude`, waiting on its input.
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\nexec cat\n", { mode: 0o755 });
  expect(hive("plugins", "install", fixture).status).toBe(0);
  await launch();
});
test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

const tile = () => page.locator('[data-tool-plugin="@example/commits"]');
// Whether the window can import its module: a fresh URL each time, as a failed import is remembered.
const served = () => page.evaluate(() => import(/* @vite-ignore */ `hm-plugin://example--commits/index.js?probe=${Math.random()}`).then(() => "served", () => "refused"));
/** Bring a tile into view, as clicking it in Layers does. */
const focus = async (el: Locator) => {
  const id = await el.evaluate((n) => n.closest(".react-flow__node")?.getAttribute("data-id"));
  await page.evaluate((t) => window.dispatchEvent(new CustomEvent("hivemind:focus-tile", { detail: t })), id);
  await page.waitForTimeout(400);
};

test("an added tool is off: it cannot be opened and its code is not served; switched on, it opens and runs", async () => {
  expect(hive("ctl", "open-tool", "@example/commits/commits").data.code).toBe("FORBIDDEN");
  expect(await served()).toBe("refused");
  expect(hive("plugins", "enable", "tool:@example/commits").status).toBe(0);
  await expect.poll(() => hive("ctl", "open-tool", "@example/commits/commits").status).toBe(0);
  await expect(tile()).toContainText("second change", { timeout: 20_000 });
  expect(await served()).toBe("served");
});

test("it is drawn by its own code, linked with its permissions, and its settings reach it live", async () => {
  await expect(tile()).toContainText("first change");
  expect(hive("plugins", "set", "tool:@example/commits", "match", "second").status).toBe(0);
  await expect(tile()).not.toContainText("first change");
  await expect(tile()).toContainText("second change");
  // Its `hm` is linked with the permissions its manifest declares: it offers to start an agent.
  await tile().locator('[data-commit="second change"]').click();
  await expect(tile().getByRole("button", { name: "Ask an agent to explain" })).toBeVisible();
});

test("the app's diff view in a tool draws its changes in the preset's colours and its code in the person's font, through a switch of preset", async () => {
  // Read through the diff's shadow root: the +1 in its file header, and its code. What they should
  // be is the palette's ok colour and the code font, resolved the same way on a span of the page's.
  const drawn = () => tile().evaluate((el) => {
    const root = [...el.querySelectorAll("*")].find((n) => n.shadowRoot?.querySelector("[data-additions-count]"))?.shadowRoot;
    const added = root?.querySelector("[data-additions-count]"), code = root?.querySelector("pre");
    if (!added || !code) return null;
    const probe = el.appendChild(document.createElement("span"));
    probe.style.color = "var(--color-ok)";
    probe.style.fontFamily = "var(--font-mono)";
    const want = getComputedStyle(probe), out = { added: getComputedStyle(added).color, ok: want.color, code: getComputedStyle(code).fontFamily, mono: want.fontFamily };
    probe.remove();
    return out;
  });
  const follows = async () => {
    await expect.poll(drawn, { timeout: 15_000 }).not.toBeNull();
    const d = (await drawn())!;
    expect(d.added, "the added count is the preset's ok, not the diff library's own green").toBe(d.ok);
    expect(d.code).toBe(d.mono);
  };
  await follows();
  const ok = (await drawn())!.ok;
  // A dark preset of another hue, then the light one: the diff follows each, live.
  for (const id of ["dracula", "clean-light"]) {
    expect(hive("theme", "use", id).status).toBe(0);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.preset)).toBe(id);
    await follows();
  }
  expect((await drawn())!.ok).not.toBe(ok);
  expect(hive("theme", "use", "signal").status).toBe(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.preset)).toBe("signal");
});

test("the app's own diff view draws in its tile, and the app's bar on its tile closes it", async () => {
  // The diff view draws inside shadow roots: read the text through them, spaces left out, as a
  // highlighted line is split into tokens.
  const deepText = () => tile().evaluate((el) => {
    const walk = (n: Element | ShadowRoot): string => [...n.children].map((c) => (c.shadowRoot ? walk(c.shadowRoot) : "") + (c.children.length ? walk(c) : c.textContent ?? "")).join("");
    return walk(el).replace(/\s+/g, "");
  });
  await expect.poll(deepText, { timeout: 15_000 }).toContain("//itleaks");
  await expect(tile().locator(".tile-drag-handle")).toContainText("Commits");
  await tile().getByRole("button", { name: "close tile" }).click();
  await expect(tile()).toHaveCount(0);
  const kinds = () => page.evaluate((r) => ((window.hive.workspaceCoreSync(r) ?? {}) as { tiles?: Array<{ kind: string }> }).tiles?.map((t) => t.kind) ?? [], repo);
  await expect.poll(kinds).not.toContain("commits");
});

test("the Add menu offers the tool beside the widgets, by category, found by search, on the Layers panel's material", async () => {
  await page.locator('[data-toolbar-action="board"]').first().click();
  const menu = page.locator("[data-add-menu]");
  await expect(menu.locator('[data-add-category="git"]')).toContainText("Commits");
  await expect(menu.locator('[data-add-category="productivity"]')).toContainText("Sticky note");
  // It is a dialog on the app's opaque sheet: the board never reads through it.
  await expect(menu).toHaveAttribute("role", "dialog");
  expect(await menu.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toMatch(/^transparent$|^rgba\(.*, 0(\.\d+)?\)$/);
  // Its tabs show one type at a time.
  await menu.locator('[data-add-tab="tool"]').click();
  await expect(menu).toContainText("Commits");
  await expect(menu).not.toContainText("Sticky note");
  await menu.locator('[data-add-tab="widget"]').click();
  await expect(menu).toContainText("Sticky note");
  await expect(menu).not.toContainText("Commits");
  await menu.locator('[data-add-tab="all"]').click();
  // Its side panel shows one category at a time, with how many each has.
  await expect(menu.locator('[data-add-shelf="git"]')).toContainText("1");
  await menu.locator('[data-add-shelf="git"]').click();
  await expect(menu.locator("[data-board-choice]")).toHaveText([/Commits/]);
  await menu.locator('[data-add-shelf="all"]').click();
  // A tool's icon is the .svg it ships, drawn in the menu's text colour.
  expect(await menu.locator('[data-board-choice="tile:commits"] span[aria-hidden]').first().evaluate((el) => getComputedStyle(el).maskImage)).toContain("data:image/svg+xml");
  await menu.getByRole("textbox").focus();
  await page.keyboard.type("commi");
  await expect(menu.locator("[data-board-choice]")).toHaveText([/Commits/]);
  // A tool opens from it as from a frame's Open menu.
  await page.keyboard.press("Control+A");
  await page.keyboard.type("code");
  await expect(page.locator(".react-flow__node-workbench")).toHaveCount(0);
  await menu.locator('[data-board-choice="tile:editor"]').click();
  await expect(menu).toHaveCount(0);
  await expect(page.locator(".react-flow__node-workbench")).toHaveCount(1);
});

test("text sent to an agent asks which one: agents by frame, searchable, a new one below, chosen by keyboard", async () => {
  expect(hive("ctl", "spawn", "--agent", "claude", "--name", "first").status).toBe(0);
  const second = hive("ctl", "spawn", "--agent", "claude", "--name", "second").data.tile as string;
  await page.evaluate(() => {
    (window as unknown as { sentTo?: string }).sentTo = undefined;
    window.addEventListener("hivemind:send-to-agent", (e) => { (window as unknown as { sentTo?: string }).sentTo = (e as CustomEvent<{ target: string }>).detail.target; });
  });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:deliver-to-agent", { detail: { text: "Fix the failing test in src/a.ts" } })));
  const picker = page.getByRole("dialog", { name: "Send to agent" });
  await expect(picker).toContainText("Fix the failing test in src/a.ts");
  await expect(picker.locator("[data-picker-row]")).toHaveText([/first/, /second/, /New Claude/i]);
  // Opaque, as a modal is: the board never reads through what it asks.
  expect(await picker.evaluate((el) => el.classList.contains("hm-surface-3"))).toBe(true);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(picker).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { sentTo?: string }).sentTo)).toBe(second);
});

test("what a tool keeps with its tile is there after the app restarts", async () => {
  expect(hive("ctl", "open-tool", "@example/commits/commits").status).toBe(0);
  await focus(tile());
  await tile().locator('[data-commit="second change"]').click();
  await expect(tile().locator('[data-commit="second change"]')).toHaveAttribute("aria-current", "true");
  await page.waitForTimeout(600); // what a tile saves is written a moment after its last change
  await app.close();
  await launch();
  await expect(tile().locator('[data-commit="second change"]')).toHaveAttribute("aria-current", "true", { timeout: 20_000 });
});

test("switched off, its open tiles stay on the board and say what they need", async () => {
  expect(hive("plugins", "disable", "tool:@example/commits").status).toBe(0);
  await expect(page.locator('[data-missing-plugin="commits"]')).toBeVisible({ timeout: 10_000 });
  await expect(tile()).toHaveCount(0);
  expect(await served()).toBe("refused");
});

test("in safe mode no added tool loads, even one switched on", async () => {
  await app.close();
  expect(hive("plugins", "enable", "tool:@example/commits").status).toBe(0);
  await launch({ HIVEMIND_SAFE_MODE: "1" });
  await expect(page.locator('[data-missing-plugin="commits"]')).toBeVisible({ timeout: 20_000 });
  expect(hive("ctl", "open-tool", "@example/commits/commits").data.code).toBe("UNSUPPORTED");
  expect(await served()).toBe("refused");
});
