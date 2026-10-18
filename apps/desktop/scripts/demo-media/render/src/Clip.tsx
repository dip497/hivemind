// One clip of the demo: what frame number `f` shows is a pure function of the story, the cues and
// the recorded frames. It moves a camera, a phone and a pointer over real captures and writes a
// caption; it draws no part of the app.
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { ShaderMeshGradient } from "./MeshGradient";

export type Box = { x: number; y: number; w: number; h: number };
export type Cues = {
  size: { width: number; height: number };
  phone: { width: number; height: number };
  boxes: Record<string, Box>;
  shots: { beat: string; files: string[]; at: number[] }[];
};
type Key = { u: number; box: string; pad?: number };
type Shot = {
  beat: string; start: number; end: number; fade?: number;
  play: "loop" | "lapse" | "steps" | "first" | "last";
  range?: [number, number];
  camera: Key[];
};
type Caption = { text: string; start: number; end: number };
type PhoneShot = { file: string; start: number };
type Pointer = { start: number; end: number; from: [number, number]; to: { shot: string; box: string } | { phone: string }; click?: number };
export type Story = {
  boxes?: Record<string, Box>;
  shots: Shot[];
  captions: Caption[];
  phone?: { start: number; end: number; shots: PhoneShot[] };
  pointer?: Pointer[];
};
export type ClipProps = { story: Story; cues: Cues };

// The app window sits on the backdrop with a margin; the phone stands to its right.
const WIN = { x: 32, y: 20, w: 1216, h: 760 };
const PHONE = { w: 300, h: 650, right: 64 };

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

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
  const cy = clamp(b.y + b.h / 2, h / 2, H - h / 2);
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** The camera at `u` through a shot: centres move straight, zoom moves evenly in scale. */
function camera(cues: Cues, keys: Key[], u: number): Box {
  let i = 0;
  while (i < keys.length - 2 && u > keys[i + 1]!.u) i++;
  const a = keys[i]!;
  const b = keys[Math.min(i + 1, keys.length - 1)]!;
  const t = b.u === a.u ? 1 : easeInOut(clamp((u - a.u) / (b.u - a.u)));
  const va = view(cues, a);
  const vb = view(cues, b);
  const w = va.w * (vb.w / va.w) ** t;
  const h = w * (WIN.h / WIN.w);
  const cx = va.x + va.w / 2 + (vb.x + vb.w / 2 - va.x - va.w / 2) * t;
  const cy = va.y + va.h / 2 + (vb.y + vb.h / 2 - va.y - va.h / 2) * t;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

function frameOf(cues: Cues, shot: Shot, u: number, seconds: number): string {
  const rec = cues.shots.find((s) => s.beat === shot.beat);
  if (!rec?.files.length) throw new Error(`the recording has no beat ${shot.beat}`);
  const n = rec.files.length;
  if (shot.play === "first") return rec.files[0]!;
  if (shot.play === "last") return rec.files[n - 1]!;
  if (shot.play === "steps") return rec.files[Math.min(n - 1, Math.floor(u * n))]!;
  if (shot.play === "loop") {
    const every = n > 1 ? (rec.at[n - 1]! - rec.at[0]!) / (n - 1) : 1000;
    return rec.files[Math.floor((seconds * 1000) / every) % n]!;
  }
  // A time-lapse of the beat as it was recorded.
  const [a, b] = shot.range ?? [0, 1];
  const t0 = rec.at[0]! + (rec.at[n - 1]! - rec.at[0]!) * a;
  const t1 = rec.at[0]! + (rec.at[n - 1]! - rec.at[0]!) * b;
  const target = t0 + (t1 - t0) * u;
  let i = 0;
  while (i < n - 1 && rec.at[i + 1]! <= target) i++;
  return rec.files[i]!;
}

function Capture({ cues, shot, t }: { cues: Cues; shot: Shot; t: number }) {
  const u = clamp((t - shot.start) / (shot.end - shot.start));
  const cam = camera(cues, shot.camera, u);
  const s = WIN.w / cam.w;
  const opacity = shot.fade ? easeOut(clamp((t - shot.start) / shot.fade)) : 1;
  return (
    <Img src={staticFile(frameOf(cues, shot, u, t - shot.start))} style={{
      position: "absolute", left: 0, top: 0, width: cues.size.width, height: cues.size.height, opacity,
      transformOrigin: "0 0", transform: `scale(${s}) translate(${-cam.x}px, ${-cam.y}px)`,
    }} />
  );
}

/** Where a box of a shot's capture is on the clip at `t`. */
function onClip(cues: Cues, shot: Shot, box: Box, t: number): [number, number] {
  const cam = camera(cues, shot.camera, clamp((t - shot.start) / (shot.end - shot.start)));
  const s = WIN.w / cam.w;
  return [WIN.x + (box.x + box.w / 2 - cam.x) * s, WIN.y + (box.y + box.h / 2 - cam.y) * s];
}

function phoneRect(story: Story, t: number) {
  const p = story.phone!;
  const inT = easeOut(clamp((t - p.start) / 0.45));
  const outT = easeOut(clamp((t - (p.end - 0.35)) / 0.35));
  const x = 1280 - PHONE.right - PHONE.w + (1 - inT + outT) * (PHONE.w + PHONE.right + 40);
  return { x, y: (800 - PHONE.h) / 2, w: PHONE.w, h: PHONE.h };
}

export function Clip({ story, cues }: ClipProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const shown = story.shots.filter((s) => t >= s.start && t < s.end + 1e-6);
  const caption = story.captions.find((c) => t >= c.start && t < c.end);
  const phoneOn = story.phone && t >= story.phone.start && t < story.phone.end;
  const pointer = story.pointer?.find((p) => t >= p.start && t < p.end);

  let pointerAt: [number, number] | null = null;
  if (pointer) {
    let to: [number, number];
    if ("phone" in pointer.to) {
      const r = phoneRect(story, t);
      const b = cues.boxes[pointer.to.phone]!;
      const s = r.w / cues.phone.width;
      to = [r.x + (b.x + b.w / 2) * s, r.y + (b.y + b.h / 2) * s];
    } else {
      const target = pointer.to;
      const shot = story.shots.find((s) => s.beat === target.shot)!;
      to = onClip(cues, shot, cues.boxes[target.box]!, t);
    }
    const arrive = (pointer.click ?? pointer.end) - 0.15;
    const k = easeInOut(clamp((t - pointer.start) / Math.max(0.01, arrive - pointer.start)));
    pointerAt = [pointer.from[0] + (to[0] - pointer.from[0]) * k, pointer.from[1] + (to[1] - pointer.from[1]) * k];
  }
  const press = pointer?.click !== undefined ? clamp((t - pointer.click) / 0.35) : 0;

  return (
    <AbsoluteFill style={{ background: "#0b0d10" }}>
      <ShaderMeshGradient speed={0.12} colors={["#1d2536", "#2d3d60", "#4b6198", "#26314b"]} distortion={0.5} swirl={0.08} />
      <div style={{
        position: "absolute", left: WIN.x, top: WIN.y, width: WIN.w, height: WIN.h, overflow: "hidden",
        borderRadius: 14, background: "#121416",
        boxShadow: "0 24px 60px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.07)",
      }}>
        {shown.map((s) => <Capture key={`${s.beat}-${s.start}`} cues={cues} shot={s} t={t} />)}
      </div>
      {phoneOn && (() => {
        const r = phoneRect(story, t);
        const file = [...story.phone!.shots].reverse().find((p) => t >= p.start)?.file ?? story.phone!.shots[0]!.file;
        return (
          <div style={{
            position: "absolute", left: r.x, top: r.y, width: r.w, height: r.h, borderRadius: 34, overflow: "hidden",
            boxShadow: "0 30px 70px rgba(0,0,0,.6), 0 0 0 7px #1b1e23, 0 0 0 8px rgba(255,255,255,.1)", background: "#000",
          }}>
            <Img src={staticFile(file)} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "top" }} />
          </div>
        );
      })()}
      {pointerAt && (
        <div style={{ position: "absolute", left: pointerAt[0], top: pointerAt[1] }}>
          {press > 0 && press < 1 && (
            <div style={{
              position: "absolute", left: -22, top: -22, width: 44, height: 44, borderRadius: 22,
              border: "2px solid rgba(255,255,255,.85)", opacity: 1 - press, transform: `scale(${0.4 + press})`,
            }} />
          )}
          <svg width="26" height="26" viewBox="0 0 24 24" style={{ position: "absolute", left: -3, top: -2, filter: "drop-shadow(0 2px 3px rgba(0,0,0,.5))" }}>
            <path d="M4 2l15 11-6.5 1.2L9 21z" fill="#fff" stroke="#111" strokeWidth="1.3" strokeLinejoin="round" />
          </svg>
        </div>
      )}
      {caption && (() => {
        const inT = easeOut(clamp((t - caption.start) / 0.4));
        const outT = clamp((t - (caption.end - 0.25)) / 0.25);
        return (
          <div style={{
            position: "absolute", left: 0, right: 0, bottom: 52, display: "flex", justifyContent: "center",
            opacity: inT * (1 - outT), transform: `translateY(${(1 - inT) * 14}px)`,
          }}>
            <div style={{
              padding: "12px 22px", borderRadius: 14, background: "rgba(10,12,15,.78)", color: "#f2f4f7",
              font: "600 30px/1.2 Inter, 'Helvetica Neue', Arial, sans-serif", letterSpacing: "-0.01em",
              boxShadow: "0 10px 30px rgba(0,0,0,.4), 0 0 0 1px rgba(255,255,255,.08)",
            }}>{caption.text}</div>
          </div>
        );
      })()}
    </AbsoluteFill>
  );
}
