// Vendor each agent's own icon into the site. Every published agent manifest carries its
// mark as SVG shapes, so the strip can show the real logos instead of names.
//
//   node scripts/sync-agent-icons.mjs [--check]
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// The published manifests: the same files a HiveHub install drops into the user's agents
// folder. Nothing ships in the app, so what HiveHub lists is the whole catalog.
const PUBLISHED = path.resolve(here, "../../packages/hive-agents/tests/fixtures/published-agents");
const OUT = path.resolve(here, "../src/generated/agent-icons.json");
const check = process.argv.includes("--check");

// A container build has only docs/ in its context and no yaml parser of its own: the vendored
// JSON is committed for exactly that case, and regenerating without the published manifests
// would quietly drop every agent.
let parse;
try { ({ parse } = await import("yaml")); } catch { parse = null; }
if (!parse || !existsSync(PUBLISHED)) {
  const why = !parse ? "no yaml parser here" : "published agent manifests are not in this checkout";
  if (check) { console.error(`icons: cannot verify — ${why}`); process.exit(1); }
  if (!existsSync(OUT)) { console.error(`icons: ${why} and no vendored copy at ${OUT}`); process.exit(1); }
  console.log(`agent icons: ${why} — keeping the vendored copy`);
  process.exit(0);
}

/** The shapes a manifest draws, flattened to what an <svg> needs and nothing more. */
const iconOf = (m) => {
  const i = m?.icon;
  if (!i?.shapes?.length) return null;
  const paths = i.shapes.map((s) => s?.path?.d).filter(Boolean);
  if (!paths.length) return null;
  return { viewBox: i.viewBox ?? "0 0 24 24", fillRule: i.attrs?.fillRule, paths };
};

const agents = [];
const seen = new Set();
// Counted from the manifests themselves, not from the icons: droid ships without a mark, and a
// strip that counts icons would quietly under-report what the registry carries.
let total = 0;

// openclaw is a test-only fixture: it is not on the registry.
for (const f of readdirSync(PUBLISHED).filter((n) => !n.startsWith(".") && n !== "openclaw").sort()) {
  const file = path.join(PUBLISHED, f, "agent.yaml");
  if (!existsSync(file)) continue;
  try {
    const m = parse(readFileSync(file, "utf8"));
    if (m?.id) total += 1;
    const icon = iconOf(m);
    if (m?.id && icon && !seen.has(m.id)) { seen.add(m.id); agents.push({ id: m.id, label: m.label ?? m.id, published: true, icon }); }
  } catch (e) { console.error(`icons: ${f} — ${e.message}`); }
}


const payload = JSON.stringify({ count: agents.length, total, agents }, null, 2) + "\n";
if (check) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (current !== payload) { console.error("agent icons are stale: run `npm run icons:sync` in docs/"); process.exit(1); }
  console.log(`agent icons current — ${agents.length}`);
} else if (agents.length) {
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, payload);
  console.log(`agent icons synced — ${agents.length}`);
} else if (!existsSync(OUT)) {
  console.error("icons: no manifests found and no vendored copy");
  process.exit(1);
} else {
  console.log("icons: no manifests present — keeping the vendored copy");
}
