/**
 * A creature drawn along a spine, as Shoal's sharks and Koi Pond's koi are: its sim spine is
 * smoothed into a swimming wave and every cell near it is sampled against its shape, seen from
 * above. A cell comes out as skin (and which part: body, fin, ridge, eye, marking) with how lit it
 * is, or as an edge with how much of it the body covers; the scene's renderer chooses its
 * character and colour. Ported from stackedlol/ascii-sharks (MIT, see shoal/LICENSE).
 */
import { clamp, hash3 } from "./math";

/** Nodes in every spine, snout first. */
export const SPINE_NODES = 20;

export const FLAG_BODY = 1;
export const FLAG_EDGE = 2;
export const FLAG_FIN = 3;
export const FLAG_RIDGE = 4;
export const FLAG_EYE = 5;
/** Markings: a tiger's bars, a zebra shark's spots, a koi's patches. */
export const FLAG_MARK = 6;

// Sub-cell sample offsets for anti-aliased silhouettes.
const SUBSAMPLES = [0.25, 0.3, 0.75, 0.3, 0.25, 0.72, 0.75, 0.72];
/** A shark's forked tail: from 0.86 along, its trailing edge back at 0.95. */
const TAIL: [number, number] = [0.86, 0.95];

/** A body's outline and fin layout, seen from above. All values are fractions of its length. */
export interface SpineShape {
  halfWidth: (s: number) => number;
  /** Pectoral fin: leading root, trailing root, tip position along the body, and reach. */
  pectoral: [number, number, number, number];
  /** Notched (falcate) trailing edge on the pectorals. */
  falcate: boolean;
  /** Pelvic fins: leading root, trailing root, tip, reach. */
  pelvic: [number, number, number, number];
  /** Forked caudal fin reach, or 0 when the tail is a ribbon (zebra shark). */
  caudal: number;
  /** Where the caudal fin starts along the body and where its trailing edge meets the body: a
   *  fork for a shark (`TAIL`), a fan for a koi, whose edge meets it at its end. */
  tail?: [number, number];
  dorsal: [number, number];
  secondDorsal: [number, number];
  /**
   * Hammerheads' cephalofoil: half-span, how far its tips sweep back, its depth, and the
   * notch in the middle of the front edge. All fractions of length; absent for other sharks.
   */
  head?: { span: number; sweep: number; depth: number; notch: number };
  /** null when the eyes sit somewhere else (hammerhead: on the cephalofoil tips). */
  eye: [number, number] | null;
  gills: [number, number] | null;
  /** How far the body sways side to side at the tail, as a share of its length (0.05). */
  sway?: number;
  /** Where the skin is paler (a zebra shark's ridges). */
  pale?(s: number, across: number): boolean;
  /** The marking at body point `s` along, `v` across (`across` of the half-width; 0 on a fin,
   *  where `fin` is true), for body `id`: 0 for none, else which marking (a shark's dark ones,
   *  a koi's patches by colour). The same point always gives the same marking. */
  mark?(s: number, v: number, L: number, across: number, id: number, fin: boolean): number;
}

/** What the raster reads of a swimming body. */
export interface SpineBody {
  id: number;
  kind: string;
  /** Sim spine, snout first: [x0, y0, x1, y1, ...], SPINE_NODES of them. */
  nodes: Float32Array;
  length: number;
  speed: number;
  /** Tail-beat phase. */
  phase: number;
  /** Smoothed angular velocity: the fins bank into turns. */
  turn: number;
  /** 0 far → 1 near. */
  depth: number;
}

/** The grid a raster fills. */
export interface Grid {
  cw: number;
  ch: number;
  cols: number;
  rows: number;
}

function inTriangle(
  px: number, py: number,
  ax: number, ay: number, bx: number, by: number, cx: number, cy: number,
) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

export class SpineRaster {
  /** Per cell, this frame: what part of a body it is (FLAG_*, 0 for none), how lit, a key that
   *  rides with the skin, the body's depth, its kind (by `kindIndex`) and its marking. */
  flag = new Uint8Array(0);
  shade = new Float32Array(0);
  key = new Uint32Array(0);
  depth = new Float32Array(0);
  kind = new Uint8Array(0);
  mark = new Uint8Array(0);
  private spine = new Float32Array(SPINE_NODES * 2);
  private arc = new Float32Array(SPINE_NODES);
  private arcTotal = 1;
  private shape: SpineShape;
  private bodyId = 0;
  private finTipLeft = 0;
  private finTipRight = 0;
  // Scratch outputs of sample(), to avoid allocating per sample.
  private hitFlag = 0;
  private hitShade = 0;
  private hitS = 0;
  private hitV = 0;
  /** The last hit's marking (`SpineShape.mark`), 0 for none. */
  private hitMark = 0;
  /** How far inside the body's outline the last hit was: 0 on a fin or the head. */
  private hitInside = 0;
  /** Whether the last sample was within some segment's reach (`segReach`): when not, no point
   *  within half a cell of it can be on the body. */
  private hitNear = false;
  /** The spine's segments, worked out once per body per frame: each one's run and length². */
  private segDx = new Float64Array(SPINE_NODES);
  private segDy = new Float64Array(SPINE_NODES);
  private segLen2 = new Float64Array(SPINE_NODES);
  /** How far each segment's part of the body reaches from it, sideways (`segmentReach`). */
  private segReach = new Float64Array(SPINE_NODES);


  constructor(private shapes: Readonly<Record<string, SpineShape>>, private kindIndex: Readonly<Record<string, number>>) {
    this.shape = Object.values(shapes)[0]!;
  }

  allocate(n: number) {
    this.flag = new Uint8Array(n);
    this.shade = new Float32Array(n);
    this.key = new Uint32Array(n);
    this.depth = new Float32Array(n);
    this.kind = new Uint8Array(n);
    this.mark = new Uint8Array(n);
  }

  /**
   * Classify one point against the current body (spine/arc already built).
   * Body coordinates: s along the spine (0 snout → 1 tail), v across it.
   * Writes hit* fields and returns whether the point is on the body.
   */
  private sample(px: number, py: number, L: number) {
    const { spine, arc } = this;
    const N = SPINE_NODES;
    const { segDx, segDy, segLen2 } = this;
    const { segReach } = this;
    let best = Infinity;
    let bestK = 0;
    let bestU = 0;
    let near = false;
    for (let k = 0; k < N - 1; k++) {
      const ax = spine[k * 2]!;
      const ay = spine[k * 2 + 1]!;
      const sx = segDx[k]!;
      const sy = segDy[k]!;
      const u = clamp(((px - ax) * sx + (py - ay) * sy) / segLen2[k]!, 0, 1);
      const qx = ax + sx * u;
      const qy = ay + sy * u;
      const d2 = (px - qx) ** 2 + (py - qy) ** 2;
      if (d2 <= segReach[k]! * segReach[k]!) near = true;
      if (d2 < best) {
        best = d2;
        bestK = k;
        bestU = u;
      }
    }
    // Where along the body the nearest point is, which side of the spine, and the normal there.
    const sx = segDx[bestK]!;
    const sy = segDy[bestK]!;
    const len = Math.sqrt(segLen2[bestK]!);
    const bestS = (arc[bestK]! + bestU * len) / this.arcTotal;
    const bestSign = sx * (py - spine[bestK * 2 + 1]!) - sy * (px - spine[bestK * 2]!) >= 0 ? 1 : -1;
    const bestNx = (-sy / len) * bestSign;
    const bestNy = (sx / len) * bestSign;

    const a = Math.sqrt(best);
    const s = bestS;
    const u = s * L;
    const shape = this.shape;
    const w = shape.halfWidth(s) * L;
    this.hitS = s;
    this.hitV = a * bestSign;
    this.hitInside = 0;
    this.hitNear = near;
    this.hitMark = 0;

    const head = shape.head;
    if (head && u < L * (head.sweep + head.depth + head.notch)) {
      // Cephalofoil: a wide wing across the snout, its tips swept back toward the eyes,
      // and on a great hammerhead a shallow notch in the middle of the front edge.
      const span = L * head.span;
      const r = a / span;
      const front = L * head.sweep * r * r + L * head.notch * Math.max(0, 1 - r / 0.14);
      // Full depth almost to the tips, so the wing reads as a solid bar rather than a thin line.
      const depth = L * head.depth * (1 - 0.2 * r * r * r * r);
      if (r <= 1 && u >= front && u <= front + depth) {
        this.hitFlag = r > 0.84 ? FLAG_EYE : FLAG_BODY;
        this.hitShade = r > 0.84 ? 0 : 0.62 - 0.2 * r + (u < front + L * 0.012 ? 0.1 : 0);
        return true;
      }
    }

    if (a <= w) {
      const across = a / (w || 1);
      const mark = shape.mark ? shape.mark(s, a * bestSign, L, across, this.bodyId, false) : 0;
      // Rounded back lit from the top-left; flanks fall off into shadow.
      const facing = (bestNx * -0.6 + bestNy * -0.8) * across;
      let shade = 0.58 - across * across * 0.42 + facing * 0.26;
      let flag = FLAG_BODY;
      if (s > shape.dorsal[0] && s < shape.dorsal[1] && across < 0.3) {
        // First dorsal fin, catching the light.
        flag = FLAG_RIDGE;
        shade = 1;
      } else if (s > shape.secondDorsal[0] && s < shape.secondDorsal[1] && across < 0.4) {
        shade = Math.max(shade, 0.82);
      } else if (shape.eye && s > shape.eye[0] && s < shape.eye[1] && across > 0.6) {
        flag = FLAG_EYE;
        shade = 0;
      } else if (shape.gills && s > shape.gills[0] && s < shape.gills[1] && across > 0.58) {
        // Five gill slits.
        if (Math.floor(((s - shape.gills[0]) / (shape.gills[1] - shape.gills[0])) * 5) % 2 === 0) shade *= 0.45;
      } else if (s < 0.05) {
        // Pale snout tip.
        shade = Math.max(shade, 0.7);
      } else if (shape.pale?.(s, across)) {
        shade = Math.max(shade, 0.8);
      } else if (mark) {
        flag = FLAG_MARK;
      }
      this.hitMark = mark;
      this.hitFlag = flag;
      this.hitShade = shade;
      this.hitInside = w - a;
      return true;
    }

    const tip = bestSign > 0 ? this.finTipRight : this.finTipLeft;
    const [p0, p1, p2] = shape.pectoral;
    if (
      inTriangle(u, a, L * p0, 0, L * p1, 0, L * p2, tip) &&
      // Falcate (sickle) fins get a concave trailing edge.
      !(shape.falcate && inTriangle(u, a, L * p1, 0, L * (p1 + (p2 - p1) * 0.33), tip * 0.55, L * p2, tip))
    ) {
      const mark = shape.mark ? shape.mark(s, a * bestSign, L, 0, this.bodyId, true) : 0;
      this.hitMark = mark;
      this.hitFlag = mark ? FLAG_MARK : FLAG_FIN;
      this.hitShade = 0.38 + 0.22 * (1 - clamp(a / tip, 0, 1));
      return true;
    }
    const [v0, v1, v2, vr] = shape.pelvic;
    const [t0, t1] = shape.tail ?? TAIL;
    if (
      inTriangle(u, a, L * v0, 0, L * v1, 0, L * v2, L * vr) ||
      // Forked caudal fin.
      (shape.caudal > 0 && inTriangle(u, a, L * t0, 0, L * t1, 0, L, L * shape.caudal))
    ) {
      // A fin's own colour, where the body has them (a koi's).
      if (shape.mark) this.hitMark = shape.mark(s, a * bestSign, L, 0, this.bodyId, true);
      this.hitFlag = FLAG_FIN;
      this.hitShade = 0.36;
      return true;
    }
    return false;
  }

  /** How far from the spine the part of the body between body points `a` and `b` (0 snout, 1
   *  tail) reaches: its body's half-width, and past it the head or a fin where one is, as a share
   *  of its length. A fin is a triangle whose leading edge rises from its root to its tip, so it
   *  reaches far only near the tip. The half-width is taken at the ends and the middle: within one
   *  segment it changes by less than the margin its caller adds. */
  private segmentReach(a: number, b: number, L: number) {
    const sh = this.shape;
    // A fin from `root` to `tip` along the body, `reach` out at its tip: how far out it is by `b`.
    const fin = (root: number, tip: number, reach: number) => (b > root && a < tip ? reach * Math.min(1, (b - root) / (tip - root)) : 0);
    let r = Math.max(sh.halfWidth(a), sh.halfWidth((a + b) / 2), sh.halfWidth(b));
    const head = sh.head;
    if (head && a < head.sweep + head.depth + head.notch) r = Math.max(r, head.span);
    r = Math.max(r, fin(sh.pectoral[0], sh.pectoral[2], Math.max(this.finTipLeft, this.finTipRight) / L), fin(sh.pelvic[0], sh.pelvic[2], sh.pelvic[3]));
    if (sh.caudal > 0) r = Math.max(r, fin((sh.tail ?? TAIL)[0], 1, sh.caudal));
    return r;
  }

  /**
   * Build a smooth, undulating render spine from each body's sim spine, then
   * supersample every cell in its bounding box against its shape.
   * Fully covered cells become solid skin; partial cells become edge glyphs.
   * A cell under a tile is left out, unless the tiles are see-through.
   */
  rasterize(bodies: readonly SpineBody[], t: number, grid: Grid, cover: Uint8Array, seeThrough: boolean) {
    const { flag: sharkFlag, shade: sharkShade, key: sharkKey, depth: sharkDepth, kind: sharkKind, mark: sharkMark, spine, arc } = this;
    const { cw, ch, cols, rows } = grid;
    sharkFlag.fill(0);

    for (const sh of bodies) {
      const L = sh.length;
      const N = SPINE_NODES;
      const n = sh.nodes;
      const swim = clamp(sh.speed / 60, 0.4, 1.4);
      this.shape = this.shapes[sh.kind]!;
      this.bodyId = sh.id;

      // Travelling body wave, growing toward the tail.
      for (let k = 0; k < N; k++) {
        const s = k / (N - 1);
        const a = Math.max(0, k - 1);
        const b = Math.min(N - 1, k + 1);
        let tx = n[a * 2]! - n[b * 2]!;
        let ty = n[a * 2 + 1]! - n[b * 2 + 1]!;
        const tl = Math.hypot(tx, ty) || 1;
        tx /= tl;
        ty /= tl;
        const amp = L * (this.shape.sway ?? 0.05) * (0.1 + 0.9 * Math.pow(s, 1.8)) * swim;
        const off = amp * Math.sin(sh.phase - s * 5.2);
        spine[k * 2] = n[k * 2]! - ty * off;
        spine[k * 2 + 1] = n[k * 2 + 1]! + tx * off;
      }
      arc[0] = 0;
      for (let k = 1; k < N; k++) {
        arc[k] =
          arc[k - 1]! +
          Math.hypot(spine[k * 2]! - spine[(k - 1) * 2]!, spine[k * 2 + 1]! - spine[(k - 1) * 2 + 1]!);
      }
      this.arcTotal = arc[N - 1]! || 1;
      for (let k = 0; k < N - 1; k++) {
        const dx = spine[(k + 1) * 2]! - spine[k * 2]!;
        const dy = spine[(k + 1) * 2 + 1]! - spine[k * 2 + 1]!;
        this.segDx[k] = dx;
        this.segDy[k] = dy;
        this.segLen2[k] = dx * dx + dy * dy || 1;
      }

      // Bank into turns: the inside fin foreshortens, the outside one spreads.
      const bank = clamp(sh.turn * 0.45, -0.35, 0.35);
      const flex = 1 + 0.06 * Math.sin(sh.phase * 0.5);
      const reachFin = this.shape.pectoral[3];
      this.finTipRight = L * reachFin * flex * (1 - bank);
      this.finTipLeft = L * reachFin * flex * (1 + bank);

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let k = 0; k < N; k++) {
        minX = Math.min(minX, spine[k * 2]!);
        maxX = Math.max(maxX, spine[k * 2]!);
        minY = Math.min(minY, spine[k * 2 + 1]!);
        maxY = Math.max(maxY, spine[k * 2 + 1]!);
      }
      const reach = L * 0.36;
      const c0 = Math.max(0, Math.floor((minX - reach) / cw));
      const c1 = Math.min(cols - 1, Math.floor((maxX + reach) / cw));
      const r0 = Math.max(0, Math.floor((minY - reach) / ch));
      const r1 = Math.min(rows - 1, Math.floor((maxY + reach) / ch));
      if (c0 > c1 || r0 > r1) continue;

      // A cell whose centre is this far inside the body is covered whole: no sub-sample can miss.
      const halfCell = Math.hypot(cw, ch) / 2;
      // Each segment's own reach, and half a cell more: a sample is on the shark only within its
      // part's reach of the segment its nearest spine point is on, and a cell's samples are within
      // half a cell of its centre. So a row is searched only as far as some segment reaches, and a
      // cell whose centre is out of every segment's reach is empty (checked against sampling every
      // cell). The body is narrow along most of its length; only the head and fin tips reach far.
      const segReach = this.segReach;
      for (let k = 0; k < N - 1; k++) segReach[k] = this.segmentReach(arc[k]! / this.arcTotal, arc[k + 1]! / this.arcTotal, L) * L + L * 0.02 + halfCell;

      for (let r = r0; r <= r1; r++) {
        // Only the cells of this row the shark can reach: a diagonal shark leaves most of its box
        // empty, and an empty cell would still be tested against every segment of the spine.
        const yc = r * ch + ch / 2;
        let lo = Infinity;
        let hi = -Infinity;
        for (let k = 0; k < N - 1; k++) {
          const ya = spine[k * 2 + 1]!;
          const yb = spine[k * 2 + 3]!;
          const rk = segReach[k]!;
          if (yc < Math.min(ya, yb) - rk || yc > Math.max(ya, yb) + rk) continue;
          lo = Math.min(lo, spine[k * 2]! - rk, spine[k * 2 + 2]! - rk);
          hi = Math.max(hi, spine[k * 2]! + rk, spine[k * 2 + 2]! + rk);
        }
        if (lo > hi) continue;
        const cLo = Math.max(c0, Math.floor(lo / cw));
        const cHi = Math.min(c1, Math.floor(hi / cw));
        for (let c = cLo; c <= cHi; c++) {
          if (cover[r * cols + c] && !seeThrough) continue;
          const x = c * cw;
          const y = r * ch;
          const centerHit = this.sample(x + cw / 2, y + ch / 2, L);
          if (!centerHit && !this.hitNear) continue;
          const flag = this.hitFlag;
          const shade = this.hitShade;
          const s = this.hitS;
          const v = this.hitV;
          const mark = this.hitMark;

          let hits = centerHit ? 1 : 0;
          if (centerHit && this.hitInside > halfCell) hits = 5;
          else {
            for (let k = 0; k < SUBSAMPLES.length; k += 2) {
              if (this.sample(x + SUBSAMPLES[k]! * cw, y + SUBSAMPLES[k + 1]! * ch, L)) hits++;
            }
          }
          if (hits === 0) continue;
          const coverage = hits / 5;

          const i = r * cols + c;
          // Body-anchored key so each glyph rides along with the skin.
          const key = (hash3(Math.round(s * 52), Math.round(v / (cw * 0.9)), sh.id) * 4294967295) >>> 0;
          sharkKey[i] = key;
          sharkDepth[i] = sh.depth;
          sharkKind[i] = this.kindIndex[sh.kind]!;
          sharkMark[i] = mark;

          if (centerHit && coverage >= 0.6) {
            sharkFlag[i] = flag;
            const flicker = (hash3(c, r, Math.floor(t * 6)) - 0.5) * 0.06;
            sharkShade[i] = clamp(shade + flicker, 0, 1);
          } else {
            sharkFlag[i] = FLAG_EDGE;
            sharkShade[i] = coverage;
          }
        }
      }
    }
  }
}
