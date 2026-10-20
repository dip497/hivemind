// Turns two site-clip.mjs recordings of the same scene, one in a wide window and one in a phone's
// (`--phone`), into what the website's hero serves:
//   clip.webm (VP9) + clip.mp4 (H.264) at the recorded size, and clip-1440.* for screens that
//   draw the frame smaller, from the wide take; clip-phone.* (720x900) from the phone take;
//   site/src/assets/hero/: the first frame (the poster) and a settled still of each step, wide and
//   phone, which the site turns into AVIF and WebP at build time;
//   site/src/data/hero-clip.json, when each step starts in each clip.
//
//   node scripts/site-clip-encode.mjs <wide recording> <phone recording>
//
// Each take is used whole, one take, never two joined. A step's time is its frame in the take.
// CLIP_ENCODER names a program taking `<in> <out> <ffmpeg args>` that runs the encodes elsewhere;
// without it they run here at low priority.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const OUT = path.join(ROOT, "site/public/shots/hero");
const STILLS = path.join(ROOT, "site/src/assets/hero");
const DATA = path.join(ROOT, "site/src/data/hero-clip.json");
const SHOWN = ["view", "widget", "tool"];
const PHONE = { width: 720, height: 900 };

const [wideDir, phoneDir] = process.argv.slice(2).map((d) => path.resolve(d));
if (!phoneDir) throw new Error("usage: site-clip-encode.mjs <wide recording> <phone recording>");

const probe = (f) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", f], { encoding: "utf8" }));
/** One take: its file, size, length, and when each step starts. */
const take = (dir) => {
  const raw = path.join(dir, "raw.mkv");
  const p = probe(raw);
  const beats = JSON.parse(fs.readFileSync(path.join(dir, "beats.json"), "utf8"));
  const steps = SHOWN.map((key) => {
    const b = beats.find((x) => x.key === key);
    if (!b) throw new Error(`no ${key} beat in ${dir}`);
    return { key, at: Math.round(b.at * 100) / 100 };
  });
  return { raw, width: p.streams[0].width, height: p.streams[0].height, duration: Math.round(Number(p.format.duration) * 10) / 10, steps };
};
const wide = take(wideDir), phone = take(phoneDir);

const local = (a) => execFileSync("nice", ["-n", "19", "ffmpeg", "-loglevel", "error", "-y", "-threads", "4", ...a], { stdio: "inherit" });
const encode = (input, out, a) => process.env.CLIP_ENCODER
  ? execFileSync(process.env.CLIP_ENCODER, [input, out, ...a], { stdio: "inherit" })
  : local(["-i", input, ...a, out]);
const vf = (w) => `${w ? `scale=${w}:-2:flags=lanczos,` : ""}format=yuv420p`;
const vp9 = (w) => ["-vf", vf(w), "-c:v", "libvpx-vp9", "-crf", "34", "-b:v", "0", "-tune-content", "screen", "-row-mt", "1", "-cpu-used", "2", "-g", "90", "-an"];
const h264 = (w) => ["-vf", vf(w), "-c:v", "libx264", "-crf", "27", "-preset", "slow", "-tune", "animation", "-profile:v", "high", "-g", "90", "-movflags", "+faststart", "-an"];
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(STILLS, { recursive: true });
for (const [input, name, w] of [[wide.raw, "clip", 0], [wide.raw, "clip-1440", 1440], [phone.raw, "clip-phone", PHONE.width]]) {
  encode(input, path.join(OUT, `${name}.webm`), vp9(w));
  encode(input, path.join(OUT, `${name}.mp4`), h264(w));
}

// The poster is the clip's first frame, so playing starts where it shows; each step's still is its
// last settled moment, just before the next step.
const still = (input, t, w, file) => execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-ss", String(t), "-i", input, "-frames:v", "1", "-vf", vf(w), "-c:v", "libwebp", "-quality", "94", path.join(STILLS, file)]);
for (const [t, w, tag] of [[wide, 0, ""], [phone, PHONE.width, "-phone"]]) {
  still(t.raw, 0, w, `poster${tag}.webp`);
  t.steps.forEach((s, i) => still(t.raw, Math.max(0, (t.steps[i + 1]?.at ?? t.duration) - 0.6), w, `step-${s.key}${tag}.webp`));
}
const clip = {
  width: wide.width, height: wide.height, duration: wide.duration, steps: wide.steps,
  phone: { ...PHONE, duration: phone.duration, steps: phone.steps },
};
fs.writeFileSync(DATA, `${JSON.stringify(clip, null, 2)}\n`);
console.log(JSON.stringify(clip));
