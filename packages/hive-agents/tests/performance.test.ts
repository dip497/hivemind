// The two costs a plugin architecture can quietly lose: building the catalog, which the
// toolbar's first frame waits on, and detection, which runs per tile per poll forever.
// Measured on a quiet machine: build ≈0.6ms for 16 agents, detect ≈43µs on a 1KB screen.
// The budgets below are ~20x that — they catch an architecture regression (a parser on the
// first frame, a detector gone quadratic), not a loaded CI box.
import { expect, test } from "bun:test";
import YAML from "yaml";
import { defFromManifest } from "../src/manifest.js";
import { getCatalog, setCatalog } from "../src/catalog.js";
import { AUTHORED, authoredYaml, authoredDefs } from "./authored.js";

/** Median of n runs: one descheduled run must not fail a build. */
function median(runs: number, fn: () => void): number {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    times.push(performance.now() - t);
  }
  return times.sort((a, b) => a - b)[Math.floor(runs / 2)]!;
}

test("validating every published agent stays off the first frame's critical path", () => {
  // The YAML read is the disk's cost, paid once in the async scan; what must stay cheap
  // is turning a manifest into a def.
  const raw = AUTHORED.map((a) => YAML.parse(authoredYaml(a)) as unknown);
  const build = () => raw.map((m) => defFromManifest(m, { trusted: false }));
  build(); // JIT warm-up: the first call of anything is not what a running app pays
  const ms = median(15, build);
  expect(ms, `catalog build took ${ms.toFixed(2)}ms for ${AUTHORED.length} agents`).toBeLessThan(12);
});

test("detection stays cheap on a big screen, for every agent that has a detector", () => {
  // A tall terminal, and the worst kind: every literal a rule looks for, none of them a match.
  const screen = ("working on it… thinking ❯ tokens esc to interrupt allow deny approve\n").repeat(60);
  setCatalog(authoredDefs());
  for (const def of getCatalog()) {
    if (!def.detect) continue;
    def.detect(screen);
    const ms = median(11, () => { for (let i = 0; i < 50; i++) def.detect!(screen); }) / 50;
    expect(ms, `${def.id} detect took ${(ms * 1000).toFixed(0)}µs on a ${screen.length}-char screen`).toBeLessThan(1);
  }
  setCatalog([]);
});
