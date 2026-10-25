// A diff's colours are worked out in @hivemind/core/diff-colours, from a model of how Pierre draws on
// its page: how much of the page a changed row, its line number's gutter and a folded run's bar keep
// under their tint (`PIERRE_MIX`). Every contrast it promises (its own test, every built-in preset;
// the theme check, every theme) holds only while that model is Pierre's, so it is held to the
// stylesheet the app loads, from the installed @pierre/diffs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PIERRE_MIX } from "@hivemind/core/diff-colours";

const css = fs.readFileSync(path.join(import.meta.dirname, "../../node_modules/@pierre/diffs/dist/style.js"), "utf8");

/** The `--mix-light` / `--mix-dark` a selector sets. */
function mixes(selector: string) {
  const at = css.indexOf(`${selector}{--mix-light:`);
  assert.ok(at >= 0, `Pierre mixes ${selector} with its tint`);
  const [, light, dark] = /--mix-light:(\d+)%;--mix-dark:(\d+)%/.exec(css.slice(at))!;
  return { light: Number(light) / 100, dark: Number(dark) / 100 };
}
/** The page's share in a variable Pierre writes as `light-dark(color-mix(in lab, bg L%, x), color-mix(in lab, bg D%, x))`. */
function pageShare(variable: string, other: string) {
  const m = new RegExp(String.raw`${variable}:var\(${variable}-override,light-dark\(color-mix\(in lab, var\(--diffs-bg\) (\d+)%, var\(${other}\)\),color-mix\(in lab, var\(--diffs-bg\) (\d+)%, var\(${other}\)\)\)\)`).exec(css);
  assert.ok(m, `Pierre writes ${variable} as the page mixed with ${other}`);
  return { light: Number(m[1]) / 100, dark: Number(m[2]) / 100 };
}

test("a changed row, its line number and a folded run's bar keep as much of the page as the colours were worked out for", () => {
  assert.deepEqual(mixes("& [data-line],& [data-no-newline]"), PIERRE_MIX.row);
  assert.deepEqual(mixes("& [data-gutter-buffer],& [data-column-number]"), PIERRE_MIX.gutter);
  // A removed line's hatched bar: its dark stripe is this, put back as Pierre's own (PIERRE_OPTIONS).
  assert.deepEqual(pageShare("--diffs-bg-deletion", "--diffs-deletion-base"), PIERRE_MIX.row);
  // The bar mixes the page with white on a dark page and black on a light one.
  assert.deepEqual(pageShare("--diffs-bg-separator", "--diffs-mixer"), PIERRE_MIX.separator);
  assert.match(css, /--diffs-mixer:light-dark\(#000,#fff\)/);
});
