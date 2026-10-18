// Reading file sizes and comparing them with a baseline. No imports: the tests load it as it is.

/** Compresses each file named on the command line at gzip level 9 and prints its size, a tab and its name. */
export const GZIP_SCRIPT = "import gzip,sys\nfor p in sys.argv[1:]:\n    try:\n        print(len(gzip.compress(open(p,'rb').read(),9)),p,sep='\\t')\n    except OSError:\n        pass";

/** `wc -c` output for files under `folder`: each file's size, by its path inside the folder. */
export function parseWc(out, folder) {
  const prefix = folder.replace(/\/+$/, "") + "/";
  const rows = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    // The last line totals the files when there is more than one.
    if (m[2] === "total") continue;
    rows.push({ file: m[2].startsWith(prefix) ? m[2].slice(prefix.length) : m[2], bytes: Number(m[1]) });
  }
  return rows;
}

/** The gzip sizes GZIP_SCRIPT printed, by path inside the folder. */
export function parseGzip(out, folder) {
  const prefix = folder.replace(/\/+$/, "") + "/";
  const sizes = {};
  for (const line of out.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 1) continue;
    const p = line.slice(tab + 1);
    sizes[p.startsWith(prefix) ? p.slice(prefix.length) : p] = Number(line.slice(0, tab));
  }
  return sizes;
}

/** Files worth a gzip size: what a browser downloads compressed. */
export const compressible = (file) => /\.(m?js|cjs|css|html|svg|json|wasm|map)$/i.test(file);

/** Bytes as people read them: 812 B, 14.2 kB, 3.10 MB. */
export function formatBytes(n) {
  const a = Math.abs(n);
  if (a < 1000) return `${n} B`;
  if (a < 1_000_000) return `${(n / 1000).toFixed(a < 10_000 ? 2 : 1)} kB`;
  return `${(n / 1_000_000).toFixed(2)} MB`;
}

/** What the baseline keeps: each file's size and gzip size, and their totals. */
export function snapshot(files, at = new Date().toISOString()) {
  const total = files.reduce((s, f) => s + f.bytes, 0);
  const gzip = files.reduce((s, f) => s + (f.gzip ?? 0), 0);
  return { at, total, gzip, files: Object.fromEntries(files.map((f) => [f.file, { bytes: f.bytes, gzip: f.gzip ?? null }])) };
}

/** Each file's change since the baseline, the files added and removed, and the total's change. */
export function compare(files, baseline) {
  const now = snapshot(files);
  const rows = files.map((f) => {
    const was = baseline.files[f.file];
    return { file: f.file, bytes: f.bytes, gzip: f.gzip ?? null, was: was?.bytes ?? null, change: was ? f.bytes - was.bytes : null, added: !was };
  });
  const removed = Object.keys(baseline.files).filter((p) => !files.some((f) => f.file === p))
    .map((file) => ({ file, was: baseline.files[file].bytes }));
  return { since: baseline.at, total: now.total, totalWas: baseline.total, change: now.total - baseline.total, rows, removed };
}
