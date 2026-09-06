// node compare.mjs base.json after.json → markdown table of the key metrics.
import fs from "node:fs";
const [a, b] = process.argv.slice(2).map((p) => JSON.parse(fs.readFileSync(p, "utf8")));
const rows = [];
const pick = (o, path) => path.split(".").reduce((x, k) => (x == null ? x : x[k]), o);
const add = (label, path, unit = "") => rows.push([label, pick(a, path), pick(b, path), unit]);
for (const scene of ["canvas_quiet", "canvas_streaming_idle", "canvas_streaming_typing", "canvas_pan", "canvas_drag", "windows_streaming_idle"]) {
  add(`${scene} · fps`, `${scene}.fps`);
  add(`${scene} · frame p95`, `${scene}.frame_p95_ms`, "ms");
  add(`${scene} · frames >50ms`, `${scene}.frames_over_50ms`);
  add(`${scene} · longtask total`, `${scene}.longtask_total_ms`, "ms");
  add(`${scene} · loop lag p95`, `${scene}.lag_p95_ms`, "ms");
}
add("tiles typed into", "typed_into");
add("xterm count while streaming", "xterm_count_streaming");
add("react-flow nodes", "node_count");
add("switch → windows (median)", "switch_to_windows_median_ms", "ms");
add("switch → canvas (median)", "switch_to_canvas_median_ms", "ms");
add("xterm instances after 8 switches", "xterm_instances_after_switches");
add("cpu % streaming (all procs)", "streaming_cpu.total_cpu_pct");
add("renderer RSS streaming", "streaming_cpu.renderer_rss_mb", "MB");
add("cpu % windows view", "windows_cpu.total_cpu_pct");
console.log(`| metric | ${a.label} | ${b.label} |\n|---|---:|---:|`);
for (const [l, x, y, u] of rows) console.log(`| ${l} | ${x ?? "–"}${u} | ${y ?? "–"}${u} |`);
console.log("\nswitch samples after:", JSON.stringify(b.switches));
console.log("switch samples base:", JSON.stringify(a.switches));
