// The repository's lockfiles (`git ls-files`, `cat`) checked against the public OSV database, which
// is reached through `curl` (host.run): one batch query for every pinned package, then each advisory
// found. "Ask an agent to upgrade" starts one in this tile's frame with a prompt you read first.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "hm-plugin://host/react.js";
import { Button, Loading, useTileState } from "hm-plugin://host/sdk.js";
import { LOCKFILES, SEVERITIES, batchQuery, batches, compareVersions, dedupeFindings, finding, findLockfiles, parseLockfile, readBatch, sortFindings } from "./lib.js";

const h = React.createElement;
const OSV = "https://api.osv.dev/v1";
const muted = { color: "var(--color-fg3)", fontSize: 11 };
const mono = { fontFamily: "var(--font-mono)" };
const COLOR = { critical: "var(--color-err)", high: "var(--color-err)", moderate: "var(--color-warn)", low: "var(--color-select)", unknown: "var(--color-fg3)" };
const WORD = { critical: "Critical", high: "High", moderate: "Moderate", low: "Low", unknown: "Unknown" };
const FOLDED = 4;
const groupKey = (g) => `${g.ecosystem}|${g.package}|${g.version}`;
// An agent's call waits 30 s; past this it is told the audit is still going.
const COMMAND_WAIT_MS = 25_000;

// Batch answers carry no cache of their own (the body goes on stdin), so they are kept here.
const batchCache = new Map();
const advisoryCache = new Map();

function Pill({ severity, solid }) {
  const c = COLOR[severity];
  return h("span", {
    style: {
      display: "inline-flex", alignItems: "center", gap: 5, padding: "1px 7px", borderRadius: 999, fontSize: 10.5, fontWeight: 600,
      color: solid ? "var(--color-bg)" : c, background: solid ? c : `color-mix(in srgb, ${c} 16%, transparent)`, whiteSpace: "nowrap",
    },
  }, WORD[severity]);
}

async function curl(host, args, opts) {
  const r = await host.run("curl", ["-s", "-S", "--max-time", "30", ...args], opts);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `curl ended ${r.code}`);
  return r.stdout;
}

async function each(items, fn, atOnce = 8) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(atOnce, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

async function runAudit(host, onStep) {
  onStep("Finding lockfiles");
  const ls = await host.run("git", ["ls-files"], { maxAgeMs: 10_000 });
  if (ls.code !== 0) throw new Error(ls.stderr.trim() || "git ls-files failed");
  const files = findLockfiles(ls.stdout);
  const perFile = [];
  const byKey = new Map();
  for (const file of files) {
    const r = await host.run("cat", ["--", file], { maxAgeMs: 10_000 });
    let list = [];
    try { list = r.code === 0 ? parseLockfile(file, r.stdout) : []; } catch (e) { perFile.push({ lockfile: file, ecosystem: LOCKFILES[file.split("/").pop()], packages: 0, problem: e.message }); continue; }
    const ecosystem = LOCKFILES[file.split("/").pop()];
    perFile.push({ lockfile: file, ecosystem, packages: list.length });
    for (const p of list) {
      const key = `${ecosystem}|${p.name}|${p.version}`;
      const had = byKey.get(key);
      if (had) had.lockfiles.push(file); else byKey.set(key, { ...p, ecosystem, lockfiles: [file] });
    }
  }
  const packages = [...byKey.values()];
  const hits = [];
  let asked = 0;
  for (const batch of batches(packages)) {
    onStep(`Asking OSV about ${(asked + batch.length).toLocaleString()} of ${packages.length.toLocaleString()} packages`);
    const body = batchQuery(batch);
    let out = batchCache.get(body);
    if (!out || Date.now() - out.at > 600_000) {
      out = { at: Date.now(), text: await curl(host, ["-H", "Content-Type: application/json", "--data", "@-", `${OSV}/querybatch`], { stdin: body }) };
      batchCache.set(body, out);
    }
    readBatch(out.text, batch.length).forEach((ids, i) => { if (ids.length) hits.push({ pkg: batch[i], ids }); });
    asked += batch.length;
  }
  const ids = [...new Set(hits.flatMap((x) => x.ids))].filter((id) => !advisoryCache.has(id));
  let read = 0;
  await each(ids, async (id) => {
    onStep(`Reading advisories: ${++read} of ${ids.length}`);
    advisoryCache.set(id, JSON.parse(await curl(host, [`${OSV}/vulns/${encodeURIComponent(id)}`], { maxAgeMs: 300_000 })));
  });
  const findings = sortFindings(dedupeFindings(hits.flatMap(({ pkg, ids }) => ids.map((id) => finding(pkg, advisoryCache.get(id))))));
  return { at: new Date().toISOString(), lockfiles: perFile, packages: packages.length, findings };
}

/** Findings by package and version, worst package first; `upgrade` is the lowest version that fixes them all. */
function byPackage(findings) {
  const groups = new Map();
  for (const f of findings) {
    const key = `${f.ecosystem}|${f.package}|${f.version}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  return [...groups.values()].map((list) => {
    const fixes = list.map((f) => f.fixed);
    return { ...list[0], list, worst: list[0].severity, upgrade: fixes.includes(null) ? null : fixes.sort(compareVersions).pop() };
  });
}

function Audit({ tile, hm, host }) {
  const [result, setResult] = useState(null);
  const [step, setStep] = useState(null);
  const [error, setError] = useState(null);
  const [hidden, setHidden] = useTileState(hm, "hidden", []);
  const [open, setOpen] = useState([]);
  const pending = useRef(null);

  const scan = useCallback(() => {
    setError(null);
    const p = runAudit(host, setStep);
    pending.current = p;
    p.then((r) => { if (pending.current === p) { setResult(r); setStep(null); } },
      (e) => { if (pending.current === p) { setError(e.message); setStep(null); } });
    return p;
  }, [host]);
  useEffect(() => { scan(); }, [scan]);

  useEffect(() => hm.onCommand("audit", async () => {
    const p = pending.current ?? scan();
    const r = await Promise.race([p, new Promise((ok) => setTimeout(() => ok(null), COMMAND_WAIT_MS))]);
    if (!r) return { running: true, step, note: "Still checking; call audit again in a little while." };
    return { checked: r.at, packages: r.packages, findings: r.findings };
  }), [hm, scan, step]);
  useEffect(() => hm.onCommand("packages", async () => {
    const r = result ?? await pending.current;
    return r.lockfiles;
  }), [hm, result]);

  const groups = useMemo(() => byPackage((result?.findings ?? []).filter((f) => !hidden.includes(f.severity))), [result, hidden]);
  const counts = useMemo(() => Object.fromEntries(SEVERITIES.map((s) => [s, (result?.findings ?? []).filter((f) => f.severity === s).length])), [result]);
  const canAsk = hm.capabilities.includes("workspace:spawn");
  const ask = (list) => {
    const lines = list.map((g) => `- ${g.package} ${g.version} (${g.ecosystem}, in ${g.lockfiles.join(", ")}): ${g.list.slice(0, 5).map((f) => `${f.id} ${WORD[f.severity].toLowerCase()}: ${f.summary}`).join("; ")}${g.list.length > 5 ? ` and ${g.list.length - 5} more` : ""}. ${g.upgrade ? `Fixed in ${g.upgrade}.` : "No fixed version is published for every advisory."}`);
    hm.commands.spawnAgent(null, tile.frameId, {
      name: list.length === 1 ? `Upgrade ${list[0].package}` : "Upgrade vulnerable packages",
      prompt: `These dependencies have known vulnerabilities (from the OSV database):\n${lines.join("\n")}\n\nUpgrade each to a fixed version through the package manager that owns its lockfile (a direct dependency in its manifest, a transitive one through its parent or an override), keep the lockfile consistent, run the tests, and say what you changed and anything you could not fix.`,
    });
  };
  const toggle = (s) => setHidden(hidden.includes(s) ? hidden.filter((x) => x !== s) : [...hidden, s]);

  if (error && !result) {
    return h("div", { role: "alert", style: { padding: 16, color: "var(--color-err)", fontSize: 13 } },
      h("p", null, error),
      h("p", { style: muted }, "It reads lockfiles with git and asks api.osv.dev through curl, so both need to be installed and the network reachable."),
      h(Button, { size: "xs", variant: "outline", onClick: scan }, "Try again"));
  }
  if (!result) return h(Loading, { label: step ?? "Reading lockfiles" });
  const vulnerable = byPackage(result.findings).length;
  return h("div", { style: { display: "flex", flexDirection: "column", height: "100%", color: "var(--color-fg)" } },
    h("div", { style: { display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: "1px solid var(--color-line)" } },
      h("div", { style: { flex: 1, minWidth: 0 } },
        h("div", { style: { fontSize: 13, fontWeight: 600 } },
          result.findings.length ? `${vulnerable} vulnerable package${vulnerable === 1 ? "" : "s"}, ${result.findings.length} advisor${result.findings.length === 1 ? "y" : "ies"}` : "No known vulnerabilities"),
        h("div", { style: muted }, step ?? `${result.packages.toLocaleString()} packages in ${result.lockfiles.length} lockfile${result.lockfiles.length === 1 ? "" : "s"} · checked ${new Date(result.at).toLocaleTimeString()}`)),
      canAsk && groups.length > 0 && h(Button, { size: "xs", variant: "outline", onClick: () => ask(groups) }, "Ask an agent to upgrade"),
      h(Button, { size: "xs", variant: "ghost", disabled: !!step, onClick: () => { batchCache.clear(); scan(); } }, step ? "Checking…" : "Check again")),
    h("div", { style: { display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", padding: "8px 14px", borderBottom: "1px solid var(--color-line)" } },
      SEVERITIES.filter((s) => s !== "unknown" || counts.unknown).map((s) => h("button", {
        key: s, onClick: () => toggle(s), "aria-pressed": !hidden.includes(s), "data-severity": s,
        style: {
          display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 9px", borderRadius: 999, cursor: "pointer", fontSize: 11.5,
          border: "1px solid var(--color-line)", color: "var(--color-fg)", background: hidden.includes(s) ? "transparent" : "var(--color-bg3)", opacity: hidden.includes(s) ? 0.5 : 1,
        },
      }, h("span", { style: { width: 8, height: 8, borderRadius: 4, background: COLOR[s] } }), WORD[s], h("b", { style: { fontWeight: 600 } }, counts[s]))),
      h("span", { style: { flex: 1 } }),
      result.lockfiles.map((l) => h("span", { key: l.lockfile, title: l.problem ?? `${l.packages} packages (${l.ecosystem})`, style: { ...muted, ...mono, color: l.problem ? "var(--color-err)" : "var(--color-fg3)" } }, `${l.lockfile} · ${l.packages}`))),
    h("div", { style: { flex: 1, minHeight: 0, overflow: "auto" } },
      !result.lockfiles.length ? h("p", { style: { ...muted, padding: 16 } }, `No lockfile here. It reads ${Object.keys(LOCKFILES).join(", ")}.`)
        : !groups.length ? h("div", { style: { padding: 24, textAlign: "center" } },
          h("div", { style: { fontSize: 22, color: "var(--color-ok)" } }, "✓"),
          h("div", { style: { fontSize: 13, marginTop: 4 } }, result.findings.length ? "Nothing at the levels shown." : "Every pinned package is clear of known advisories."),
          h("div", { style: muted }, `${result.packages.toLocaleString()} packages checked against osv.dev`))
          : groups.map((g) => h("section", { key: groupKey(g), "data-package": g.package, style: { padding: "10px 14px", borderBottom: "1px solid var(--color-line)" } },
            h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
              h(Pill, { severity: g.worst, solid: g.worst === "critical" }),
              h("span", { style: { ...mono, fontSize: 12.5, fontWeight: 600 } }, g.package),
              h("span", { style: { ...mono, fontSize: 12, color: "var(--color-fg3)" } }, g.version),
              g.upgrade ? h("span", { style: { ...mono, fontSize: 12, color: "var(--color-ok)" } }, `→ ${g.upgrade}`) : h("span", { style: { ...muted, fontStyle: "italic" } }, "no fix yet"),
              h("span", { style: { flex: 1 } }),
              h("span", { style: muted }, `${g.ecosystem} · ${g.lockfiles.join(", ")}`),
              canAsk && h(Button, { size: "2xs", variant: "ghost", onClick: () => ask([g]) }, "Upgrade")),
            (open.includes(groupKey(g)) ? g.list : g.list.slice(0, FOLDED)).map((f) => h("div", { key: f.id, style: { display: "flex", alignItems: "baseline", gap: 8, padding: "4px 0 0 4px", fontSize: 12 } },
              h("span", { style: { width: 6, height: 6, borderRadius: 3, flex: "none", background: COLOR[f.severity], transform: "translateY(-1px)" } }),
              h("button", {
                onClick: () => host.openUrl(`https://osv.dev/vulnerability/${f.id}`), title: "Open the advisory",
                style: { ...mono, fontSize: 11.5, border: 0, padding: 0, background: "transparent", color: "var(--color-select)", cursor: "pointer", flex: "none" },
              }, f.id),
              h("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: f.summary }, f.summary),
              f.aliases.find((a) => a.startsWith("CVE-")) && h("span", { style: { ...muted, ...mono } }, f.aliases.find((a) => a.startsWith("CVE-"))),
              h("span", { style: { ...muted, ...mono, minWidth: 90, textAlign: "right" } }, f.fixed ? `fixed in ${f.fixed}` : "not fixed"))),
            g.list.length > FOLDED && h("button", {
              onClick: () => setOpen(open.includes(groupKey(g)) ? open.filter((k) => k !== groupKey(g)) : [...open, groupKey(g)]),
              style: { ...muted, border: 0, background: "transparent", cursor: "pointer", padding: "4px 0 0 18px" },
            }, open.includes(groupKey(g)) ? "Show fewer" : `${g.list.length - FOLDED} more advisories`)))));
}

export default { tiles: { "dependency-audit": Audit } };
