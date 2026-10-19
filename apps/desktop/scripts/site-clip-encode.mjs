// Turns one site-clip.mjs recording into what the website's hero serves:
//   clip.webm (VP9) + clip.mp4 (H.264) at the recorded size, and clip-1440.* for screens that
//   draw the frame smaller; clip-phone.* is a 4:5 crop that follows the action, for phones;
//   site/src/assets/hero/: the first frame (the poster) and a settled still of each step, wide and
//   phone, which the site turns into AVIF and WebP at build time;
//   site/src/data/hero-clip.json, when each step starts in the clip.
//
//   node scripts/site-clip-encode.mjs <recording> --keep 2-64 --speed 9-20=4 \
//     --phone 0=640,560 --phone 12=1600,700
//
// --keep is the stretch of the recording to use, in seconds: one take, never two joined.
// --speed a-b=n plays a stretch of waiting n times faster, so the take stays whole but short.
// --phone t=x,y centres the phone's crop on (x, y), in recorded pixels, from t (recording seconds);
// the crop eases from one centre to the next over 0.8 s.
// CLIP_ENCODER names a program taking `<in> <out> <ffmpeg args>` that runs the encodes elsewhere;
// without it they run here at low priority.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const args = process.argv.slice(2);
const all = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));
const OUT = path.join(ROOT, "site/public/shots/hero");
const STILLS = path.join(ROOT, "site/src/assets/hero");
const DATA = path.join(ROOT, "site/src/data/hero-clip.json");
const SHOWN = ["view", "widget", "tool"];
const PHONE = { w: 1000, h: 1250, outW: 720, outH: 900 };

const dir = path.resolve(args[0]);
const [keepA, keepB] = (all("keep")[0] ?? "").split("-").map(Number);
if (!(keepB > keepA)) throw new Error("--keep a-b is needed");
const beats = JSON.parse(fs.readFileSync(path.join(dir, "beats.json"), "utf8"));
const fast = all("speed").map((s) => { const [r, n] = s.split("="); const [a, b] = r.split("-").map(Number); return { a, b, n: Number(n) }; })
  .sort((x, y) => x.a - y.a);
const phoneKeys = all("phone").map((s) => { const [t, xy] = s.split("="); const [x, y] = xy.split(",").map(Number); return { t: Number(t), x, y }; })
  .sort((p, q) => p.t - q.t);
if (!phoneKeys.length) throw new Error("--phone t=x,y is needed");

// The kept stretch in pieces, each at its own speed; `clipTime` maps a recording time into the clip.
const pieces = [];
let at = keepA;
for (const f of fast) {
  if (f.a > at) pieces.push({ a: at, b: f.a, n: 1 });
  pieces.push({ a: Math.max(f.a, at), b: Math.min(f.b, keepB), n: f.n });
  at = Math.min(f.b, keepB);
}
if (at < keepB) pieces.push({ a: at, b: keepB, n: 1 });
const clipTime = (t) => {
  let out = 0;
  for (const p of pieces) { if (t <= p.a) break; out += (Math.min(t, p.b) - p.a) / p.n; }
  return Math.round(out * 100) / 100;
};

// The phone crop's centre on one axis, as an ffmpeg expression of the recording's time `t`.
const centre = (axis) => {
  let e = String(phoneKeys[0][axis]);
  for (let i = 1; i < phoneKeys.length; i++) {
    const p = phoneKeys[i - 1], q = phoneKeys[i];
    const u = `clip((t-${q.t})/0.8\\,0\\,1)`;
    e = `if(lt(t\\,${q.t})\\,${e}\\,${p[axis]}+(${q[axis] - p[axis]})*${u}*${u}*(3-2*${u}))`;
  }
  return e;
};
const phoneCrop = `crop=${PHONE.w}:${PHONE.h}:'clip(${centre("x")}-${PHONE.w / 2}\\,0\\,iw-${PHONE.w})':'clip(${centre("y")}-${PHONE.h / 2}\\,0\\,ih-${PHONE.h})'`;

/** The kept pieces, each re-timed, joined back into one stretch; `first` runs on the recording's own time. */
const graph = (first) => `[0:v]${first ? `${first},` : ""}split=${pieces.length}${pieces.map((_, i) => `[s${i}]`).join("")};` +
  pieces.map((p, i) => `[s${i}]trim=${p.a}:${p.b},setpts=(PTS-STARTPTS)/${p.n}[v${i}]`).join(";") +
  `;${pieces.map((_, i) => `[v${i}]`).join("")}concat=n=${pieces.length}:v=1:a=0,fps=30[out]`;

const work = fs.mkdtempSync(path.join(os.tmpdir(), "clip-"));
const raw = path.join(dir, "raw.mkv");
const local = (a) => execFileSync("nice", ["-n", "19", "ffmpeg", "-loglevel", "error", "-y", "-threads", "4", ...a], { stdio: "inherit" });
const cut = path.join(work, "cut.mkv"), phoneCut = path.join(work, "phone.mkv");
for (const [first, out] of [["", cut], [phoneCrop, phoneCut]]) {
  local(["-i", raw, "-filter_complex", graph(first), "-map", "[out]", "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", out]);
}

const probe = (f) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", f], { encoding: "utf8" }));
const p0 = probe(cut);
const { width, height } = p0.streams[0];
const duration = Math.round(Number(p0.format.duration) * 10) / 10;

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(STILLS, { recursive: true });
for (const d of [OUT, STILLS]) for (const f of fs.readdirSync(d)) fs.rmSync(path.join(d, f));
const encode = (input, out, a) => process.env.CLIP_ENCODER
  ? execFileSync(process.env.CLIP_ENCODER, [input, out, ...a], { stdio: "inherit" })
  : local(["-i", input, ...a, out]);
const vf = (w) => `${w ? `scale=${w}:-2:flags=lanczos,` : ""}format=yuv420p`;
const vp9 = (w) => ["-vf", vf(w), "-c:v", "libvpx-vp9", "-crf", "34", "-b:v", "0", "-tune-content", "screen", "-row-mt", "1", "-cpu-used", "2", "-g", "90", "-an"];
const h264 = (w) => ["-vf", vf(w), "-c:v", "libx264", "-crf", "27", "-preset", "slow", "-tune", "animation", "-profile:v", "high", "-g", "90", "-movflags", "+faststart", "-an"];
for (const [input, name, w] of [[cut, "clip", 0], [cut, "clip-1440", 1440], [phoneCut, "clip-phone", PHONE.outW]]) {
  encode(input, path.join(OUT, `${name}.webm`), vp9(w));
  encode(input, path.join(OUT, `${name}.mp4`), h264(w));
}

const steps = SHOWN.map((key) => {
  const b = beats.find((x) => x.key === key);
  if (!b) throw new Error(`no ${key} beat`);
  return { key, at: key === SHOWN[0] ? 0 : clipTime(b.at) };
});
// The poster is the clip's first frame, so playing starts where it shows; each step's still is its
// last settled moment, just before the next step.
const still = (input, t, file) => execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-ss", String(t), "-i", input, "-frames:v", "1", "-c:v", "libwebp", "-quality", "94", path.join(STILLS, file)]);
for (const [input, tag] of [[cut, ""], [phoneCut, "-phone"]]) {
  still(input, 0, `poster${tag}.webp`);
  steps.forEach((s, i) => still(input, Math.max(0, (steps[i + 1]?.at ?? duration) - 0.6), `step-${s.key}${tag}.webp`));
}
fs.rmSync(work, { recursive: true, force: true });
const clip = { width, height, phone: { width: PHONE.outW, height: PHONE.outH }, duration, steps };
fs.writeFileSync(DATA, `${JSON.stringify(clip, null, 2)}\n`);
for (const d of [OUT, STILLS]) for (const f of fs.readdirSync(d)) console.log(f, `${(fs.statSync(path.join(d, f)).size / 1024).toFixed(0)} KB`);
console.log(JSON.stringify(clip));
