// A widget card floats over whatever the view under it draws: a bright sea by day, a dark one at
// night. Its muted lines read at 4.5:1 over either, the bars of its rows end at the same place, an
// empty bar and the filled part of one show in every look, and a screen reader hears each bar by
// its label.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PRESETS } from "@hivemind/core/settings-schema";
import { contrastRatio } from "@hivemind/core/css-color";
import { installPlugin } from "./helpers/install";

// Two towns as Archipelago's ledger draws them (a picture, then a name over a bar, each name its
// own length), a bar with no label beside a word, and a muted line.
const LEDGER = `
const town = (name, value, label) => ({ type: "row", children: [
  { type: "image", src: "town.svg", w: 36, h: 36, label: "a town" },
  { type: "stack", children: [{ type: "text", text: name }, { type: "meter", value, max: 4, label }] },
] });
hive.on("start", () => hive.render({ type: "stack", children: [
  town("a project with a long name · +2 today", 2, "2 this week · 2 to a windmill"),
  town("quiet", 0, "0 this week"),
  { type: "row", children: [{ type: "text", text: "beside" }, { type: "meter", value: 1, max: 2 }] },
  { type: "text", text: "8 more out at work", muted: true },
] }));
`;
const TOWN = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><circle cx="18" cy="18" r="14" fill="#7a9"/></svg>`;
/** The brightest a view can draw behind a card, and Archipelago's sea at night. */
const BRIGHT = "#ffffff";
const NIGHT = "#0b1622";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-widget-card-"));
const repo = path.join(root, "repo");
const config = path.join(root, "config");
const env = { ...process.env, XDG_CONFIG_HOME: config, HIVEMIND_SHELL_ENV: "0", HIVEMIND_TEST_UPDATE: "{}" } as Record<string, string>;
delete env.ELECTRON_RUN_AS_NODE;
let app: ElectronApplication;
let page: Page;
const card = () => page.locator('[data-widget-layer] [data-widget="ledger"]');

test.beforeAll(async () => {
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  const dir = path.join(root, "src", "ledger");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "widget.json"), JSON.stringify({ name: "Ledger" }));
  fs.writeFileSync(path.join(dir, "widget.js"), LEDGER);
  fs.writeFileSync(path.join(dir, "town.svg"), TOWN);
  installPlugin(config, dir);
  app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox"], cwd: repo, env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
  await page.locator('[data-toolbar-action="board"]').first().click();
  await page.locator('[data-board-choice="widget:ledger"]').click();
  await expect(card()).toContainText("8 more out at work", { timeout: 15_000 });
  // The default look: glass on, at the slider's usual 72%.
  expect(await page.evaluate(() => document.documentElement.classList.contains("glass-on"))).toBe(true);
});
test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

async function usePreset(preset: keyof typeof PRESETS): Promise<void> {
  const p = PRESETS[preset]!;
  for (const [k, v] of [["appearance.palette", p.palette], ["appearance.mode", p.mode], ["appearance.preset", preset]] as const) {
    await page.evaluate(([k, v]) => window.hive.settingsSet(k as string, v), [k, v] as const);
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.preset)).toBe(preset);
}

/** What the view draws behind the cards: one colour across the canvas, under the glass. */
async function scene(colour: string | null): Promise<void> {
  await page.evaluate((colour) => {
    document.getElementById("hm-test-scene")?.remove();
    if (!colour) return;
    const style = document.createElement("style");
    style.id = "hm-test-scene";
    style.textContent = `html.glass-on body .react-flow { background-color: ${colour} !important; }`;
    document.head.append(style);
  }, colour);
}

/** The colour on screen at the middle of the card's top padding, which has no text: the card
 *  over the scene, blur and all. */
async function cardOnScreen(): Promise<string> {
  const box = (await card().boundingBox())!;
  const png = (await page.screenshot({ clip: { x: Math.round(box.x + box.width / 2) - 2, y: Math.round(box.y) + 4, width: 4, height: 4 } })).toString("base64");
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    [c.width, c.height] = [img.width, img.height];
    const g = c.getContext("2d")!;
    g.drawImage(img, 0, 0);
    return `rgb(${[...g.getImageData(1, 1, 1, 1).data.slice(0, 3)].join(" ")})`;
  }, png);
}

/** A CSS colour as the bytes on screen, each layer painted over the one before. */
const painted = (...layers: string[]) => page.evaluate((layers) => {
  const c = document.createElement("canvas").getContext("2d")!;
  for (const l of layers) { c.fillStyle = l; c.fillRect(0, 0, 1, 1); }
  return `rgb(${[...c.getImageData(0, 0, 1, 1).data.slice(0, 3)].join(" ")})`;
}, layers);
const style = (el: ReturnType<Page["locator"]>, prop: "color" | "backgroundColor") => el.evaluate((e, p) => getComputedStyle(e)[p], prop);

test("a widget card's muted lines read at 4.5:1 over a bright view and a night one, and reduced transparency makes it solid", async () => {
  const muted = card().getByText("8 more out at work");
  try {
    // Nord is the preset that needs the card most solid; Clean Light is a light card over the night.
    for (const preset of ["signal", "nord", "clean-light"] as const) {
      await usePreset(preset);
      const text = await painted(await style(muted, "color"));
      for (const colour of [BRIGHT, NIGHT]) {
        await scene(colour);
        const behind = await cardOnScreen();
        const ratio = contrastRatio(text, behind)!;
        expect({ preset, colour, ratio: ratio >= 4.5 }, `${preset} over ${colour}: ${text} on ${behind}, ${ratio.toFixed(2)}:1`).toEqual({ preset, colour, ratio: true });
        if (colour === BRIGHT) await page.screenshot({ path: test.info().outputPath(`card-${preset}-bright.png`) });
      }
    }
    // Asked for less transparency, or for more contrast, the card hides the view entirely.
    await usePreset("signal");
    const cdp = await page.context().newCDPSession(page);
    for (const feature of ["prefers-reduced-transparency: reduce", "prefers-contrast: more"]) {
      const [name, value] = feature.split(": ") as [string, string];
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name, value }] });
      try {
        expect(await page.evaluate((q) => matchMedia(`(${q})`).matches, feature), feature).toBe(true);
        await expect.poll(() => style(card(), "backgroundColor"), feature).not.toMatch(/\/ [\d.]+\)|rgba/);
      } finally {
        await cdp.send("Emulation.setEmulatedMedia", { features: [] });
      }
    }
  } finally {
    await scene(null);
    await usePreset("signal");
  }
});

test("the bars of a widget's rows end at the same place, and an empty one and a filled one show in dark, light and at night", async () => {
  const bars = card().getByRole("meter");
  await expect(bars).toHaveCount(3);
  // Where the card's content ends: its right edge, less its border and padding.
  const edge = await card().evaluate((el) => {
    const s = getComputedStyle(el);
    return Math.round(el.getBoundingClientRect().right - parseFloat(s.paddingRight) - parseFloat(s.borderRightWidth));
  });
  const boxes = await Promise.all([0, 1, 2].map(async (i) => (await bars.nth(i).boundingBox())!));
  // The towns' bars start after their pictures and end where the card's content does, whatever the
  // length of the words over them; the bar beside a word fills the rest of its row.
  expect(boxes.map((b) => Math.round(b.x + b.width))).toEqual([edge, edge, edge]);
  expect(Math.round(boxes[1]!.x)).toBe(Math.round(boxes[0]!.x));
  expect(boxes[2]!.width).toBeGreaterThan(100);

  const empty = card().getByRole("meter", { name: "0 this week" });
  const half = card().getByRole("meter", { name: "2 this week · 2 to a windmill" });
  try {
    // Nord's selection colour is a dark background, as Dracula's, Solarized's and One Dark's are.
    for (const preset of ["signal", "clean-light", "nord"] as const) {
      await usePreset(preset);
      const track = await style(empty, "backgroundColor");
      const fill = await painted(await style(half.locator("div"), "backgroundColor"));
      for (const colour of [BRIGHT, NIGHT]) {
        await scene(colour);
        const behind = await cardOnScreen();
        const bar = await painted(behind, track);
        // The panel colour the track had measured 1.0:1 on the card at night; this reads as a bar,
        // and what is filled stands off it as a mark does.
        const shows = { track: contrastRatio(bar, behind)! >= 1.4, fill: contrastRatio(fill, bar)! >= 3 };
        expect({ preset, colour, shows }, `${preset} over ${colour}: track ${bar} on ${behind}, fill ${fill}`).toEqual({ preset, colour, shows: { track: true, fill: true } });
      }
    }
  } finally {
    await scene(null);
    await usePreset("signal");
  }
});

test("a screen reader hears a widget's bar by its label, and how far it got", async () => {
  const bar = card().getByRole("meter", { name: "2 this week · 2 to a windmill" });
  await expect(bar).toHaveAttribute("aria-valuenow", "2");
  await expect(bar).toHaveAttribute("aria-valuemin", "0");
  await expect(bar).toHaveAttribute("aria-valuemax", "4");
  await expect(bar).toHaveAttribute("aria-valuetext", "2 of 4");
  // The words over the bar are its name, for the eye: read once, as the bar's.
  await expect(card().getByText("2 this week · 2 to a windmill")).toBeVisible();
  const tree = await card().ariaSnapshot();
  expect(tree.split("\n").filter((l) => l.includes("2 this week")), tree).toEqual([expect.stringMatching(/^\s*- meter "2 this week · 2 to a windmill"/)]);
});
