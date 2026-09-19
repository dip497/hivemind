/** Frame colours are CSS strings (`oklch(...)`) that neither three.js nor a
 *  plugin over a MessagePort can parse; resolve them through a 2D canvas fill,
 *  which Chromium understands, and cache. Shared by the World view and the
 *  community-view host. */
const cssColorCache = new Map<string, number>();
let cssCtx: CanvasRenderingContext2D | null | undefined;

export function cssColorToHex(css: string): number {
  const hit = cssColorCache.get(css);
  if (hit !== undefined) return hit;
  let hex = 0x8899aa;
  try {
    if (cssCtx === undefined) cssCtx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (cssCtx) {
      cssCtx.clearRect(0, 0, 1, 1);
      cssCtx.fillStyle = "#000";
      cssCtx.fillStyle = css; // an unparsable string leaves the previous value
      cssCtx.fillRect(0, 0, 1, 1);
      const [r, g, b] = cssCtx.getImageData(0, 0, 1, 1).data;
      hex = ((r ?? 0) << 16) | ((g ?? 0) << 8) | (b ?? 0);
    }
  } catch { /* keep the fallback */ }
  cssColorCache.set(css, hex);
  return hex;
}

/** `#rrggbb` form of the same resolution. */
export function cssColorToHexString(css: string): string {
  return `#${cssColorToHex(css).toString(16).padStart(6, "0")}`;
}
