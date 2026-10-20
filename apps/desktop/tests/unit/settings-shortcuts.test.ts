// Settings → Shortcuts says which keys work even from inside a terminal: each of them has to be one
// the main process takes before the terminal does, or the page lists a key that does nothing there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SettingsPages from "../../src/renderer/src/settings-panels.tsx";
import { appKeyMessage, isQuitKey, type KeyInput } from "../../src/shared/shortcuts.ts";

const page = renderToStaticMarkup(createElement(SettingsPages, { page: "shortcuts", navigate: () => {} }));
const anywhere = /Anywhere[\s\S]*?<dl[^>]*>([\s\S]*?)<\/dl>/.exec(page)?.[1] ?? "";
const keys = [...anywhere.matchAll(/<kbd>([^<]+)<\/kbd>/g)].map((m) => m[1]!.replace(/&#x27;/g, "'").replace(/&amp;/g, "&"));

/** The key presses a row names: "⌘/Ctrl + ⇧ + E" is Ctrl+Shift+E; "1 … 9" is 1 and 9. */
function presses(row: string): KeyInput[] {
  const parts = row.split(" + ");
  const mod = parts[0] === "⌘/Ctrl";
  const shift = parts.includes("⇧");
  return parts.at(-1)!.split(" … ").map((key) => ({ key, control: mod, meta: false, shift, alt: false }));
}

test("every key listed as working anywhere is one the app takes before a terminal", () => {
  assert.ok(keys.length >= 5, `the Anywhere list was read: ${keys.join(", ")}`);
  for (const row of keys) {
    for (const p of presses(row)) {
      const taken = p.key === "F11" ? !p.control : appKeyMessage(p) !== null || isQuitKey(p, "linux");
      assert.ok(taken, `${row} is listed under Anywhere but the app does not take ${JSON.stringify(p)}`);
    }
  }
});
