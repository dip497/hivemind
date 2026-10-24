/**
 * A theme's font files as views get them (view protocol 1.17): the bytes of each, read once per
 * set of faces and shared by every view, since a view's frame cannot fetch the app's files. Sent in
 * `hello` and when the faces change, never with `theme`, which goes out on every slider move.
 */
import type { FontFaces } from "@hivemind/core/appearance-extra";
import type { ViewFontFace } from "@hivemind/view-sdk/protocol";

/** What identifies a set of faces: the same key, the same bytes. */
export const fontFacesKey = (f: FontFaces | undefined): string => (f ? JSON.stringify(f) : "");

let cached: { key: string; faces: Promise<ViewFontFace[]>; done: ViewFontFace[] | null } | null = null;

function base64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  // In slices: one String.fromCharCode over 400 KB of arguments overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

async function read(f: FontFaces): Promise<ViewFontFace[]> {
  const files = [f.ui, f.mono].flatMap((set) => set?.files.map((x) => ({ family: set.family, ...x })) ?? []);
  const out = await Promise.all(files.map(async (x) => {
    try {
      const res = await fetch(window.hive?.resourceUrl?.(x.url) ?? x.url);
      if (!res.ok) return null;
      const face: ViewFontFace = { family: x.family, data: base64(await res.arrayBuffer()), ...(x.weight ? { weight: x.weight } : {}), ...(x.style ? { style: x.style } : {}) };
      return face;
    } catch { return null; }
  }));
  return out.filter((x): x is ViewFontFace => x !== null);
}

/** The faces of `f` as views get them: the read already done (`done`), or the one under way. */
export function viewFontFaces(f: FontFaces | undefined): { key: string; done: ViewFontFace[] | null; faces: Promise<ViewFontFace[]> } {
  const key = fontFacesKey(f);
  if (!f) return { key, done: [], faces: Promise.resolve([]) };
  if (cached?.key !== key) {
    const entry: NonNullable<typeof cached> = { key, done: null, faces: read(f) };
    entry.faces.then((faces) => { entry.done = faces; }, () => {});
    cached = entry;
  }
  return cached;
}
