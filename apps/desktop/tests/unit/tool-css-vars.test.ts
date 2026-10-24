/**
 * The app's CSS variables tool plugins read. A tool's tile runs in the app's page and paints with
 * `var(--color-line)` and the rest (258 uses across hivemind-plugins' tools), so these are a
 * frozen contract: each stays declared in the app's stylesheet, and removing or renaming one is a
 * Breaking change (the custom-view skill's reference.md, "Frozen"). The built page's values, in
 * every preset, are checked by e2e plugin-contract.spec.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/** The 11, as tools read them. The literal is the contract. */
const FROZEN = ["--color-bg", "--color-bg3", "--color-fg", "--color-fg3", "--color-line", "--color-select", "--color-ok", "--color-warn", "--color-err", "--color-info", "--font-mono"];

test("every CSS variable tools read is declared in the app's stylesheet", () => {
  const css = fs.readFileSync(path.join(import.meta.dirname, "../../src/renderer/src/styles.css"), "utf8");
  assert.deepEqual(FROZEN.filter((v) => !new RegExp(`^\\s*${v}\\s*:`, "m").test(css)), []);
});
