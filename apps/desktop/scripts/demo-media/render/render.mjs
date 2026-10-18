// Renders the demo's clips from a recording (../capture.spec.ts) and ../story.json: every frame by
// Remotion in headless Chromium, then one ffmpeg encode per format with fixed settings, so the same
// recording and story give the same files.
//
//   node render.mjs [--recording DIR] [--site DIR] [--only <story id>]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderFrames, selectComposition } from "@remotion/renderer";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const recording = path.resolve(arg("recording", path.join(os.homedir(), "hivemind-demo-recording")));
const site = path.resolve(arg("site", path.join(HERE, "../../../../../site/public/shots")));
const only = arg("only", null);
const stories = JSON.parse(fs.readFileSync(path.join(HERE, "../story.json"), "utf8"));

// What each clip may weigh on the page.
const BUDGET = { "poster.webp": 120_000, "clip.webm": 1_500_000, "clip.mp4": 2_000_000 };
const EXACT = ["-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact"];
const ffmpeg = (...a) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...a], { stdio: "inherit" });

// The story's words: at most eight on screen at once, each line readable at 0.3 s a word between
// its fades (0.18 s in, 0.18 s out).
for (const [id, story] of Object.entries(stories)) {
  for (const c of story.captions) {
    const words = c.text.split(/\s+/).length;
    if (words > 8) throw new Error(`${id}: "${c.text}" is more than eight words`);
    if (c.end - c.start - 0.36 < 0.3 * words) throw new Error(`${id}: "${c.text}" is shown too briefly to read`);
  }
}

const serveUrl = await bundle({ entryPoint: path.join(HERE, "src/index.ts"), publicDir: recording });
const report = [];
for (const [id, story] of Object.entries(stories)) {
  if (only && !only.split(",").includes(id)) continue;
  // A clip recorded on its own keeps its cues in its folder; its frames are named from the top.
  const cuesFile = path.join(recording, story.recording ?? "", "cues.json");
  if (!fs.existsSync(cuesFile)) { report.push({ file: `${id}: no recording at ${cuesFile}`, ok: false }); continue; }
  const cues = JSON.parse(fs.readFileSync(cuesFile, "utf8"));
  // Boxes the story measured by hand from the frames, for what the recording did not measure.
  const boxes = { ...cues.boxes };
  for (const [name, b] of Object.entries(story.boxes ?? {})) if (!boxes[name]?.w) boxes[name] = b;
  const inputProps = { story, cues: { ...cues, boxes } };
  const composition = await selectComposition({ serveUrl, id, inputProps });
  const frames = fs.mkdtempSync(path.join(os.tmpdir(), `demo-${id}-`));
  await renderFrames({
    composition, serveUrl, inputProps, outputDir: frames, imageFormat: "png", concurrency: 4,
    onStart: () => {}, onFrameUpdate: () => {},
  });
  const files = fs.readdirSync(frames).filter((f) => f.endsWith(".png")).sort();
  const seq = path.join(frames, "seq");
  fs.mkdirSync(seq);
  files.forEach((f, i) => fs.renameSync(path.join(frames, f), path.join(seq, `${String(i).padStart(5, "0")}.png`)));
  const input = ["-framerate", String(composition.fps), "-i", path.join(seq, "%05d.png")];

  const out = path.join(site, id);
  fs.mkdirSync(out, { recursive: true });
  ffmpeg(...input, "-c:v", "libsvtav1", "-preset", "6", "-crf", "42", "-g", "240", "-pix_fmt", "yuv420p", "-svtav1-params", "tune=0", ...EXACT, path.join(out, "clip.webm"));
  ffmpeg(...input, "-c:v", "libx264", "-preset", "slow", "-crf", "30", "-tune", "animation", "-pix_fmt", "yuv420p", "-movflags", "+faststart", ...EXACT, path.join(out, "clip.mp4"));
  // The poster is the clip's first frame, so the video takes over from it without a jump.
  for (const q of [82, 74, 66, 58, 50]) {
    ffmpeg("-i", path.join(seq, "00000.png"), "-c:v", "libwebp", "-quality", String(q), "-compression_level", "6", ...EXACT, path.join(out, "poster.webp"));
    if (fs.statSync(path.join(out, "poster.webp")).size <= BUDGET["poster.webp"]) break;
  }

  // For review, beside the recording: a still every half second in one image, and three stills.
  const review = path.join(recording, "review");
  fs.mkdirSync(review, { recursive: true });
  const half = Math.round(composition.fps / 2);
  const tiles = Math.ceil(files.length / half);
  ffmpeg(...input, "-vf", `select=not(mod(n\\,${half})),scale=400:-2,tile=6x${Math.ceil(tiles / 6)}:padding=6:color=0x0b0d10`, "-frames:v", "1", "-fps_mode", "passthrough", path.join(review, `${id}-contact.webp`));
  for (const [name, at] of Object.entries(story.stills ?? {})) {
    const n = Math.min(files.length - 1, Math.round(at * composition.fps));
    fs.copyFileSync(path.join(seq, `${String(n).padStart(5, "0")}.png`), path.join(review, `${id}-${name}.png`));
  }
  fs.rmSync(frames, { recursive: true, force: true });

  for (const f of ["poster.webp", "clip.webm", "clip.mp4"]) {
    const size = fs.statSync(path.join(out, f)).size;
    report.push({ file: path.relative(process.cwd(), path.join(out, f)), kb: Math.round(size / 1024), budgetKb: Math.round(BUDGET[f] / 1024), ok: size <= BUDGET[f] });
  }
  report.push({ file: path.join(review, `${id}-contact.webp`), seconds: files.length / composition.fps });
}
console.table(report);
if (report.some((r) => r.ok === false)) process.exitCode = 1;
