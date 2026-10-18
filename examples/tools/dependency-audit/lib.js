// Reading lockfiles and the public OSV database's answers. No imports: the tests load it as it is.

/** The lockfiles this reads, by file name, and the OSV ecosystem their packages are in. */
export const LOCKFILES = {
  "Cargo.lock": "crates.io",
  "package-lock.json": "npm",
  "yarn.lock": "npm",
  "pnpm-lock.yaml": "npm",
  "uv.lock": "PyPI",
  "poetry.lock": "PyPI",
  "requirements.txt": "PyPI",
};

/** The lockfiles among `git ls-files` output, leaving out vendored copies. */
export function findLockfiles(lsFiles) {
  return lsFiles.split("\n").map((l) => l.trim())
    .filter((f) => f && LOCKFILES[f.split("/").pop()] && !/(^|\/)(node_modules|vendor|\.venv)\//.test(f));
}

/** `[[package]]` tables of a TOML lockfile (Cargo, uv, poetry): their name, version and source line. */
function tomlPackages(text) {
  const out = [];
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const body = block.split(/^\[(?!\[package\]\])/m)[0];
    const name = /^name\s*=\s*"([^"]+)"/m.exec(body)?.[1];
    const version = /^version\s*=\s*"([^"]+)"/m.exec(body)?.[1];
    const source = /^source\s*=\s*(.+)$/m.exec(body)?.[1] ?? null;
    if (name && version) out.push({ name, version, source });
  }
  return out;
}

/** `name@range` or `@scope/name@range`: the name. */
function specName(spec) {
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

/** The packages a lockfile pins: `{ name, version }`, each once. */
export function parseLockfile(file, text) {
  const base = file.split("/").pop();
  let list = [];
  if (base === "Cargo.lock") {
    // A crate with no source is one of the workspace's own.
    list = tomlPackages(text).filter((p) => p.source);
  } else if (base === "uv.lock") {
    list = tomlPackages(text).filter((p) => !p.source || !/editable|virtual|path\s*=|directory/.test(p.source));
  } else if (base === "poetry.lock") {
    list = tomlPackages(text);
  } else if (base === "package-lock.json") {
    const lock = JSON.parse(text);
    if (lock.packages) {
      for (const [where, p] of Object.entries(lock.packages)) {
        // "" is the project, a key without node_modules/ one of its workspaces; a link has no version.
        if (!where.includes("node_modules/") || !p.version) continue;
        list.push({ name: p.name ?? where.slice(where.lastIndexOf("node_modules/") + 13), version: p.version });
      }
    } else {
      const walk = (deps) => {
        for (const [name, p] of Object.entries(deps ?? {})) {
          if (p.version && !/^(file|link|git)/.test(p.version)) list.push({ name, version: p.version });
          walk(p.dependencies);
        }
      };
      walk(lock.dependencies);
    }
  } else if (base === "yarn.lock") {
    let names = null;
    for (const line of text.split("\n")) {
      if (/^\S.*:\s*$/.test(line) && !line.startsWith("#")) {
        const first = line.replace(/:\s*$/, "").split(",")[0].trim().replace(/^"|"$/g, "");
        names = first === "__metadata" || /@(workspace|link|file|portal|patch):/.test(first) ? null : specName(first);
        continue;
      }
      const v = /^\s+version:?\s+"?([^"\s]+)"?\s*$/.exec(line);
      if (v && names) { list.push({ name: names, version: v[1] }); names = null; }
    }
  } else if (base === "pnpm-lock.yaml") {
    let inPackages = false;
    for (const line of text.split("\n")) {
      if (/^\S/.test(line)) { inPackages = /^packages:\s*$/.test(line); continue; }
      if (!inPackages) continue;
      const m = /^ {2}'?([^'\s][^']*?)'?:\s*$/.exec(line);
      if (!m) continue;
      // pnpm 5 writes /name/version_peers; later ones name@version(peers).
      const old = /^\/((?:@[^/]+\/)?[^/]+)\/(\d[^/_]*)(_.*)?$/.exec(m[1]);
      if (old) { list.push({ name: old[1], version: old[2] }); continue; }
      const key = m[1].replace(/^\//, "").replace(/\(.*$/, "");
      const at = key.lastIndexOf("@");
      if (at > 0) list.push({ name: key.slice(0, at), version: key.slice(at + 1) });
    }
  } else if (base === "requirements.txt") {
    for (const raw of text.split("\n")) {
      const line = raw.replace(/\s#.*$/, "").split(";")[0].trim();
      const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*===?\s*([A-Za-z0-9.+!_-]+)$/.exec(line);
      if (m) list.push({ name: m[1], version: m[3] });
    }
  }
  const seen = new Set();
  return list.filter((p) => {
    const key = `${p.name}@${p.version}`;
    if (seen.has(key) || /^(workspace|link|file):/.test(p.version)) return false;
    seen.add(key);
    return true;
  }).map(({ name, version }) => ({ name, version }));
}

/** The body of one `POST /v1/querybatch`. It takes at most 1000 queries. */
export function batchQuery(packages) {
  return JSON.stringify({ queries: packages.map((p) => ({ package: { name: p.name, ecosystem: p.ecosystem }, version: p.version })) });
}

/** Cut a list into batches of at most `size`. */
export function batches(list, size = 1000) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** The advisory ids each package of a batch has, in the batch's order. */
export function readBatch(stdout, count) {
  const results = JSON.parse(stdout).results ?? [];
  return Array.from({ length: count }, (_, i) => (results[i]?.vulns ?? []).map((v) => v.id));
}

const ORDER = ["critical", "high", "moderate", "low", "unknown"];
export const SEVERITIES = ORDER;

/** A CVSS 3.x vector's base score, by the specification's formula. */
export function cvss3Score(vector) {
  const m = Object.fromEntries(vector.split("/").slice(1).map((p) => p.split(":")));
  const W = {
    AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }, AC: { L: 0.77, H: 0.44 }, UI: { N: 0.85, R: 0.62 },
    C: { H: 0.56, L: 0.22, N: 0 }, I: { H: 0.56, L: 0.22, N: 0 }, A: { H: 0.56, L: 0.22, N: 0 },
  };
  const changed = m.S === "C";
  const pr = { N: 0.85, L: changed ? 0.68 : 0.62, H: changed ? 0.5 : 0.27 }[m.PR];
  const parts = [W.AV[m.AV], W.AC[m.AC], pr, W.UI[m.UI], W.C[m.C], W.I[m.I], W.A[m.A]];
  if (parts.some((p) => p === undefined)) return null;
  const [av, ac, , ui, c, i, a] = parts;
  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  if (impact <= 0) return 0;
  const exploit = 8.22 * av * ac * pr * ui;
  const roundUp = (x) => { const n = Math.round(x * 100000); return n % 10000 === 0 ? n / 100000 : (Math.floor(n / 10000) + 1) / 10; };
  return roundUp(Math.min(changed ? 1.08 * (impact + exploit) : impact + exploit, 10));
}

/** critical, high, moderate, low or unknown: the database's own word first, else from the CVSS score. */
export function severityOf(vuln) {
  const word = String(vuln.database_specific?.severity ?? vuln.affected?.[0]?.ecosystem_specific?.severity ?? "").toLowerCase();
  if (word === "medium") return "moderate";
  if (ORDER.includes(word) && word !== "unknown") return word;
  const v3 = (vuln.severity ?? []).find((s) => s.type === "CVSS_V3")?.score;
  const score = v3 ? cvss3Score(v3) : null;
  if (score === null) return "unknown";
  return score >= 9 ? "critical" : score >= 7 ? "high" : score >= 4 ? "moderate" : score > 0 ? "low" : "unknown";
}

/** Compare two versions part by part, numbers as numbers: -1, 0 or 1. */
export function compareVersions(a, b) {
  const pa = String(a).split(/[.+-]/), pb = String(b).split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "0", y = pb[i] ?? "0";
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1; }
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** The lowest version that fixes this advisory for this package and is above the installed one. */
export function fixedVersion(vuln, pkg) {
  const fixes = [];
  for (const a of vuln.affected ?? []) {
    if (a.package?.name?.toLowerCase() !== pkg.name.toLowerCase()) continue;
    for (const r of a.ranges ?? []) for (const e of r.events ?? []) if (e.fixed) fixes.push(e.fixed);
  }
  return fixes.filter((f) => compareVersions(f, pkg.version) > 0).sort(compareVersions)[0] ?? null;
}

/** One finding: a package and an advisory it is open to. */
export function finding(pkg, vuln) {
  return {
    package: pkg.name, version: pkg.version, ecosystem: pkg.ecosystem, lockfiles: pkg.lockfiles ?? [],
    id: vuln.id, aliases: vuln.aliases ?? [],
    summary: vuln.summary || (vuln.details ?? "").split("\n")[0].slice(0, 200) || "No summary",
    severity: severityOf(vuln), fixed: fixedVersion(vuln, pkg),
  };
}

/**
 * One finding per problem: databases publish the same one under several ids (a GitHub advisory, a
 * PyPI one, a CVE), naming each other as aliases. Of those, the one with a known severity is kept.
 */
export function dedupeFindings(list) {
  const kept = [];
  for (const f of list) {
    const names = new Set([f.id, ...f.aliases]);
    const same = kept.findIndex((k) => k.package === f.package && k.version === f.version && k.ecosystem === f.ecosystem
      && (names.has(k.id) || k.aliases.some((a) => names.has(a))));
    if (same < 0) kept.push(f);
    else if (kept[same].severity === "unknown" && f.severity !== "unknown") kept[same] = { ...f, aliases: [...new Set([...f.aliases, kept[same].id, ...kept[same].aliases])] };
    else kept[same] = { ...kept[same], aliases: [...new Set([...kept[same].aliases, f.id, ...f.aliases])] };
  }
  return kept;
}

/** Findings worst first, then by package name. */
export function sortFindings(list) {
  return [...list].sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity) || a.package.localeCompare(b.package) || a.id.localeCompare(b.id));
}
