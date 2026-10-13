import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// The harness (docs/design/browser-app-2026-10-13.md): the canvas, terminal, git and issue specs,
// run in a browser tab on the app, which serves itself to Chromium over its browser server. Each
// spec launches its window through tests/e2e/helpers/window.ts, which reads this. Set HIVE_HARNESS_CHROMIUM to a Chromium binary
// when Playwright's own is not installed.
process.env.HIVE_HARNESS = "browser";

export default defineConfig({
  ...base,
  testMatch: [
    "tile-move.spec.ts",
    "resize.spec.ts",
    "frame.spec.ts",
    "keyboard-gate.spec.ts",
    "terminal-io.spec.ts",
    "editor.spec.ts",
    "shipped-features.spec.ts",
    "issue-create.spec.ts",
    "issues-tile.spec.ts",
  ],
});
