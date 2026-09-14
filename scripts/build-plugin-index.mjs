#!/usr/bin/env node
// Rebuild plugins/: copy each listed plugin's built files under plugins/<type>s/<id>/
// and write plugins/index.json with every file's SHA-256. Run after changing an example.
//   node scripts/build-plugin-index.mjs
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "plugins");
// --check reads only: it never touches plugins/, so a drift check leaves the tree alone.
const check = process.argv.includes("--check");

// Every listed plugin: where its built files are, and what the catalog says about it.
const VIEWS = ["orbit", "office", "solar", "painted-controls"];

function walk(dir, base = dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join("/")];
  }).sort();
}

const plugins = VIEWS.map((id) => {
  const src = path.join(root, "examples", "views", id);
  const dist = path.join(src, "dist");
  if (!existsSync(path.join(dist, "hivemind-view.json"))) throw new Error(`${id}: build it first (npm run build in examples/views/${id})`);
  const manifest = JSON.parse(readFileSync(path.join(dist, "hivemind-view.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(path.join(src, "package.json"), "utf8"));
  const dest = path.join(out, "views", id);
  if (!check) {
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    cpSync(dist, dest, { recursive: true });
  }
  const from = check ? dist : dest;
  return {
    id: manifest.id,
    type: "view",
    name: manifest.name,
    description: String(pkg.description ?? "").replace(/^Example community view for hivemind: /, "").replace(/^./, (c) => c.toUpperCase()),
    author: "Hivemind",
    version: manifest.version,
    path: `views/${id}`,
    files: walk(from).map((file) => ({ path: file, sha256: createHash("sha256").update(readFileSync(path.join(from, file))).digest("hex") })),
    homepage: `https://github.com/dip497/hivemind/tree/main/examples/views/${id}`,
  };
});

// Agents: a manifest describing a CLI you install yourself. `bin` is what auto-install
// looks for on PATH; the manifest must name the same binary or it is not installed.
const AGENTS = {
  aider: { description: "AI pair programming in your terminal, with git built in.", homepage: "https://github.com/Aider-AI/aider" },
  "mistral-vibe": { description: "Mistral's terminal coding agent.", homepage: "https://github.com/mistralai/mistral-vibe" },
  "qwen-code": { description: "Alibaba's open-source terminal coding agent.", homepage: "https://github.com/QwenLM/qwen-code" },
  auggie: { description: "Augment Code's agent CLI, backed by its context engine.", homepage: "https://github.com/augmentcode/auggie" },
  crush: { description: "Charm's terminal coding agent for many model providers.", homepage: "https://github.com/charmbracelet/crush" },
  continue: { description: "Continue's terminal coding agent.", homepage: "https://github.com/continuedev/continue" },
  openhands: { description: "The OpenHands agent in your terminal.", homepage: "https://github.com/OpenHands/OpenHands-CLI" },
};
const field = (yaml, key) => yaml.match(new RegExp(`^${key}: "?([^"\\n]+)"?$`, "m"))?.[1];
for (const [id, meta] of Object.entries(AGENTS)) {
  const src = path.join(root, "examples", "agents", id, "agent.yaml");
  const yaml = readFileSync(src, "utf8");
  if (field(yaml, "id") !== id) throw new Error(`${id}: agent.yaml has a different id`);
  const dest = path.join(out, "agents", id);
  if (!check) {
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    cpSync(src, path.join(dest, "agent.yaml"));
  }
  plugins.push({
    id, type: "agent", name: field(yaml, "label"), description: meta.description, author: "Hivemind", version: "1.0.0",
    path: `agents/${id}`, bin: field(yaml, "bin"),
    files: [{ path: "agent.yaml", sha256: createHash("sha256").update(readFileSync(check ? src : path.join(dest, "agent.yaml"))).digest("hex") }],
    homepage: meta.homepage,
  });
}

const index = JSON.stringify({ version: 1, plugins }, null, 2) + "\n";
if (check) {
  // What has to hold for an install to work: every file the index lists is in plugins/
  // with the hash it claims, and no plugin ships a file the index does not cover. An
  // agent's manifest is a plain copy, so it must also still match its source. View
  // bundles are NOT rebuilt here — a build on another machine need not be byte-identical.
  const listed = JSON.parse(readFileSync(path.join(out, "index.json"), "utf8"));
  const problems = [];
  for (const p of listed.plugins) {
    const dir = path.join(out, p.path);
    for (const f of p.files) {
      const file = path.join(dir, f.path);
      if (!existsSync(file)) { problems.push(`${p.id}: ${f.path} is listed but missing`); continue; }
      const sha = createHash("sha256").update(readFileSync(file)).digest("hex");
      if (sha !== f.sha256) problems.push(`${p.id}: ${f.path} does not match its hash`);
    }
    const extra = walk(dir).filter((f) => !p.files.some((listedFile) => listedFile.path === f));
    for (const f of extra) problems.push(`${p.id}: ${f} is in plugins/ but not in the index`);
    if (p.type === "agent") {
      const src = path.join(root, "examples", "agents", p.id, "agent.yaml");
      if (readFileSync(src, "utf8") !== readFileSync(path.join(dir, "agent.yaml"), "utf8")) problems.push(`${p.id}: agent.yaml differs from examples/agents/${p.id}`);
    }
  }
  for (const p of plugins) if (!listed.plugins.some((e) => e.id === p.id)) problems.push(`${p.id} is not in the index`);
  if (problems.length) {
    console.error(problems.join("\n"));
    console.error("run: node scripts/build-plugin-index.mjs");
    process.exit(1);
  }
  console.log(`plugins/index.json is current: ${listed.plugins.length} plugins`);
} else {
  writeFileSync(path.join(out, "index.json"), index);
  console.log(`plugins/index.json: ${plugins.length} plugins`);
}
