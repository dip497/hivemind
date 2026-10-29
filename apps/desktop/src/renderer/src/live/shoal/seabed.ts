/**
 * Shoal's sea bed, in its own colours: a sand floor along the bottom with rocks on it, branching
 * coral, sea fans, tube sponges, brain coral, and weed that sways. Each is drawn in cells as the
 * sharks are, a block with a character on it, in its colour. Laid out once per grid from a fixed
 * seed, so a window shows the same reef each time; the weed is the only part that moves.
 */

/** The bed's colours, by the name a cell gives. */
export type BedColour = "sand" | "rock" | "coral0" | "coral1" | "coral2" | "fan" | "brain";

/** One still cell of the bed: its glyph and its colour, on a block of that colour or bare. */
export interface BedCell {
  c: number;
  r: number;
  glyph: string;
  colour: BedColour;
  block: boolean;
}

/** A strand of weed: its foot, how tall, its colour (0–2) and where in its sway it starts. */
export interface Weed {
  c: number;
  foot: number;
  height: number;
  colour: number;
  phase: number;
}

/** A small seeded generator (mulberry32), apart from Math.random, which the World's run keeps. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Seabed {
  cells: BedCell[] = [];
  weeds: Weed[] = [];

  build(cols: number, rows: number) {
    const rnd = prng(0x5eabed + cols * 131 + rows);
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
    const bottom = rows - 1;
    const band = Math.max(6, Math.min(15, Math.round(rows * 0.17)));
    /** One cell a place: the last laid wins, so coral stands in front of the sand behind it. */
    const at = new Map<number, BedCell>();
    const put = (c: number, r: number, glyph: string, colour: BedColour, block = true) => {
      if (c < 0 || c >= cols || r < 0 || r > bottom) return;
      at.set(r * cols + c, { c, r, glyph, colour, block });
    };
    /** Where the bed's top is in each column: what stands on it stands here. */
    const ground = new Array<number>(cols).fill(bottom);
    const stand = (c: number) => ground[Math.max(0, Math.min(cols - 1, c))]! - 1;

    // The sand: the bottom row whole, low dunes over it.
    const d1 = rnd() * 9;
    const d2 = rnd() * 9;
    for (let c = 0; c < cols; c++) {
      put(c, bottom, rnd() < 0.5 ? pick([".", ",", "'", "`"]) : " ", "sand");
      const dune = Math.sin(c * 0.11 + d1) + 0.6 * Math.sin(c * 0.29 + d2);
      if (dune > 0.35) {
        put(c, bottom - 1, rnd() < 0.4 ? pick([".", ","]) : " ", "sand");
        ground[c] = bottom - 1;
      } else if (rnd() < 0.25) put(c, bottom - 1, pick([".", ",", "`"]), "sand", false);
    }

    /** A low mound `w` wide and up to `h` tall on the bed at `c0`, cell by cell. */
    const mound = (c0: number, w: number, h: number, cell: (i: number, j: number) => void) => {
      for (let i = 0; i < w; i++) {
        const x = (i + 0.5) / w - 0.5;
        const tall = Math.max(1, Math.round(h * Math.sqrt(Math.max(0, 1 - 4 * x * x)) + 0.35));
        for (let j = 0; j < tall; j++) cell(i, j);
        ground[c0 + i] = Math.min(ground[c0 + i]!, stand(c0 + i) + 1 - tall);
      }
    };
    // The reef in slots along the bed, one thing to a slot, so each stands apart with sand and weed
    // between: a slot is some eleven cells, and one in six is left open.
    const slot = 11;
    const slots = Math.max(3, Math.floor(cols / slot));
    const width = cols / slots;
    const kinds = ["branch", "branch", "fan", "brain", "sponge", "rock", "branch", "open"] as const;
    const colours = ["coral0", "coral2", "coral0", "coral1", "coral2"] as const;
    let branches = 0;
    for (let n = 0; n < slots; n++) {
      const kind = rnd() < 1 / 6 ? "open" : pick(kinds);
      const mid = Math.round((n + 0.5) * width + (rnd() - 0.5) * width * 0.3);
      const most = Math.max(4, Math.floor(width) - 2);
      if (kind === "rock") {
        const w = Math.min(most, 4 + Math.floor(rnd() * 5));
        const c0 = mid - (w >> 1);
        mound(c0, w, 1 + Math.floor(rnd() * 2.6), (i, j) => put(c0 + i, stand(c0 + i) - j, pick(["%", "#", "&", "8", " "]), "rock"));
      } else if (kind === "brain") {
        const w = Math.min(most, 5 + Math.floor(rnd() * 4));
        const c0 = mid - (w >> 1);
        mound(c0, w, 2 + Math.floor(rnd() * 2.5), (i, j) => put(c0 + i, stand(c0 + i) - j, (i + 2 * j) % 3 === 0 ? "o" : (i + j) % 2 ? "S" : "@", "brain"));
      } else if (kind === "sponge") {
        // Tubes side by side, open at the top.
        const k = 2 + Math.floor(rnd() * 3);
        for (let i = 0; i < k; i++) {
          const c = mid - (k >> 1) + i;
          const tall = 2 + Math.floor(rnd() * Math.min(5, band - 4));
          const base = stand(c);
          for (let j = 0; j < tall; j++) put(c, base - j, j === tall - 1 ? "O" : pick(["|", ":", "!"]), pick(["coral1", "coral1", "coral2"]));
        }
      } else if (kind === "fan") {
        // A round net spread over a short stem.
        const h = Math.max(5, Math.min(band - 1, 5 + Math.floor(rnd() * (band - 4))));
        const base = stand(mid);
        put(mid, base, "|", "fan");
        const cy = base - 1 - (h - 1) * 0.55;
        const ry = (h - 1) * 0.55;
        const rx = Math.min(most / 2, ry * 1.25);
        for (let r = base - h + 1; r < base; r++) {
          for (let c = mid - Math.ceil(rx); c <= mid + Math.ceil(rx); c++) {
            const d = ((c - mid) / (rx + 0.5)) ** 2 + ((r - cy) / (ry + 0.5)) ** 2;
            if (d > 1 || r > base - 1) continue;
            const edge = d > 0.62;
            if (edge || (c + r) % 2 === 0) put(c, r, edge ? ":" : pick([":", "+", "x"]), "fan");
            else put(c, r, ".", "fan", false);
          }
        }
      } else if (kind === "branch") {
        // A trunk that forks as it grows, a polyp at the end of each branch.
        const colour = colours[branches++ % colours.length]!;
        const tall = Math.max(4, Math.min(band, 4 + Math.floor(rnd() * (band - 3))));
        const lo = mid - (most >> 1);
        const hi = mid + (most >> 1);
        const grow = (c: number, r: number, dir: number, left: number, forks: number) => {
          for (let n = 0; n < left; n++) {
            if (c <= lo || c >= hi) dir = c <= lo ? 1 : -1;
            if (n === left - 1) {
              put(c, r, pick(["o", "*", "o"]), colour);
              if (rnd() < 0.6) put(c + (rnd() < 0.5 ? -1 : 1), r, ".", colour, false);
              return;
            }
            if (forks > 0 && n > 0 && rnd() < 0.42) {
              put(c, r, "Y", colour);
              grow(c - 1, r - 1, -1, left - n - 1, forks - 1);
              grow(c + 1, r - 1, 1, left - n - 1 - (rnd() < 0.35 ? 1 : 0), forks - 1);
              return;
            }
            put(c, r, dir < 0 ? "\\" : dir > 0 ? "/" : pick(["|", ":"]), colour);
            // A thick trunk near the bed.
            if (n === 0 && dir === 0) put(c + 1, r, ":", colour);
            r -= 1;
            c += dir;
            if (rnd() < 0.32) dir = dir === 0 ? (rnd() < 0.5 ? -1 : 1) : 0;
          }
        };
        grow(mid, stand(mid), 0, tall, 3);
      }
    }

    this.cells = [...at.values()];

    // Weed: strands rising from the bed, the tallest above the coral, none more than a few cells
    // above the reef, even from a rock.
    this.weeds = Array.from({ length: Math.max(5, Math.round(cols / 13)) }, (_, k) => {
      const c = Math.floor(rnd() * cols);
      const foot = stand(c);
      const height = Math.max(3, Math.min(4 + Math.floor(rnd() * (band + 3)), foot - (bottom - band - 3)));
      return { c, foot, height, colour: k % 3, phase: rnd() * Math.PI * 2 };
    });
  }

  /** How many cells over from its foot a strand's `k`th cell up has swayed at time `t`. */
  static sway(w: Weed, k: number, t: number) {
    const lean = Math.pow(k / w.height, 1.3);
    return Math.round(1.6 * lean * Math.sin(t * 0.7 + w.phase - k * 0.42) + 0.6 * lean * Math.sin(t * 0.23 + w.phase * 2));
  }
}
