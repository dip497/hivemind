// Vendor each agent's own icon into the site. Every provider manifest carries its mark as SVG
// shapes — the bundled ones in packages/hive-agents/manifests, the catalog ones inside the
// `manifest` string of plugins.json — so the strip can show the real logos instead of names.
//
//   node scripts/sync-agent-icons.mjs [--check]
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED = path.resolve(here, "../../packages/hive-agents/manifests");
const CATALOG = path.resolve(here, "../src/data/plugins.json");
const OUT = path.resolve(here, "../src/generated/agent-icons.json");
const check = process.argv.includes("--check");

// A container build has only docs/ in its context and no yaml parser of its own: the vendored
// JSON is committed for exactly that case, and regenerating without the bundled manifests would
// quietly drop the agents that ship in the app.
let parse;
try { ({ parse } = await import("yaml")); } catch { parse = null; }
if (!parse || !existsSync(BUNDLED)) {
  const why = !parse ? "no yaml parser here" : "provider manifests are not in this checkout";
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
// strip that counts icons would quietly under-report what the app carries.
let bundledTotal = 0, catalogTotal = 0;

// Bundled first: these ship in the app, and the strip says so.
if (existsSync(BUNDLED)) {
  for (const f of readdirSync(BUNDLED).filter((n) => n.endsWith(".yaml")).sort()) {
    try {
      const m = parse(readFileSync(path.join(BUNDLED, f), "utf8"));
      if (m?.id) bundledTotal += 1;
      const icon = iconOf(m);
      if (m?.id && icon && !seen.has(m.id)) { seen.add(m.id); agents.push({ id: m.id, label: m.label ?? m.id, bundled: true, icon }); }
    } catch (e) { console.error(`icons: ${f} — ${e.message}`); }
  }
}

// Then the catalog, whose manifests live as a YAML string on each entry.
if (existsSync(CATALOG)) {
  const catalog = JSON.parse(readFileSync(CATALOG, "utf8"));
  for (const p of catalog.plugins.filter((x) => x.type === "agent")) {
    catalogTotal += 1;
    if (seen.has(p.id) || !p.manifest) continue;
    try {
      const icon = iconOf(parse(p.manifest));
      if (icon) { seen.add(p.id); agents.push({ id: p.id, label: p.name ?? p.id, bundled: false, icon }); }
    } catch (e) { console.error(`icons: ${p.id} — ${e.message}`); }
  }
}

const payload = JSON.stringify({ count: agents.length, bundledTotal, catalogTotal, agents }, null, 2) + "\n";
if (check) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (current !== payload) { console.error("agent icons are stale: run `npm run icons:sync` in docs/"); process.exit(1); }
  console.log(`agent icons current — ${agents.length}`);
} else if (agents.length) {
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, payload);
  console.log(`agent icons synced — ${agents.length} (${agents.filter((a) => a.bundled).length} bundled)`);
} else if (!existsSync(OUT)) {
  console.error("icons: no manifests found and no vendored copy");
  process.exit(1);
} else {
  console.log("icons: no manifests present — keeping the vendored copy");
}
