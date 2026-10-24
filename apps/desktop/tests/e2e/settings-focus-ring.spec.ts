// A control reached with Tab shows the one focus ring (styles.css :focus-visible, 2px set 2px out).
// Settings' sidebar and pages scroll, and a box that scrolls cuts off whatever is drawn past its
// edges: a ring there loses a side. Every control in Settings, tabbed to as a person does, keeps its
// whole ring inside each box that would cut it.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-focus-ring-"));
const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, "config"), HIVEMIND_SHELL_ENV: "0" } as Record<string, string>;
delete env.ELECTRON_RUN_AS_NODE;
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  fs.mkdirSync(path.join(root, "repo"));
  app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox", `--user-data-dir=${path.join(root, "user-data")}`], cwd: path.join(root, "repo"), env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
});
test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

/** The focused control's ring, if a box it sits in cuts off a side of it: which side, and by how much. */
const cutRing = () => page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) return null;
  const s = getComputedStyle(el);
  if (s.outlineStyle === "none" || parseFloat(s.outlineWidth) === 0) return null;
  const out = parseFloat(s.outlineWidth) + parseFloat(s.outlineOffset);
  const r = el.getBoundingClientRect();
  const ring = { left: r.left - out, right: r.right + out };
  for (let box = el.parentElement; box; box = box.parentElement) {
    const b = getComputedStyle(box);
    if (!/auto|scroll|hidden|clip/.test(`${b.overflowX} ${b.overflowY}`)) continue;
    const at = box.getBoundingClientRect();
    // What a box shows: inside its borders, short of its scrollbar.
    const left = at.left + box.clientLeft, right = left + box.clientWidth;
    const cut = Math.max(left - ring.left, ring.right - right);
    if (cut > 0.5) return `${el.textContent?.trim().slice(0, 40) || el.getAttribute("aria-label") || el.tagName} loses ${cut.toFixed(1)}px of its ring to ${box.className || box.tagName}`;
  }
  return null;
});

test("every control in Settings, tabbed to, shows its whole focus ring", async () => {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "appearance" } })));
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const seen = new Set<string>();
  const cut: string[] = [];
  // Round the whole dialog once: Tab stays inside it, so the first control coming back ends the round.
  for (let i = 0; i < 200; i++) {
    await page.keyboard.press("Tab");
    const id = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return "";
      if (!el.dataset.ringSeen) el.dataset.ringSeen = String(Math.random());
      return el.dataset.ringSeen;
    });
    if (seen.has(id)) break;
    seen.add(id);
    const c = await cutRing();
    if (c) cut.push(c);
  }
  expect(seen.size).toBeGreaterThan(10);
  expect(cut).toEqual([]);
});
