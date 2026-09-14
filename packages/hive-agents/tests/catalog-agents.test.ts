// The agents the plugin catalog publishes are installed without a review when their CLI
// is found, so each must pass the strictest load: untrusted, no node half, no built-in id.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { defFromManifest, isGenericRuntime } from "../src/manifest.js";
import { BUILTIN_CATALOG } from "../src/catalog.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "examples", "agents");

for (const id of readdirSync(DIR)) {
  test(`${id} loads as an untrusted plugin and claims nothing a built-in owns`, () => {
    const def = defFromManifest(YAML.parse(readFileSync(join(DIR, id, "agent.yaml"), "utf8")), {
      reserved: BUILTIN_CATALOG.map((d) => d.id),
    });
    expect(def.id).toBe(id);
    expect(BUILTIN_CATALOG.some((b) => b.bin === def.bin)).toBe(false);
    expect(def.install?.url).toMatch(/^https:\/\//);
    expect(def.caps.turnSignal).toBe(false);
    // A command that runs anything says nothing about which agent it is, so it is never
    // added without a person reading it — a catalog agent that used one would just be skipped.
    expect(isGenericRuntime(def.bin)).toBe(false);
  });
}
