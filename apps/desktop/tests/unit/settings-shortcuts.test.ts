// Settings → Shortcuts says which keys work even from inside a terminal: each of them has to be one
// the main process takes before the terminal does, or the page lists a key that does nothing there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SettingsPages from "../../src/renderer/src/settings-panels.tsx";
import { actionsFor } from "../../src/shared/keymap.ts";
import type { KeyPress } from "@hivemind/view-sdk/commands";

const page = renderToStaticMarkup(createElement(SettingsPages, { page: "shortcuts", navigate: () => {} }));
const anywhere = /Anywhere[\s\S]*?<dl[^>]*>([\s\S]*?)<\/dl>/.exec(page)?.[1] ?? "";
const keys = [...anywhere.matchAll(/<kbd>([^<]+)<\/kbd>/g)].map((m) => m[1]!.replace(/&#x27;/g, "'").replace(/&amp;/g, "&"));

const PLACE: Record<string, string> = { "`": "Backquote", ",": "Comma", ".": "Period" };

/** The key presses a row names: "⌘/Ctrl + ⇧ + E" is Ctrl+Shift+E; "1 … 9" is 1 and 9. */
function presses(row: string): KeyPress[] {
  const parts = row.split(" + ");
  const mod = parts[0] === "⌘/Ctrl";
  const shift = parts.includes("⇧");
  return parts.at(-1)!.split(" … ").map((key) => {
    const code = /^[A-Z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : PLACE[key] ?? key;
    return { key, code, ctrlKey: mod, metaKey: false, shiftKey: shift, altKey: false };
  });
}

test("every key listed as working anywhere is one the app takes before a terminal", () => {
  assert.ok(keys.length >= 5, `the Anywhere list was read: ${keys.join(", ")}`);
  for (const row of keys) {
    for (const p of presses(row)) {
      const taken = actionsFor(p, "anywhere", false).length > 0;
      assert.ok(taken, `${row} is listed under Anywhere but the app does not take ${JSON.stringify(p)}`);
    }
  }
});
