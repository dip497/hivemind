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
for (const scene of ["world_quiet", "world_streaming_idle", "world_docked_streaming_idle", "world_docked_typing", "world_orbit", "world_dock_undock"]) {
  add(`${scene} · fps`, `${scene}.fps`);
  add(`${scene} · frame p95`, `${scene}.frame_p95_ms`, "ms");
  add(`${scene} · longtask total`, `${scene}.longtask_total_ms`, "ms");
  add(`${scene} · loop lag p95`, `${scene}.lag_p95_ms`, "ms");
  add(`${scene} · frames drawn`, `${scene}.frames_drawn`);
}
add("switch → world (median)", "switch_to_world_median_ms", "ms");
add("switch world → canvas (median)", "switch_world_to_canvas_median_ms", "ms");
add("canvas<->world switch longtask max (plain)", "world_switch_longtask_max_ms", "ms");
add("world → canvas right after an undock", "world_switch_after_undock.ms", "ms");
add("… its longtask", "world_switch_after_undock.longtask_ms", "ms");
add("xterm instances after world switches", "xterm_instances_after_world_switches");
for (const scene of ["community_quiet", "community_streaming_idle", "community_docked_streaming_idle", "community_docked_typing", "community_dock_undock", "hostile_docked_typing"]) {
  add(`${scene} · fps`, `${scene}.fps`);
  add(`${scene} · longtask total`, `${scene}.longtask_total_ms`, "ms");
  add(`${scene} · loop lag p95`, `${scene}.lag_p95_ms`, "ms");
  add(`${scene} · frames drawn`, `${scene}.frames_drawn`);
}
add("switch → community (median)", "switch_to_community_median_ms", "ms");
add("switch community → canvas (median)", "switch_community_to_canvas_median_ms", "ms");
add("canvas<->community switch longtask max (plain)", "community_switch_longtask_max_ms", "ms");
add("community → canvas right after an undock", "community_switch_after_undock.ms", "ms");
add("… its longtask", "community_switch_after_undock.longtask_ms", "ms");
add("xterm instances after community switches", "xterm_instances_after_community_switches");
add("cpu % canvas quiet", "canvas_quiet_cpu.total_cpu_pct");
add("cpu % community quiet", "community_quiet_cpu.total_cpu_pct");
add("cpu % community streaming (undocked)", "community_streaming_cpu.total_cpu_pct");
add("cpu % community docked + streaming", "community_docked_cpu.total_cpu_pct");
add("cpu % hostile docked + streaming", "hostile_docked_cpu.total_cpu_pct");
add("cpu % world quiet", "world_quiet_cpu.total_cpu_pct");
add("cpu % world docked + streaming", "world_docked_cpu.total_cpu_pct");
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
console.log("world switch samples after:", JSON.stringify(b.world_switches));
console.log("switch samples base:", JSON.stringify(a.switches));
