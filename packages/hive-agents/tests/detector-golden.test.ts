// What a detector answers is the contract, not how it is written. These hashes were taken
// from the hand-written TypeScript detectors while they still existed; a manifest's rules
// must reproduce them screen for screen. Regenerate deliberately — and only when you meant
// to change what an agent's status says: `bun scripts/freeze-detectors.mjs`.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { defFromManifest } from "../src/manifest.js";
import { spawnArgsFor, spawnLabelFor } from "../src/catalog.js";
import type { SpawnOptions } from "../src/types.js";
import { CORPUS } from "./corpus.js";
import { AUTHORED, authoredYaml } from "./authored.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(HERE, "fixtures", "detector-golden.json"), "utf8")) as {
  screens: number;
  corpus: string;
  detectors: Record<string, string>;
  spawn: Record<string, Array<{ opts: SpawnOptions; args: string[]; label: string }>>;
};

describe("manifest detectors reproduce the frozen behaviour", () => {
  // The corpus is generated from the manifests' own literals, so adding one moves every
  // screen after it and with it every hash below. Checked first, and by content: without
  // this the whole suite goes red at once and reads like fifteen detectors broke.
  test("the corpus is the one the hashes were taken over", () => {
    expect(CORPUS.length).toBe(golden.screens);
    // Fed screen by screen: hashing one joined string of every screen at once does not
    // come out stable here.
    const h = createHash("sha256");
    for (const screen of CORPUS) h.update(screen).update("\u0000");
    // A moved corpus makes every hash below stale. Prove the detectors still answer the same
    // over the OLD corpus before re-freezing — a diff you can name, never a regenerate.
    expect(h.digest("hex")).toBe(golden.corpus);
  });

  for (const [id, hash] of Object.entries(golden.detectors)) {
    test(`${id} agrees on all ${golden.screens} screens`, () => {
      const agent = AUTHORED.find((a) => a.id === id);
      expect(agent, `${id} is no longer an agent this repository writes`).toBeDefined();
      const def = defFromManifest(YAML.parse(authoredYaml(agent!)) as unknown);
      expect(def.detect).toBeDefined();
      const states = CORPUS.map((screen) => def.detect!(screen)).join(",");
      expect(createHash("sha256").update(states).digest("hex")).toBe(hash);
    });
  }
});

describe("every agent this repository writes still launches the same way", () => {
  for (const [id, rows] of Object.entries(golden.spawn)) {
    test(`${id}: argv and tile label over every option combination`, () => {
      // Read from wherever it ships from: an agent that moves to the catalog is the same
      // agent, and must keep producing the same command line.
      const agent = AUTHORED.find((a) => a.id === id);
      expect(agent, `${id} is no longer an agent this repository writes`).toBeDefined();
      const def = defFromManifest(YAML.parse(authoredYaml(agent!)) as unknown);
      for (const row of rows) {
        expect(spawnArgsFor(def, row.opts)).toEqual(row.args);
        expect(spawnLabelFor(def, 2, row.opts)).toBe(row.label);
      }
    });
  }
});
