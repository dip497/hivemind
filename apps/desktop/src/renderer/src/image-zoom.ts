/** The Image tile's zoom: fixed steps, and pixels drawn square once each is bigger than 3 screen pixels. */
export const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16] as const;

/** The next step in `dir` from `scale`, which may sit between steps (a fit); the end step at the ends. */
export function nextZoom(scale: number, dir: 1 | -1): number {
  if (dir === 1) return ZOOM_STEPS.find((s) => s > scale + 1e-6) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]!;
  return [...ZOOM_STEPS].reverse().find((s) => s < scale - 1e-6) ?? ZOOM_STEPS[0];
}

/** The scale that fits `w`×`h` in a box, never above 1: a small picture shows at its own size. */
export function fitScale(w: number, h: number, boxW: number, boxH: number): number {
  if (w <= 0 || h <= 0 || boxW <= 0 || boxH <= 0) return 1;
  return Math.min(1, boxW / w, boxH / h);
}

export const sharpPixels = (scale: number): boolean => scale > 3;

/** `1.2 MB`, `340 KB`, `12 B`. */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
