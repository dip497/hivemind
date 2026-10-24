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
  // A line changed and one added, so its diff has a −N and a +N.
  fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 2;\nexport const b = 2; // it leaks\n");
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

test("the app's diff view in a tool draws on the preset's page, its changes in the preset's colours, its counts readable there, and its code in the person's font, through a switch of preset", async () => {
  // Read through the diff's shadow root: its page (the host's background), the +N and −N in its
  // file header, and its code. What they should be is the palette's bg2, the diff's added colour
  // (the palette's ok, lifted to read on the page) and the code font, resolved the same way on a
  // span of the page's. Colours as the browser paints them, so two spellings of one colour compare
  // equal.
  const drawn = () => tile().evaluate((el) => {
    const host = [...el.querySelectorAll("*")].find((n) => n.shadowRoot?.querySelector("[data-deletions-count]"));
    const root = host?.shadowRoot;
    const added = root?.querySelector("[data-additions-count]"), removed = root?.querySelector("[data-deletions-count]"), code = root?.querySelector("pre");
    if (!host || !added || !removed || !code) return null;
    const c = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const paint = (colour: string) => { c.clearRect(0, 0, 1, 1); c.fillStyle = colour; c.fillRect(0, 0, 1, 1); return [...c.getImageData(0, 0, 1, 1).data]; };
    // The nearest opaque background out from the counts, through the shadow root to its host.
    let ground: Element | null = added;
    while (ground && paint(getComputedStyle(ground).backgroundColor)[3] !== 255) ground = ground.parentElement ?? (ground.getRootNode() as ShadowRoot).host ?? null;
    const probe = el.appendChild(document.createElement("span"));
    probe.style.color = "var(--color-diff-added)";
    probe.style.backgroundColor = "var(--color-bg2)";
    probe.style.fontFamily = "var(--font-mono)";
    const want = getComputedStyle(probe), rgb = (colour: string) => paint(colour).slice(0, 3);
    const out = { added: rgb(getComputedStyle(added).color), removed: rgb(getComputedStyle(removed).color), ok: rgb(want.color),
      page: paint(getComputedStyle(host).backgroundColor), bg2: paint(want.backgroundColor),
      ground: ground && rgb(getComputedStyle(ground).backgroundColor), code: getComputedStyle(code).fontFamily, mono: want.fontFamily };
    probe.remove();
    return out;
  });
  /** WCAG contrast of two painted colours. */
  const contrast = (a: number[], b: number[]) => {
    const lum = (rgb: number[]) => {
      const [r, g, b] = rgb.map((v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };
  const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]!) <= 1);
  /** The page is the preset's bg2 (Pierre's own is #0a0a0a on every dark preset, white on a light one). */
  const onPage = async (id: string) => {
    await expect.poll(async () => { const d = await drawn(); return d && near(d.page, d.bg2) ? "bg2" : JSON.stringify(d && { page: d.page, bg2: d.bg2 }); },
      { message: `the diff's page on ${id}`, timeout: 15_000 }).toBe("bg2");
  };
  const follows = async (id: string) => {
    await expect.poll(drawn, { timeout: 15_000 }).not.toBeNull();
    await onPage(id);
    const d = (await drawn())!;
    expect(near(d.added, d.ok), "the added count is the preset's ok as the diff draws it, not the diff library's own green").toBe(true);
    // The counts are words on the page: each reads there.
    expect(d.ground, "the counts sit on an opaque page").not.toBeNull();
    expect(near(d.ground!, d.bg2.slice(0, 3)), "the counts sit on the page").toBe(true);
    expect(contrast(d.added, d.ground!), `+N on ${id}`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(d.removed, d.ground!), `−N on ${id}`).toBeGreaterThanOrEqual(4.5);
    expect(d.code).toBe(d.mono);
  };
  // Glass off, so the page is opaque and the counts' contrast is what is drawn. Put back however
  // this ends: the tests after it share the app.
  expect(hive("config", "set", "appearance.glass.enabled", "false").status).toBe(0);
  try {
    await follows("signal");
    const ok = (await drawn())!.ok;
    // Dark presets of other hues (Solarized Dark's red needs the lift to read on its bg2), then the
    // light one: the diff follows each, live.
    for (const id of ["dracula", "solarized-dark", "clean-light"]) {
      expect(hive("theme", "use", id).status).toBe(0);
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.preset)).toBe(id);
      await follows(id);
    }
    expect((await drawn())!.ok).not.toEqual(ok);
    // With glass on too, the page is the tile's bg2.
    expect(hive("theme", "use", "dracula").status).toBe(0);
    expect(hive("config", "set", "appearance.glass.enabled", "true").status).toBe(0);
    await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("glass-on"))).toBe(true);
    await onPage("dracula with glass");
    // Glass on the content clears the page, so the tile's own tint is the one layer over the wallpaper.
    expect(hive("config", "set", "appearance.glass.contentGlass", "true").status).toBe(0);
    await expect.poll(async () => (await drawn())?.page[3], { message: "the page with glass on the content" }).toBe(0);
  } finally {
    hive("config", "set", "appearance.glass.contentGlass", "false");
    hive("config", "set", "appearance.glass.enabled", "true");
    expect(hive("theme", "use", "signal").status).toBe(0);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.preset)).toBe("signal");
  }
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
