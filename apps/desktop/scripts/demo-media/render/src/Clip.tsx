// One clip of the demo: what frame number `f` shows is a pure function of the story, the cues and
// the recorded frames. A camera moves over real captures, other devices' pages stand beside them,
// and one short caption at a time sits under the window; it draws no part of the app.
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont as loadGeist } from "@remotion/google-fonts/Geist";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";

const { fontFamily: SANS } = loadGeist("normal", { weights: ["400", "500"], subsets: ["latin"] });
const { fontFamily: MONO } = loadMono("normal", { weights: ["400"], subsets: ["latin"] });

// The app's own colours: its background oklch(0.165 0.004 250), a line a step lighter, its text.
const BG = "#0d0e10";
const LINE = "#232426";
const TEXT = "#e6e8ea";
const MUTED = "#a3a5a7";
const FADE = 0.18;

export type Box = { x: number; y: number; w: number; h: number };
export type Cues = {
  size: { width: number; height: number };
  phone: { width: number; height: number };
  boxes: Record<string, Box>;
  shots: { beat: string; files: string[]; at: number[] }[];
};
/** `lift` raises the box by that share of the view, leaving room below it. */
type Key = { u: number; box: string; pad?: number; lift?: number };
/** A shot plays its beat at the speed it was recorded, unless it is a marked skip: `skip` says
 *  how much time it leaves out ("+40 s"), shown while it plays. Shots meet in hard cuts. */
type Shot = {
  beat: string; start: number; end: number;
  play: "loop" | "lapse" | "steps" | "first" | "last";
  range?: [number, number];
  skip?: string;
  camera: Key[];
};
type Caption = { text: string; start: number; end: number };
type Still = { file: string; start: number };
type Pointer = { start: number; end: number; from: [number, number]; to: { shot: string; box: string } | { pane: number; box: string }; click?: number };
/** Another device's page beside the window, each still shown from its start. */
type Pane = { start: number; end: number; rect: Box; look: "browser" | "phone"; shots: Still[]; size: { width: number; height: number } };
export type Story = {
  /** The folder of the recording under the recordings folder; the hero's own when left out. */
  recording?: string;
  /** Where the app window sits, when not in its usual place; keep the window's shape. */
  win?: Box;
  panes?: Pane[];
  boxes?: Record<string, Box>;
  shots: Shot[];
  captions: Caption[];
  pointer?: Pointer[];
  /** The closing card: the name and the command that installs it. */
  end?: { start: number; title: string; command: string };
};
export type ClipProps = { story: Story; cues: Cues };

// The window leaves a strip under it for the caption, so a caption never covers the product.
const WIN = { x: 64, y: 24, w: 1152, h: 720 };

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const easeInOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
/** In over FADE at `start`, out over FADE before `end`. */
const shown = (t: number, start: number, end: number) => clamp((t - start) / FADE) * clamp((end - t) / FADE);
const fileAt = (shots: Still[], t: number) => ([...shots].reverse().find((s) => t >= s.start) ?? shots[0]!).file;

/** The part of the capture the camera shows: `box` grown by `pad`, widened to the window's shape,
 *  kept inside the capture. */
function view(cues: Cues, key: Key): Box {
  const { width: W, height: H } = cues.size;
  const b = key.box === "full" ? { x: 0, y: 0, w: W, h: H } : cues.boxes[key.box]!;
  const pad = key.pad ?? 1;
  let w = b.w * pad;
  let h = b.h * pad;
  const aspect = WIN.w / WIN.h;
  if (w / h < aspect) w = h * aspect; else h = w / aspect;
  w = Math.min(w, W);
  h = Math.min(h, H);
  const cx = clamp(b.x + b.w / 2, w / 2, W - w / 2);
  const cy = clamp(b.y + b.h / 2 + (key.lift ?? 0) * h, h / 2, H - h / 2);
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** The camera `t` seconds into the clip: centres move straight, zoom moves evenly in scale. */
function camera(cues: Cues, shot: Shot, t: number): Box {
  const u = clamp((t - shot.start) / (shot.end - shot.start));
  const keys = shot.camera;
  let i = 0;
  while (i < keys.length - 2 && u > keys[i + 1]!.u) i++;
  const a = keys[i]!;
  const b = keys[Math.min(i + 1, keys.length - 1)]!;
  const k = b.u === a.u ? 1 : easeInOut(clamp((u - a.u) / (b.u - a.u)));
  const va = view(cues, a);
  const vb = view(cues, b);
  const w = va.w * (vb.w / va.w) ** k;
  const h = w * (WIN.h / WIN.w);
  const cx = va.x + va.w / 2 + (vb.x + vb.w / 2 - va.x - va.w / 2) * k;
  const cy = va.y + va.h / 2 + (vb.y + vb.h / 2 - va.y - va.h / 2) * k;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

function frameOf(cues: Cues, shot: Shot, t: number): string {
  const rec = cues.shots.find((s) => s.beat === shot.beat);
  if (!rec?.files.length) throw new Error(`the recording has no beat ${shot.beat}`);
  const n = rec.files.length;
  const u = clamp((t - shot.start) / (shot.end - shot.start));
  if (shot.play === "first") return rec.files[0]!;
  if (shot.play === "last") return rec.files[n - 1]!;
  if (shot.play === "steps") return rec.files[Math.min(n - 1, Math.floor(u * n))]!;
  if (shot.play === "loop") {
    const every = n > 1 ? (rec.at[n - 1]! - rec.at[0]!) / (n - 1) : 1000;
    return rec.files[Math.floor(((t - shot.start) * 1000) / every) % n]!;
  }
  // The beat compressed into the shot: only ever a marked skip.
  const [a, b] = shot.range ?? [0, 1];
  const t0 = rec.at[0]! + (rec.at[n - 1]! - rec.at[0]!) * a;
  const t1 = rec.at[0]! + (rec.at[n - 1]! - rec.at[0]!) * b;
  const target = t0 + (t1 - t0) * u;
  let i = 0;
  while (i < n - 1 && rec.at[i + 1]! <= target) i++;
  return rec.files[i]!;
}

/** Where a box of a shot's capture is on the clip at `t`. */
function onClip(cues: Cues, shot: Shot, box: Box, t: number, win: Box): [number, number] {
  const cam = camera(cues, shot, t);
  const s = win.w / cam.w;
  return [win.x + (box.x + box.w / 2 - cam.x) * s, win.y + (box.y + box.h / 2 - cam.y) * s];
}

function Capture({ cues, shot, t, win }: { cues: Cues; shot: Shot; t: number; win: Box }) {
  const cam = camera(cues, shot, t);
  const s = win.w / cam.w;
  return (
    <Img src={staticFile(frameOf(cues, shot, t))} style={{
      position: "absolute", left: 0, top: 0, width: cues.size.width, height: cues.size.height,
      transformOrigin: "0 0", transform: `scale(${s}) translate(${-cam.x}px, ${-cam.y}px)`,
    }} />
  );
}

/** Another device's page: a browser's or a phone's, flat, with a one-pixel edge. */
function Device({ pane, t }: { pane: Pane; t: number }) {
  const phone = pane.look === "phone";
  return (
    <div style={{
      position: "absolute", left: pane.rect.x, top: pane.rect.y, width: pane.rect.w, height: pane.rect.h, opacity: shown(t, pane.start, pane.end),
      borderRadius: phone ? 28 : 10, overflow: "hidden", background: "#000", boxShadow: `0 0 0 1px ${LINE}, 0 10px 30px rgba(0,0,0,.35)`,
    }}>
      <Img src={staticFile(fileAt(pane.shots, t))} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "top" }} />
    </div>
  );
}

export function Clip({ story, cues }: ClipProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const win = story.win ?? WIN;
  const shot = story.shots.find((s) => t >= s.start && t < s.end) ?? story.shots.at(-1)!;
  const caption = story.captions.find((c) => t >= c.start && t < c.end);
  const pointer = story.pointer?.find((p) => t >= p.start && t < p.end);

  let pointerAt: [number, number] | null = null;
  if (pointer) {
    let to: [number, number];
    if ("pane" in pointer.to) {
      const pane = story.panes![pointer.to.pane]!;
      const b = cues.boxes[pointer.to.box]!;
      const s = pane.rect.w / pane.size.width;
      to = [pane.rect.x + (b.x + b.w / 2) * s, pane.rect.y + (b.y + b.h / 2) * s];
    } else {
      const target = pointer.to;
      to = onClip(cues, story.shots.find((s) => s.beat === target.shot)!, cues.boxes[target.box]!, t, win);
    }
    const arrive = (pointer.click ?? pointer.end) - 0.15;
    const k = easeInOut(clamp((t - pointer.start) / Math.max(0.01, arrive - pointer.start)));
    pointerAt = [pointer.from[0] + (to[0] - pointer.from[0]) * k, pointer.from[1] + (to[1] - pointer.from[1]) * k];
  }
  const ring = pointer?.click !== undefined ? clamp((t - pointer.click) / 0.2) : 0;
  const ending = story.end && t >= story.end.start;

  return (
    <AbsoluteFill style={{ background: BG }}>
      <div style={{
        position: "absolute", left: win.x, top: win.y, width: win.w, height: win.h, overflow: "hidden",
        borderRadius: 10, background: BG, boxShadow: `0 0 0 1px ${LINE}, 0 10px 30px rgba(0,0,0,.35)`,
      }}>
        <Capture cues={cues} shot={shot} t={t} win={win} />
      </div>
      {story.panes?.filter((p) => t >= p.start && t < p.end).map((p, i) => <Device key={i} pane={p} t={t} />)}
      {pointerAt && (
        <div style={{ position: "absolute", left: pointerAt[0], top: pointerAt[1] }}>
          {ring > 0 && ring < 1 && (
            <div style={{ position: "absolute", left: -14, top: -14, width: 28, height: 28, borderRadius: 14, border: `1px solid ${TEXT}`, opacity: 1 - ring }} />
          )}
          <svg width="18" height="26" viewBox="0 0 18 26" style={{ position: "absolute", left: -1, top: -1 }}>
            <path d="M1 1v20l5-5 3.5 8 3-1.3L9 15h7z" fill="#000" stroke="#fff" strokeWidth="1.4" strokeLinejoin="round" />
          </svg>
        </div>
      )}
      {/* The strip under the window: the caption, and a skip's length while one plays. */}
      {caption && (
        <div style={{
          position: "absolute", left: win.x, top: win.y + win.h + 14, opacity: shown(t, caption.start, caption.end),
          font: `400 19px/1.3 ${SANS}`, color: TEXT, letterSpacing: "-0.005em",
        }}>{caption.text}</div>
      )}
      {shot.skip && (
        <div style={{
          position: "absolute", right: 1280 - win.x - win.w, top: win.y + win.h + 16, opacity: shown(t, shot.start, shot.end),
          font: `400 15px/1.3 ${MONO}`, color: MUTED,
        }}>{shot.skip}</div>
      )}
      {ending && (
        <AbsoluteFill style={{ background: BG, opacity: clamp((t - story.end!.start) / FADE), alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 18 }}>
          <div style={{ font: `500 34px/1.1 ${SANS}`, color: TEXT, letterSpacing: "-0.02em" }}>{story.end!.title}</div>
          <div style={{ font: `400 17px/1.3 ${MONO}`, color: MUTED }}>{story.end!.command}</div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
}
