// The files of a build folder (a setting) and their sizes, through host.run: `find` lists them,
// `wc -c` measures them, and python3's gzip module gives each script and stylesheet's size at
// gzip level 9. "Keep as baseline" saves the sizes with the tile, so each file shows its change.
import React, { useCallback, useEffect, useMemo, useState } from "hm-plugin://host/react.js";
import { Button, Loading, useTileState } from "hm-plugin://host/sdk.js";
import { toast } from "hm-plugin://host/ui.js";
import { GZIP_SCRIPT, compare, compressible, formatBytes, parseGzip, parseWc, snapshot } from "./lib.js";

const h = React.createElement;
const muted = { color: "var(--color-fg3)", fontSize: 11 };
const mono = { fontFamily: "var(--font-mono)" };
const AT_ONCE = 400;
// The baseline is kept with the tile, which holds 64 KB.
const BASELINE_FILES = 500;

const chunks = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));
const kindOf = (f) => (/\.(m?js|cjs)$/i.test(f) ? "js" : /\.css$/i.test(f) ? "css" : /\.(png|jpe?g|gif|webp|avif|svg|ico)$/i.test(f) ? "image" : /\.(woff2?|ttf|otf)$/i.test(f) ? "font" : /\.map$/i.test(f) ? "map" : "other");
const KIND_COLOR = { js: "var(--color-select)", css: "var(--color-warn)", image: "var(--color-ok)", font: "var(--color-fg)", map: "var(--color-line)", other: "var(--color-fg3)" };

async function measure(host, folder) {
  const found = await host.run("find", [folder, "-type", "f"]);
  if (found.code !== 0) return { missing: true, files: [] };
  const paths = found.stdout.split("\n").filter(Boolean);
  const files = [];
  for (const part of chunks(paths, AT_ONCE)) {
    const r = await host.run("wc", ["-c", ...part]);
    files.push(...parseWc(r.stdout, folder));
  }
  let gzip = null;
  const zippable = paths.filter(compressible);
  if (zippable.length) {
    gzip = {};
    for (const part of chunks(zippable, AT_ONCE)) {
      const r = await host.run("python3", ["-c", GZIP_SCRIPT, ...part]).catch(() => null);
      if (!r || r.code !== 0) { gzip = null; break; }
      Object.assign(gzip, parseGzip(r.stdout, folder));
    }
  }
  for (const f of files) f.gzip = gzip?.[f.file] ?? null;
  return { missing: false, files: files.sort((a, b) => b.bytes - a.bytes), gzipped: gzip !== null };
}

function Change({ bytes }) {
  if (bytes === null) return h("span", { style: { ...muted, fontSize: 10.5, padding: "0 6px", borderRadius: 4, background: "var(--color-bg3)" } }, "new");
  if (bytes === 0) return h("span", { style: muted }, "same");
  return h("span", { style: { ...mono, fontSize: 11, color: bytes > 0 ? "var(--color-err)" : "var(--color-ok)" } }, `${bytes > 0 ? "+" : "−"}${formatBytes(Math.abs(bytes))}`);
}

function Bundle({ hm, host }) {
  const [folder, setFolder] = useState(hm.settings.folder ?? "dist");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [baseline, setBaseline] = useTileState(hm, "baseline", null);
  useEffect(() => hm.on("settings", (s) => setFolder(s.folder ?? "dist")), [hm]);

  const load = useCallback(() => {
    setError(null);
    return measure(host, folder).then((d) => { setData(d); return d; }, (e) => { setError(e.message); throw e; });
  }, [host, folder]);
  useEffect(() => { load().catch(() => {}); }, [load]);

  const base = baseline?.folder === folder ? baseline : null;
  const diff = useMemo(() => (data && base ? compare(data.files, base) : null), [data, base]);
  const keep = () => {
    const snap = snapshot(data.files.slice(0, BASELINE_FILES));
    setBaseline({ ...snap, folder, total: data.files.reduce((s, f) => s + f.bytes, 0), capped: data.files.length > BASELINE_FILES });
    toast.success(`Kept ${formatBytes(snap.total)} as the baseline`);
  };

  useEffect(() => hm.onCommand("sizes", async () => {
    const d = await load();
    if (d.missing) throw new Error(`there is no folder ${folder} here; build first`);
    return { folder, files: d.files.length, total: d.files.reduce((s, f) => s + f.bytes, 0), gzip: d.gzipped ? d.files.reduce((s, f) => s + (f.gzip ?? 0), 0) : null, largest: d.files.slice(0, 50) };
  }), [hm, load, folder]);
  useEffect(() => hm.onCommand("compare", async () => {
    if (!base) throw new Error("no baseline kept yet: press Keep as baseline in the tile first");
    const d = await load();
    const c = compare(d.files, base);
    return { ...c, rows: c.rows.filter((r) => r.change !== 0).sort((a, b) => Math.abs(b.change ?? b.bytes) - Math.abs(a.change ?? a.bytes)) };
  }), [hm, load, base]);

  if (error && !data) return h("p", { role: "alert", style: { color: "var(--color-err)", padding: 16, fontSize: 13 } }, error);
  if (!data) return h(Loading, { label: `Measuring ${folder}` });
  if (data.missing) {
    return h("div", { style: { padding: 24, textAlign: "center", color: "var(--color-fg)" } },
      h("div", { style: { fontSize: 13 } }, h("span", null, "No folder "), h("span", { style: mono }, folder), h("span", null, " here.")),
      h("div", { style: { ...muted, margin: "4px 0 12px" } }, `Build the project, or set the folder: hive plugins set tool:dip497/bundle-size folder build`),
      h(Button, { size: "xs", variant: "outline", onClick: () => load().catch(() => {}) }, "Look again"));
  }
  const total = data.files.reduce((s, f) => s + f.bytes, 0);
  const gzipTotal = data.files.reduce((s, f) => s + (f.gzip ?? 0), 0);
  const largest = data.files[0]?.bytes || 1;
  const rows = diff ? diff.rows : data.files.map((f) => ({ ...f, change: undefined }));
  return h("div", { style: { display: "flex", flexDirection: "column", height: "100%", color: "var(--color-fg)" } },
    h("div", { style: { display: "flex", alignItems: "center", gap: 18, padding: "12px 16px", borderBottom: "1px solid var(--color-line)" } },
      h("div", null, h("div", { style: muted }, h("span", { style: mono }, folder), ` · ${data.files.length} files`),
        h("div", { style: { fontSize: 20, fontWeight: 700, ...mono } }, formatBytes(total))),
      data.gzipped && h("div", null, h("div", { style: muted }, "gzip -9, scripts and styles"), h("div", { style: { fontSize: 15, fontWeight: 600, ...mono } }, formatBytes(gzipTotal))),
      diff && h("div", null, h("div", { style: muted }, `since the baseline, ${new Date(diff.since).toLocaleString()}`),
        h("div", { style: { fontSize: 15, fontWeight: 600 } }, h(Change, { bytes: diff.change }))),
      h("span", { style: { flex: 1 } }),
      base && h(Button, { size: "xs", variant: "ghost", onClick: () => setBaseline(null) }, "Forget baseline"),
      h(Button, { size: "xs", variant: "outline", onClick: keep }, base ? "Keep these as baseline" : "Keep as baseline"),
      h(Button, { size: "xs", variant: "ghost", onClick: () => load().catch(() => {}) }, "Measure again")),
    h("div", { style: { display: "flex", gap: 12, padding: "6px 16px", borderBottom: "1px solid var(--color-line)" } },
      Object.entries(KIND_COLOR).filter(([k]) => data.files.some((f) => kindOf(f.file) === k)).map(([k, c]) => h("span", { key: k, style: { ...muted, display: "inline-flex", alignItems: "center", gap: 5 } },
        h("span", { style: { width: 8, height: 8, borderRadius: 2, background: c } }), k)),
      !data.gzipped && h("span", { style: { ...muted, marginLeft: "auto" } }, "gzip sizes need python3")),
    h("div", { style: { flex: 1, minHeight: 0, overflow: "auto", padding: "6px 0" } },
      !rows.length ? h("p", { style: { ...muted, padding: 16 } }, "The folder is empty.")
        : rows.map((f) => h("div", { key: f.file, "data-file": f.file, style: { display: "grid", gridTemplateColumns: "minmax(160px, 34%) 1fr 76px 70px 80px", alignItems: "center", gap: 10, padding: "4px 16px", fontSize: 12 } },
          h("span", { style: { ...mono, fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: f.file }, f.file),
          h("div", { style: { height: 10, borderRadius: 3, background: "var(--color-bg3)", overflow: "hidden" } },
            h("div", { style: { width: `${Math.max(0.5, (f.bytes / largest) * 100)}%`, height: "100%", borderRadius: 3, background: KIND_COLOR[kindOf(f.file)] } })),
          h("span", { style: { ...mono, textAlign: "right" } }, formatBytes(f.bytes)),
          h("span", { style: { ...mono, ...muted, textAlign: "right" }, title: "gzip -9" }, f.gzip !== null ? formatBytes(f.gzip) : ""),
          h("span", { style: { textAlign: "right" } }, f.change === undefined || (f.added && base.capped) ? null : h(Change, { bytes: f.change })))),
      diff?.removed.length > 0 && diff.removed.map((r) => h("div", { key: `gone:${r.file}`, style: { display: "grid", gridTemplateColumns: "minmax(160px, 34%) 1fr 76px 70px 80px", gap: 10, padding: "4px 16px", fontSize: 12, opacity: 0.6 } },
        h("span", { style: { ...mono, fontSize: 11.5, textDecoration: "line-through" } }, r.file), h("span", { style: muted }, "removed"), h("span"), h("span"),
        h("span", { style: { textAlign: "right" } }, h(Change, { bytes: -r.was }))))));
}

export default { tiles: { "bundle-size": Bundle } };
