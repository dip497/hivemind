// A machine's link where it shows (its chip, Layers, the Machines hub, a terminal's banner): each
// state is a shape and a word, never colour alone, and a mark shown without its word says it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MachineDot, statusWords } from "../../src/renderer/src/machines/status.tsx";
import type { MachineState } from "../../src/shared/ipc";

const STATES: MachineState[] = ["idle", "connecting", "online", "reconnecting", "offline", "attention", "no-hive"];
/** Every state, and a machine the person switched off. */
const CASES = [...STATES.map((state) => ({ state, enabled: true })), { state: "online" as const, enabled: false }];
const dot = (c: (typeof CASES)[number], named = true) =>
  renderToStaticMarkup(createElement(MachineDot, { status: { state: c.state, at: 0 }, enabled: c.enabled, named }));
const shape = (html: string) => /<path d="([^"]+)"/.exec(html)?.[1];

test("each machine state, and paused, has its own shape and its own word", () => {
  const shapes = CASES.map((c) => shape(dot(c)));
  assert.ok(shapes.every(Boolean), "every state draws a shape");
  assert.equal(new Set(shapes).size, CASES.length, "a shape per state");
  const words = CASES.map((c) => statusWords({ state: c.state, at: 0 }, c.enabled));
  assert.equal(new Set(words).size, CASES.length, "a word per state");
});

test("a mark shown without its word carries the word as its name; beside its word it is hidden", () => {
  for (const c of CASES) {
    const word = statusWords({ state: c.state, at: 0 }, c.enabled);
    assert.match(dot(c), new RegExp(`role="img" aria-label="${word}"`), `${c.state}${c.enabled ? "" : " paused"}`);
    assert.match(dot(c, false), /aria-hidden="true"/);
  }
});

test("only signing in pulses: it is the one machine state that waits on the person", () => {
  assert.deepEqual(CASES.filter((c) => dot(c).includes("animate-pulse")).map((c) => c.state), ["attention"]);
});
