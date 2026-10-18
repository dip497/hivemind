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
// A step lighter: the edge of a widget closed in on, so it stands off the background.
const EDGE = "#282b30";
const TEXT = "#e6e8ea";
const MUTED = "#a3a5a7";
const FADE = 0.18;

export type Box = { x: number; y: number; w: number; h: number };
export type Cues = {
  size: { width: number; height: number };
  phone: { width: number; height: number };
  boxes: Record<string, Box>;
  shots: { beat: string; files: string[]; at: number[]; layout?: number[] }[];
  /** The agents' tiles on the board as recorded. */
  tiles?: Box[];
  /** Where each frame's parts are (its shot's `layout` says which), so no crop cuts through one. */
  layouts?: Part[][];
};
type Part = Box & { what: string };
/** `box` names one box, or several joined by "+" to frame them together; `lift` raises it by that
 *  share of the view, leaving room below it. */
type Key = { u: number; box: string; pad?: number; lift?: number };
/** A shot plays its beat at the speed it was recorded, unless it is a marked skip: `skip` says
 *  how much time it leaves out ("+40 s"), shown while it plays. Shots meet in hard cuts. */
type Shot = {
  beat: string; start: number; end: number;
  play: "loop" | "lapse" | "steps" | "first" | "last";
  range?: [number, number];
  skip?: string;
  camera: Key[];
  /** From `from` to `to` (shares of the shot) the window closes in on `box` alone, which ends
   *  centred on the flat background with nothing around it cut. */
  isolate?: { box: string; from: number; to: number };
};
type Caption = { text: string; start: number; end: number };
type Still = { file: string; start: number };
type Pointer = { start: number; end: number; from: [number, number]; to: { shot: string; box: string } | { pane: number; box: string }; click?: number };
/** Another device's page beside the window, each still shown from its start; `part` (in the
 *  page's pixels) shows only that part of it, filling the rect's width. */
type Pane = { start: number; end: number; rect: Box; look: "browser" | "phone"; shots: Still[]; size: { width: number; height: number }; part?: Box };
export type Story = {
  /** The folder of the recording under the recordings folder; the hero's own when left out. */
  recording?: string;
  /** Where the app window sits, when not in its usual place; keep the window's shape. */
  win?: Box;
  panes?: Pane[];
  /** Times the window steps away, so only the other devices' pages are seen. */
  away?: { start: number; end: number }[];
  boxes?: Record<string, Box>;
  shots: Shot[];
  captions: Caption[];
  pointer?: Pointer[];
  /** The closing card: the name and the command that installs it. */
  end?: { start: number; title: string; command: string };
};
export type ClipProps = { story: Story; cues: Cues };

// The window leaves a strip under it for the caption, so a caption never covers the product.
const WIN = { x: 80, y: 20, w: 1120, h: 700 };
const CAPTION = 36;

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const easeInOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
/** In over FADE at `start`, out over FADE before `end`. */
const shown = (t: number, start: number, end: number) => clamp((t - start) / FADE) * clamp((end - t) / FADE);
const fileAt = (shots: Still[], t: number) => ([...shots].reverse().find((s) => t >= s.start) ?? shots[0]!).file;

function around(boxes: Box[]): Box {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
}

/** The part of the capture the camera shows: `box` grown by `pad`, widened to the window's shape,
 *  kept inside the capture. */
function view(cues: Cues, key: Key): Box {
  const { width: W, height: H } = cues.size;
  const b = key.box === "full" ? { x: 0, y: 0, w: W, h: H } : key.box === "tiles" ? around(cues.tiles!) : around(key.box.split("+").map((n) => cues.boxes[n]!));
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

/** The window and the part of the capture in it, while a shot closes in on one box: both move
 *  evenly from the camera's view in the window to the box alone, centred above the caption strip. */
function isolated(cues: Cues, shot: Shot, t: number, win: Box): { win: Box; cam: Box; k: number } {
  const cam = camera(cues, shot, t);
  if (!shot.isolate) return { win, cam, k: 0 };
  const u = clamp((t - shot.start) / (shot.end - shot.start));
  const k = easeInOut(clamp((u - shot.isolate.from) / (shot.isolate.to - shot.isolate.from)));
  const b = cues.boxes[shot.isolate.box]!;
  const h = Math.min(win.h * 0.9, (win.w * 0.75 * b.h) / b.w);
  const end = { w: (h * b.w) / b.h, h, x: 0, y: 0 };
  end.x = (1280 - end.w) / 2;
  end.y = win.y + (win.h - h) / 2;
  const mix = (a: number, z: number) => a + (z - a) * k;
  const to = { x: mix(win.x, end.x), y: mix(win.y, end.y), w: mix(win.w, end.w), h: mix(win.h, end.h) };
  const s = to.w / mix(cam.w, b.w);
  const cx = mix(cam.x + cam.w / 2, b.x + b.w / 2);
  const cy = mix(cam.y + cam.h / 2, b.y + b.h / 2);
  return { win: to, cam: { x: cx - to.w / s / 2, y: cy - to.h / s / 2, w: to.w / s, h: to.h / s }, k };
}

function Capture({ cues, shot, t, cam, win }: { cues: Cues; shot: Shot; t: number; cam: Box; win: Box }) {
  const s = win.w / cam.w;
  return (
    <Img src={staticFile(frameOf(cues, shot, t))} style={{
      position: "absolute", left: 0, top: 0, width: cues.size.width, height: cues.size.height,
      transformOrigin: "0 0", transform: `scale(${s}) translate(${-cam.x}px, ${-cam.y}px)`,
    }} />
  );
}

/** Fails the render when `crop` cuts through a part of `file` side to side: a crop holds a
 *  part's whole width or none of it. */
function checkCrop(cues: Cues, file: string, crop: Box, t: number) {
  const shot = cues.shots.find((s) => s.files.includes(file));
  const index = shot?.layout?.[shot.files.indexOf(file)];
  if (index === undefined || !cues.layouts) throw new Error(`${file} was recorded without its layout: record it again`);
  const e = 2;
  const across = (x: number, p: Part) => p.x < x - e && p.x + p.w > x + e;
  const cut = cues.layouts[index]!.find((p) => p.y < crop.y + crop.h - e && p.y + p.h > crop.y + e && (across(crop.x, p) || across(crop.x + crop.w, p)));
  if (cut) throw new Error(`${t.toFixed(2)} s, ${file}: the crop (x ${Math.round(crop.x)} to ${Math.round(crop.x + crop.w)}) cuts ${cut.what} (x ${Math.round(cut.x)} to ${Math.round(cut.x + cut.w)})`);
}
const inside = (b: Box, w: number, h: number): Box => {
  const x = Math.max(0, b.x), y = Math.max(0, b.y);
  return { x, y, w: Math.min(w, b.x + b.w) - x, h: Math.min(h, b.y + b.h) - y };
};
/** The part of a device's page its pane shows. */
function paneCrop(pane: Pane): Box {
  if (pane.part) return pane.part;
  const s = Math.max(pane.rect.w / pane.size.width, pane.rect.h / pane.size.height);
  const w = pane.rect.w / s;
  return { x: (pane.size.width - w) / 2, y: 0, w, h: pane.rect.h / s };
}

const partScale = (pane: Pane) => pane.rect.w / (pane.part?.w ?? pane.size.width);

/** Another device's page: a browser's or a phone's, flat, with a one-pixel edge. */
function Device({ pane, t }: { pane: Pane; t: number }) {
  const phone = pane.look === "phone";
  return (
    <div style={{
      position: "absolute", left: pane.rect.x, top: pane.rect.y, width: pane.rect.w, height: pane.rect.h, opacity: shown(t, pane.start, pane.end),
      borderRadius: phone ? 28 : 10, overflow: "hidden", background: "#000", boxShadow: `0 0 0 1px ${LINE}, 0 10px 30px rgba(0,0,0,.35)`,
    }}>
      {pane.part
        ? <Img src={staticFile(fileAt(pane.shots, t))} style={{ position: "absolute", left: -pane.part.x * partScale(pane), top: -pane.part.y * partScale(pane), width: pane.size.width * partScale(pane), maxWidth: "none" }} />
        : <Img src={staticFile(fileAt(pane.shots, t))} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "top" }} />}
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
      const s = partScale(pane);
      to = [pane.rect.x + (b.x - (pane.part?.x ?? 0) + b.w / 2) * s, pane.rect.y + (b.y - (pane.part?.y ?? 0) + b.h / 2) * s];
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
  const framed = isolated(cues, shot, t, win);
  const away = Math.max(0, ...(story.away ?? []).map((a) => shown(t, a.start, a.end)));
  if (away < 0.99) checkCrop(cues, frameOf(cues, shot, t), inside(framed.cam, cues.size.width, cues.size.height), t);
  for (const p of story.panes ?? []) if (t >= p.start && t < p.end) checkCrop(cues, fileAt(p.shots, t), inside(paneCrop(p), p.size.width, p.size.height), t);

  return (
    <AbsoluteFill style={{ background: BG }}>
      <div style={{
        position: "absolute", left: framed.win.x, top: framed.win.y, width: framed.win.w, height: framed.win.h, overflow: "hidden",
        opacity: 1 - away,
        borderRadius: 10, background: BG, boxShadow: `0 0 0 1px ${framed.k > 0.5 ? EDGE : LINE}, 0 10px 30px rgba(0,0,0,.35)`,
      }}>
        <Capture cues={cues} shot={shot} t={t} cam={framed.cam} win={framed.win} />
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
          position: "absolute", left: win.x, top: win.y + win.h + 18, opacity: shown(t, caption.start, caption.end),
          font: `400 ${CAPTION}px/1.2 ${SANS}`, whiteSpace: "nowrap", color: TEXT, letterSpacing: "-0.005em",
        }}>{caption.text}</div>
      )}
      {shot.skip && (
        <div style={{
          position: "absolute", right: 1280 - win.x - win.w, top: win.y + win.h + 24, opacity: shown(t, shot.start, shot.end),
          font: `400 26px/1.3 ${MONO}`, color: MUTED,
        }}>{shot.skip}</div>
      )}
      {ending && (
        <AbsoluteFill style={{ background: BG, opacity: clamp((t - story.end!.start) / FADE), alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 28 }}>
          <div style={{ font: `500 64px/1.1 ${SANS}`, color: TEXT, letterSpacing: "-0.02em" }}>{story.end!.title}</div>
          <div style={{ font: `400 28px/1.3 ${MONO}`, color: MUTED }}>{story.end!.command}</div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
}
