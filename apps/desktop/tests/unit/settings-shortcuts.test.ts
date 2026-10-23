// Settings → Shortcuts and the guide's table name the keys the keymap (shared/keymap.ts) answers,
// as each platform writes them, and every action in it: a key listed that the app does not take, or
// an action left out, is a list that drifted from the keys (the page showed ⌘ Tab, bound as Ctrl+Tab).
// On Windows and Linux the system takes the keys held with Super (the Windows key): none is named there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SettingsPages from "../../src/renderer/src/settings-panels.tsx";
import { FontStepper, handleFontKey } from "../../src/renderer/src/tile-font.tsx";
import { actionsFor, KEYMAP, labelsOf, type Action, type Where } from "../../src/shared/keymap.ts";
import type { KeyPress } from "@hivemind/view-sdk/commands";

type OS = "mac" | "linux" | "windows";
const PLATFORM: Record<OS, string> = { mac: "MacIntel", linux: "Linux x86_64", windows: "Win32" };
const SECTION: Record<Where, string> = { anywhere: "Anywhere", canvas: "On the canvas", terminal: "In a terminal" };

const MAC_MOD: Record<string, "ctrlKey" | "altKey" | "shiftKey" | "metaKey"> = { "⌃": "ctrlKey", "⌥": "altKey", "⇧": "shiftKey", "⌘": "metaKey" };
const PC_MOD: Record<string, "ctrlKey" | "altKey" | "shiftKey" | "metaKey"> = { Ctrl: "ctrlKey", Alt: "altKey", Shift: "shiftKey", Super: "metaKey", Win: "metaKey" };
const NAMED: Record<string, [string, string]> = {
  Esc: ["Escape", "Escape"], Tab: ["Tab", "Tab"], Enter: ["Enter", "Enter"], Space: [" ", "Space"],
  "⌫": ["Backspace", "Backspace"], Backspace: ["Backspace", "Backspace"], "⌦": ["Delete", "Delete"], Delete: ["Delete", "Delete"],
};
const PLACE: Record<string, string> = { "`": "Backquote", ",": "Comma", ".": "Period", "=": "Equal", "-": "Minus", "−": "Minus", "+": "Equal", "\\": "Backslash" };

/** The key press a label names, read as a person on `os` would: "⌃⇧Tab" on a Mac, "Ctrl+Shift+Tab" elsewhere. */
function pressOf(label: string, os: OS): KeyPress {
  const p: KeyPress = { key: "", code: "", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
  let key: string;
  if (os === "mac") {
    let i = 0;
    while (MAC_MOD[label[i]!]) p[MAC_MOD[label[i++]!]!] = true;
    key = label.slice(i);
  } else {
    const parts = label.endsWith("++") ? [...label.slice(0, -2).split("+"), "+"] : label.split("+");
    key = parts.pop()!;
    for (const m of parts) {
      if (!PC_MOD[m]) throw new Error(`"${label}": ${m} is not a modifier on ${os}`);
      p[PC_MOD[m]] = true;
    }
  }
  if (/^[A-Z]$/.test(key)) return { ...p, key: p.shiftKey ? key : key.toLowerCase(), code: `Key${key}` };
  if (/^\d$/.test(key)) return { ...p, key, code: `Digit${key}` };
  if (/^F\d+$/.test(key)) return { ...p, key, code: key };
  if (NAMED[key]) return { ...p, key: NAMED[key][0], code: NAMED[key][1] };
  if (PLACE[key]) return { ...p, key: key === "−" ? "-" : key, code: PLACE[key] };
  throw new Error(`"${label}" names no key`);
}

/** Every press a label names: "⌘1 … ⌘9" is nine. */
function pressesOf(label: string, os: OS): KeyPress[] {
  const [from, to] = label.split(" … ");
  if (!to) return [pressOf(label, os)];
  const a = pressOf(from!, os), b = pressOf(to, os);
  const digits = Array.from({ length: Number(b.key) - Number(a.key) + 1 }, (_, i) => String(Number(a.key) + i));
  return digits.map((d) => ({ ...a, key: d, code: `Digit${d}` }));
}

/** A key the system takes before the app: on Windows and Linux, one held with Super. */
const systemKey = (keys: string, os: OS) => os !== "mac" && keys.split("+").includes("meta");

/** What is wrong with a list of keys for one place: a key the app does not take there, an action it
 *  leaves out, a key the system takes. "—": no key on this platform. */
function drift(where: Where, labels: string[], os: OS): string[] {
  const wrong: string[] = [];
  const answered = new Set<Action>();
  for (const label of labels) {
    if (label === "—") continue;
    if (os !== "mac" && /\b(Super|Win)\b/.test(label)) wrong.push(`"${label}" is listed on ${os}, where the system takes it`);
    let presses: KeyPress[];
    try { presses = pressesOf(label, os); } catch (e) { wrong.push((e as Error).message); continue; }
    for (const p of presses) {
      const acts = actionsFor(p, where, os === "mac");
      if (!acts.length) wrong.push(`"${label}" is listed under ${SECTION[where]}, but on ${os} the app does not take it there`);
      for (const a of acts) answered.add(a);
    }
  }
  for (const b of KEYMAP) if (b.where === where && !systemKey(b.keys, os) && !answered.has(b.action)) wrong.push(`${b.action} (${b.keys}) is not listed under ${SECTION[where]} on ${os}`);
  return [...new Set(wrong)];
}

const unescape = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** The page as a person on `os` sees it: the window reads the platform from the browser. */
function pageOn(os: OS): string {
  Object.defineProperty(globalThis, "navigator", { value: { platform: PLATFORM[os] }, configurable: true });
  return renderToStaticMarkup(createElement(SettingsPages, { page: "shortcuts", navigate: () => {} }));
}

test("Settings → Shortcuts lists every key of the keymap, as each platform writes it", () => {
  for (const os of ["mac", "linux", "windows"] as const) {
    const page = pageOn(os);
    for (const where of ["anywhere", "canvas", "terminal"] as const) {
      const section = new RegExp(`<section[^>]*aria-label="${SECTION[where]}"[^>]*>([\\s\\S]*?)</section>`).exec(page)?.[1] ?? "";
      const labels = [...section.matchAll(/<kbd>([^<]+)<\/kbd>/g)].map((m) => unescape(m[1]!));
      assert.ok(labels.length > 0, `the ${SECTION[where]} section was read on ${os}`);
      assert.deepEqual(drift(where, labels, os), []);
    }
    // Everyday keys first: Quit is the last of the keys that work anywhere.
    const anywhere = new RegExp(`<section[^>]*aria-label="${SECTION.anywhere}"[^>]*>([\\s\\S]*?)</section>`).exec(page)?.[1] ?? "";
    assert.match([...anywhere.matchAll(/<dd>([^<]+)<\/dd>/g)].at(-1)?.[1] ?? "", /^Quit/, `Quit is listed last under Anywhere on ${os}`);
  }
});

test("the guide's table lists every key of the keymap, for a Mac and for Windows and Linux", () => {
  const guide = readFileSync(new URL("../../../../guide/(reference)/keyboard-shortcuts.mdx", import.meta.url), "utf8");
  for (const where of ["anywhere", "canvas", "terminal"] as const) {
    const body = new RegExp(`\\n## ${SECTION[where]}\\n([\\s\\S]*?)(?=\\n## |$)`).exec(guide)?.[1] ?? "";
    // A row's first cell: "⌘⇧A / Ctrl+Shift+A", or one label both write the same ("F11").
    const cells = [...body.matchAll(/^\| ([^|]+?) \|/gm)].map((m) => m[1]!.replace(/\\`/g, "`")).filter((c) => !/^(Keys|-+)$/.test(c));
    assert.ok(cells.length > 0, `the guide's ${SECTION[where]} table was read`);
    for (const os of ["mac", "linux"] as const) {
      const labels = cells.map((c) => {
        const both = c.split(" / ");
        return both.length === 1 ? c : both.length === 2 ? both[os === "mac" ? 0 : 1]! : `${c} (not "Mac / others")`;
      });
      assert.deepEqual(drift(where, labels, os), []);
    }
  }
});

test("each font button's tooltip names a key that handleFontKey sizes the text with, on each platform", () => {
  // FontStepper sits on the editor, diff and plan tiles, whose keys go through handleFontKey.
  const font = { size: 13, inc() {}, dec() {}, reset() {}, set() {}, best() {} };
  for (const os of ["mac", "linux", "windows"] as const) {
    Object.defineProperty(globalThis, "navigator", { value: { platform: PLATFORM[os] }, configurable: true });
    const html = unescape(renderToStaticMarkup(createElement(FontStepper, font)));
    for (const [does, word] of [["dec", "Smaller"], ["reset", "Reset"], ["inc", "Larger"]] as const) {
      const key = new RegExp(`title="${word}[^"(]*\\(([^)]+)\\)"`).exec(html)?.[1];
      assert.ok(key, `the ${word} button names a key on ${os}`);
      for (const press of pressesOf(key, os)) {
        const ran: string[] = [];
        let taken = false;
        const handled = handleFontKey({ ...press, preventDefault: () => { taken = true; } }, { inc: () => ran.push("inc"), dec: () => ran.push("dec"), reset: () => ran.push("reset") });
        assert.deepEqual([handled, taken, ran], [true, true, [does]], `"${key}" runs ${does} on ${os}`);
      }
    }
  }
});

test("a hint names the key held with this platform's own modifier, and it runs the action", () => {
  // Layers is ⌘B from anywhere on a Mac; elsewhere Super+B is the system's, so only Ctrl+B is named.
  assert.equal(labelsOf("toggle-layers", "mac")[0], "⌘B");
  assert.deepEqual(labelsOf("toggle-layers", "linux"), ["Ctrl+B"]);
  assert.deepEqual(labelsOf("toggle-layers", "windows"), ["Ctrl+B"]);
  for (const os of ["mac", "linux", "windows"] as const) {
    for (const action of new Set(KEYMAP.map((b) => b.action))) {
      const runs = pressesOf(labelsOf(action, os)[0]!, os).some((p) => (["anywhere", "canvas", "terminal"] as const).some((w) => actionsFor(p, w, os === "mac").includes(action)));
      assert.ok(runs, `the hint for ${action} on ${os} runs it`);
    }
  }
});
