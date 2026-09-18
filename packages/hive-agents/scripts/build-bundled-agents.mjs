#!/usr/bin/env bun
// manifests/*.yaml → src/bundled-manifests.ts, the agents that ship in the box.
// Data, not code: the renderer needs the catalog on its first frame, so this is a compiled
// literal rather than a disk read, and no YAML parser reaches the bundle.
//   bun scripts/build-bundled-agents.mjs [--check]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

// Which agents ship inside the app, in picker order. A product decision, not an
// architectural one: every agent is a manifest, and the rest of ours live in the catalog
// (published on HiveHub), added automatically when their CLI is found. What earns a place here
// is needing the daemon before it can work at all — a hook to inject, a private
// configuration home to build, a session to resume — so a first run with no network still
// has agents that do the whole job.
// openclaw is here for a different reason than the rest: it is a placeholder with no
// install page and nothing to spawn yet, so there is nothing to publish.
const ORDER = ["claude", "codex", "cursor", "droid", "pi", "kiro", "openclaw"];

const onDisk = new Set(
  (await Array.fromAsync(new Bun.Glob("*.yaml").scan({ cwd: join(ROOT, "manifests") })))
    .map((f) => f.replace(/\.yaml$/, "")),
);
for (const id of ORDER) if (!onDisk.has(id)) throw new Error(`${id} is in the order but has no manifest`);
for (const id of onDisk) if (!ORDER.includes(id)) throw new Error(`${id} has a manifest but no place in the order`);

const bundled = ORDER.map((id) => ({
  id,
  // A daemon half exists as a file, not as a claim a manifest can make about itself.
  nodeHalf: existsSync(join(ROOT, "src", "providers", id, "node.ts")),
  manifest: YAML.parse(readFileSync(join(ROOT, "manifests", `${id}.yaml`), "utf8")),
}));

// Asset contents go in their own module: the renderer imports the catalog on its first
// frame and has no use for a bridge extension's source.
const assets = {};
for (const a of bundled) {
  for (const asset of a.manifest.assets ?? []) {
    const file = join(ROOT, "manifests", "assets", a.id, asset.file);
    if (!existsSync(file)) throw new Error(`${a.id}: assets/${a.id}/${asset.file} is missing`);
    (assets[a.id] ??= {})[asset.file] = readFileSync(file, "utf8");
  }
}

const assetsOut = `// Generated from manifests/assets/** by scripts/build-bundled-agents.mjs — do not edit.
// Daemon-side only: what each bundled agent needs written to disk before it runs.

export const BUNDLED_ASSETS: Readonly<Record<string, Readonly<Record<string, string>>>> = ${JSON.stringify(assets, null, 2)};
`;

const out = `// Generated from manifests/*.yaml by scripts/build-bundled-agents.mjs — do not edit.
// An agent that ships in the box is the same thing anyone else can write: a manifest.
import type { BundledAgent } from "./types.js";

export const BUNDLED_AGENTS: readonly BundledAgent[] = ${JSON.stringify(bundled, null, 2)} as const;
`;

const file = join(ROOT, "src", "bundled-manifests.ts");
const assetsFile = join(ROOT, "src", "bundled-assets.ts");
if (check) {
  if (readFileSync(file, "utf8") !== out || readFileSync(assetsFile, "utf8") !== assetsOut) {
    console.error("src/bundled-manifests.ts is out of date — run: bun scripts/build-bundled-agents.mjs");
    process.exit(1);
  }
  console.log(`bundled-manifests.ts is current: ${bundled.length} agents`);
} else {
  writeFileSync(file, out);
  writeFileSync(assetsFile, assetsOut);
  console.log(`src/bundled-manifests.ts: ${bundled.length} agents, ${Object.keys(assets).length} with assets`);
}
