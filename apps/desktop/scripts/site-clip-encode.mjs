// Turns site-clip.mjs recordings into what the website's hero serves:
//   clip.webm (VP9) + clip.mp4 (H.264) at the recorded size, for wide screens;
//   clip-small.webm + clip-small.mp4 at 1600 px wide, for phones, which show a 4:5 crop of it;
//   step-<key>.webp, a settled still of each step, for reduced motion and as the poster;
//   site/src/data/hero-clip.json, when each step starts in the clip.
//
//   node scripts/site-clip-encode.mjs --part rec-a:11-60.5 --part rec-b:62.5-86 --focus canvas=8,view=55
//
// Each --part is a recording directory and the stretch of it to keep, in seconds; the parts play
// in order. A step starts where its beat (beats.json) falls inside a kept stretch, or at the start
// of the first part for the first step; --beat rec-b:widget=67.5 moves one. --hold 3 holds the
// last frame that long. --focus says where a phone's crop of each step is centred, as a
// percentage across the frame. CLIP_ENCODER names a program taking `<in> <out> <ffmpeg args>`
// that runs the encodes elsewhere; without it they run here at low priority.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const args = process.argv.slice(2);
const all = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));
const OUT = path.join(ROOT, "site/public/shots/hero");
const DATA = path.join(ROOT, "site/src/data/hero-clip.json");
const SHOWN = ["canvas", "view", "widget", "tool"];
const focus = Object.fromEntries(all("focus").join(",").split(",").filter(Boolean).map((f) => f.split("=")));

const parts = all("part").map((p) => {
  const [dir, range] = [p.slice(0, p.lastIndexOf(":")), p.slice(p.lastIndexOf(":") + 1)];
  const [a, b] = range.split("-").map(Number);
  const beats = JSON.parse(fs.readFileSync(path.resolve(dir, "beats.json"), "utf8"));
  for (const o of all("beat").filter((x) => path.resolve(x.slice(0, x.lastIndexOf(":"))) === path.resolve(dir))) {
    const [key, at] = o.slice(o.lastIndexOf(":") + 1).split("=");
    const beat = beats.find((x) => x.key === key);
    if (beat) beat.at = Number(at); else beats.push({ key, at: Number(at) });
  }
  beats.sort((x, y) => x.at - y.at);
  return { raw: path.resolve(dir, "raw.mkv"), beats, a, b };
});
const HOLD = Number(all("hold")[0] ?? 0);
if (!parts.length) throw new Error("no --part given");

// One lossless cut of the kept stretches, and the steps' times in it.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "clip-"));
const cut = path.join(work, "cut.mkv");
const inputs = parts.flatMap((p) => ["-i", p.raw]);
const graph = parts.map((p, i) => `[${i}:v]trim=${p.a}:${p.b},setpts=PTS-STARTPTS[v${i}]`).join(";") +
  `;${parts.map((_, i) => `[v${i}]`).join("")}concat=n=${parts.length}:v=1:a=0${HOLD ? `,tpad=stop_mode=clone:stop_duration=${HOLD}` : ""}[out]`;
execFileSync("nice", ["-n", "19", "ffmpeg", "-loglevel", "error", "-y", ...inputs, "-filter_complex", graph, "-map", "[out]",
  "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", cut], { stdio: "inherit" });
const steps = [];
let offset = 0;
for (const p of parts) {
  for (const b of p.beats) {
    if (!SHOWN.includes(b.key) || steps.some((s) => s.key === b.key)) continue;
    const first = !steps.length && p === parts[0];
    if (first || (b.at >= p.a && b.at < p.b)) steps.push({ key: b.key, at: Math.round((first ? 0 : offset + b.at - p.a) * 10) / 10 });
  }
  offset += p.b - p.a;
}
const duration = Math.round((offset + HOLD) * 10) / 10;
const { width, height } = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", cut], { encoding: "utf8" })).streams[0];

fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, f));
const ff = (a) => execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", cut, ...a], { stdio: "inherit" });
const vf = (w) => `${w === width ? "" : `scale=${w}:-2:flags=lanczos,`}format=yuv420p`;
const encode = (out, a) => process.env.CLIP_ENCODER
  ? execFileSync(process.env.CLIP_ENCODER, [cut, out, ...a], { stdio: "inherit" })
  : execFileSync("nice", ["-n", "19", "ffmpeg", "-loglevel", "error", "-y", "-threads", "4", "-i", cut, ...a, out], { stdio: "inherit" });
for (const [w, name] of [[width, "clip"], [1600, "clip-small"]]) {
  encode(path.join(OUT, `${name}.webm`), ["-vf", vf(w), "-c:v", "libvpx-vp9", "-crf", "33", "-b:v", "0", "-tune-content", "screen",
    "-row-mt", "1", "-cpu-used", "2", "-g", "60", "-an"]);
  encode(path.join(OUT, `${name}.mp4`), ["-vf", vf(w), "-c:v", "libx264", "-crf", "28", "-preset", "slow", "-tune", "animation",
    "-profile:v", "high", "-g", "60", "-movflags", "+faststart", "-an"]);
}
// The first step's still is the clip's first frame (it is the poster, so playing starts where it
// shows); the others are each step's last settled moment, just before the next step.
steps.forEach((s, i) => {
  const at = i === 0 ? 0 : (steps[i + 1]?.at ?? duration) - 0.6;
  ff(["-ss", String(at), "-frames:v", "1", "-c:v", "libwebp", "-quality", "86", path.join(OUT, `step-${s.key}.webp`)]);
  if (focus[s.key]) s.focus = Number(focus[s.key]);
});
fs.rmSync(work, { recursive: true, force: true });
const clip = { width, height, poster: `step-${steps[0].key}.webp`, duration, steps };
fs.writeFileSync(DATA, `${JSON.stringify(clip, null, 2)}\n`);
for (const f of fs.readdirSync(OUT)) console.log(f, `${(fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0)} KB`);
console.log(JSON.stringify(clip));
