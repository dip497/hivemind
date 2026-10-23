// Regression: the Issues tile on the canvas (board-lite). Seeds a real
// .hivemind workspace + two issues, opens the tile, and verifies the card,
// per-card state dropdown, "work" button, and click→peek all render, and that
// an issue's words read in every preset.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { launchWindow, type AppWindow } from "./helpers/window";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { PRESETS } from "@hivemind/core/settings-schema";

const LABELS = ["theme", "ci", "backend"];

/** An element's text colour and what it is drawn on, as the browser paints them: every background
 *  from the nearest opaque one in to the element's own, then the text colour over them. */
const painted = (el: Element): number[][] => {
  const c = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
  const paint = (fills: string[]) => {
    c.clearRect(0, 0, 1, 1);
    for (const f of fills) { c.fillStyle = f; c.fillRect(0, 0, 1, 1); }
    return [...c.getImageData(0, 0, 1, 1).data];
  };
  const under: string[] = [];
  for (let n: Element | null = el; n; n = n.parentElement) {
    under.unshift(getComputedStyle(n).backgroundColor);
    if (paint([under[0]!])[3] === 255) break;
  }
  return [paint([...under, getComputedStyle(el).color]).slice(0, 3), paint(under).slice(0, 3)];
};
/** WCAG contrast of a text colour on its ground. */
const contrast = ([fg, bg]: number[][]) => {
  const lum = (rgb: number[]) => {
    const [r, g, b] = rgb.map((v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const [hi, lo] = [lum(fg!), lum(bg!)].sort((a, b) => b - a);
  return (hi! + 0.05) / (lo! + 0.05);
};

let app: AppWindow;
let page: Page;
let workspace: string;

test.beforeAll(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "hm-issues-"));
  await fs.mkdir(path.join(workspace, ".hivemind", "issues"), { recursive: true });
  await fs.writeFile(path.join(workspace, ".hivemind", "config.yaml"), "prefix: XX\nnext_id: 3\nagents: {}\n", "utf8");
  // Labels in the hues each page reads least well, theme a cyan (199) on the light page and ci a pink
  // (350) on the dark one, and backend a red (20) near the end of the hues a name may take
  // (name-hue.ts); an assignee, and a criterion that is done.
  await fs.writeFile(
    path.join(workspace, ".hivemind", "issues", "XX-2.md"),
    `---
id: XX-2
title: Read the labels in every light
state: in_progress
parent: null
labels: [${LABELS.join(", ")}]
assignee:
  type: agent
  id: codex
github: null
created: "2026-05-21T00:00:00.000Z"
updated: "2026-05-21T00:00:00.000Z"
---

## Description

Every word on it, in every preset.

## Acceptance Criteria

- [x] it reads
`,
    "utf8",
  );
  await fs.writeFile(
    path.join(workspace, ".hivemind", "issues", "XX-1.md"),
    `---
id: XX-1
title: Wire up the flux capacitor
state: todo
parent: null
labels: []
assignee: null
github: null
created: "2026-05-21T00:00:00.000Z"
updated: "2026-05-21T00:00:00.000Z"
---

## Description

Make it go.

## Acceptance Criteria

- [ ] it goes
`,
    "utf8",
  );

  app = await launchWindow({ cwd: workspace, args: [`--user-data-dir=/tmp/hm-issues-ud-${Date.now()}`] });
  page = app.page;
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  await page.waitForTimeout(400);
  // The Issues plugin registers its tile a moment after the window loads: ask until it is there.
  await expect.poll(async () => {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "issues" })));
    return page.locator('[data-tool-plugin="@hivemind/issues"]').count();
  }, { timeout: 15_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(800);
});

test.afterAll(async () => {
  await app?.close();
  await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
});

test("renders the issue card with id + title", async () => {
  const txt = await page.evaluate(() => document.querySelector('[data-tool-plugin="@hivemind/issues"]')?.textContent || "");
  expect(txt).toContain("XX-1");
  expect(txt).toContain("Wire up the flux capacitor");
});

test("card has a state dropdown and a work button", async () => {
  const node = page.locator('[data-tool-plugin="@hivemind/issues"]');
  expect(await node.getByRole("combobox").count()).toBeGreaterThan(0);
  // work button is opacity-0 until hover but present in the DOM
  expect(await node.locator('button', { hasText: /work/ }).count()).toBeGreaterThan(0);
});

test("clicking a card opens the issue peek", async () => {
  await page.locator('[data-tool-plugin="@hivemind/issues"]').getByText("Wire up the flux capacitor").click();
  // The peek slide-over has a distinctive "Work on this" button (the tile card's
  // is just "work"). Poll until it appears — readIssue is async.
  await expect(page.getByRole("button", { name: /Work on this/i })).toBeVisible({ timeout: 5_000 });
  // Leave the canvas as we found it: the modal peek marks everything behind it
  // aria-hidden, which would hide the card from the next test's role query.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 3_000 });
});

test("changing the state from the issue peek persists it (manual override)", async () => {
  // The manual path is the peek's state picker (the card itself no longer
  // carries a <select>; the tile's only select is the group-by control).
  // Agents own automatic transitions via set_state, which needs a live agent
  // — not exercised here. This verifies the manual write path works.
  const node = page.locator('[data-tool-plugin="@hivemind/issues"]');
  // Open via the card's stable handle: its root is role=button "Open issue
  // XX-1". The old `force: true` click on the card TEXT was the flake — the
  // previous test left the modal peek open, so the forced click hit the
  // overlay (closing the peek) instead of the card. With the peek closed by
  // its own test, a plain actionable click is deterministic.
  const card = node.getByRole("button", { name: "Open issue XX-1" });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await card.click();
  const peek = page.getByRole("dialog");
  await expect(peek).toBeVisible({ timeout: 5_000 });
  // The state picker is a button showing the current label; its popover lists
  // every state as a button.
  await peek.getByRole("button", { name: /Todo/ }).first().click();
  await peek.getByRole("button", { name: /In progress/ }).first().click();
  await expect.poll(
    async () => fs.readFile(path.join(workspace, ".hivemind", "issues", "XX-1.md"), "utf8").catch(() => ""),
    { timeout: 6_000, intervals: [300] },
  ).toMatch(/state:\s*in_progress/);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 3_000 });
});

test("an issue's labels, its assignee's initial and every state's word read at 4.5:1 in every preset, dark and light, switched live", async () => {
  const card = page.locator('[data-tool-plugin="@hivemind/issues"]').getByRole("button", { name: "Open issue XX-2" });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await card.click();
  const peek = page.getByRole("dialog");
  await expect(peek).toBeVisible({ timeout: 5_000 });
  const picker = peek.getByRole("button", { name: /In progress/ }).first();
  const reads = (what: string, el: Locator, min = 4.5, on?: number[]) =>
    expect.poll(async () => { const [fg, bg] = await el.evaluate(painted); return contrast([fg!, on ?? bg!]); }, { message: what }).toBeGreaterThanOrEqual(min);
  const use = (p: (typeof PRESETS)[string]) => page.evaluate((a) => window.hive.settingsPatch(Object.entries(a).map(([k, value]) => ({ path: `appearance.${k}`, value }))),
    { preset: p.id, mode: p.mode, palette: p.palette, accent: p.accent });
  try {
    for (const p of Object.values(PRESETS)) {
      await use(p);
      await expect.poll(() => page.evaluate(() => [document.documentElement.dataset.preset, document.documentElement.dataset.themeMode])).toEqual([p.id, p.mode]);
      for (const l of LABELS) await reads(`label ${l} on ${p.id}`, peek.getByText(l, { exact: true }));
      await reads(`the assignee's initial on ${p.id}`, peek.locator('[title="@codex"]'));
      // The done criterion's tick is a mark, not a word: 3:1 on its green.
      await reads(`the done tick on ${p.id}`, peek.getByRole("checkbox", { name: "it reads" }), 3);
      // Each state is a word in the picker's menu, and on the picker itself once chosen.
      const [, onPicker] = await picker.evaluate(painted);
      await picker.click();
      for (const s of ["Backlog", "Todo", "In progress", "In review", "Done", "Cancelled"]) {
        const item = peek.locator(".hm-popover").getByRole("button", { name: s, exact: true });
        await reads(`${s} in the state menu on ${p.id}`, item);
        await reads(`${s} on the picker on ${p.id}`, item, 4.5, onPicker);
      }
      await picker.click();
    }
  } finally {
    await use(PRESETS.signal!);
    await page.keyboard.press("Escape");
  }
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 3_000 });
});
