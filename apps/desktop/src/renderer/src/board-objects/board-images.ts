/**
 * Pictures on the board, in the window: a pasted, dropped or picked picture is made no larger than
 * the board keeps, kept by the workspace's host (`board.keepImage`) and placed as an `image` shape;
 * a picture on the board is fetched by its hash once and shown from one object URL per picture.
 */
import { useEffect, type RefObject } from "react";
import { toast } from "sonner";
import type { StartImage } from "@hivemind/workspace-api/agents";
import { PLACED_IMAGE_MOST, imageBoxSize, type Point } from "@hivemind/workspace-doc/drawing";
import { BOARD_IMAGE_TYPES, type BoardImage } from "@hivemind/workspace-doc/shapes";
import type { Board } from "./useBoard";

/** The most pixels a kept picture has on its long side, and the most bytes it may have (the host's). */
const SIDE_MOST = 4096;
const BYTES_MOST = 10 * 1024 * 1024;
const TAKEN: ReadonlySet<string> = new Set(BOARD_IMAGE_TYPES);

/** The picture files among `files`: what the board takes. */
export const picturesIn = (files: FileList | readonly File[] | null | undefined): File[] => [...(files ?? [])].filter((f) => TAKEN.has(f.type));

const base64Of = async (blob: Blob): Promise<string> => {
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return url.slice(url.indexOf(",") + 1);
};

/** `image` no larger than `most` pixels on its long side, decoded and drawn off the page's thread. A
 *  GIF comes back as a PNG of its first frame. */
export async function shrinkImage(image: StartImage, most: number): Promise<StartImage> {
  const bytes = Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: image.type }));
  try {
    const scale = Math.min(1, most / Math.max(bitmap.width, bitmap.height));
    if (scale === 1) return image;
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const type = image.type === "image/gif" ? "image/png" : image.type;
    const blob = await canvas.convertToBlob({ type, quality: 0.9 });
    return { type: blob.type as StartImage["type"], data: await base64Of(blob) };
  } finally {
    bitmap.close();
  }
}

/** Keep `file` for `board`'s workspace and place it with its centre at `at`, inside the frame there, selected. */
export async function placePicture(board: Board, file: File, at: Point): Promise<void> {
  const repo = board.repo;
  if (!repo) return;
  try {
    if (!TAKEN.has(file.type)) throw new Error("the board takes a PNG, JPEG, WebP or GIF");
    if (file.size > BYTES_MOST) throw new Error("a picture on the board is at most 10 MB");
    const kept = await window.hive.boardKeepImage(repo, await shrinkImage({ type: file.type as StartImage["type"], data: await base64Of(file) }, SIDE_MOST));
    const { w, h } = imageBoxSize(kept, PLACED_IMAGE_MOST);
    const alt = file.name && !/^image\.\w+$/i.test(file.name) ? file.name.replace(/\.\w+$/, "") : undefined;
    board.addShape({ form: "image", x: Math.round(at.x - w / 2), y: Math.round(at.y - h / 2), w, h, image: kept, ...(alt ? { alt } : {}) }, "select");
  } catch (e) {
    toast.error("The picture was not added", { description: e instanceof Error ? e.message : String(e) });
  }
}

/** Each picture's object URL by workspace and hash, fetched once while anything shows it; a failed
 *  fetch is asked again next time. In the order last let go, the least recent first. */
const kept = new Map<string, { url: Promise<string>; holders: number }>();
/** How many pictures no one shows keep their URL, for a picture scrolled back to or a workspace
 *  shown again; past it, the longest unshown is let go. */
const UNSHOWN_KEPT_MOST = 24;
/** At most two pictures are fetched at once: a board of fifty opens without fifty fetches in flight. */
const lanes: Array<Promise<unknown>> = [Promise.resolve(), Promise.resolve()];
let next = 0;

/** A picture's object URL for as long as it is shown: `release` when it is not. */
export function holdPicture(repo: string, image: BoardImage): { url: Promise<string>; release: () => void } {
  const key = `${repo}\0${image.hash}`;
  let entry = kept.get(key);
  if (!entry) {
    const lane = next++ % lanes.length;
    const url = lanes[lane]!.then(() => window.hive.boardImage(repo, image.hash)).then(({ type, data }) => URL.createObjectURL(new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type })));
    lanes[lane] = url.catch(() => undefined);
    const made = { url, holders: 0 };
    url.catch(() => { if (kept.get(key) === made) kept.delete(key); });
    kept.set(key, entry = made);
  }
  const held = entry;
  held.holders++;
  let released = false;
  return {
    url: held.url,
    release: () => {
      if (released) return;
      released = true;
      if (--held.holders > 0 || kept.get(key) !== held) return;
      kept.delete(key);
      kept.set(key, held);
      letGoUnshown();
    },
  };
}

function letGoUnshown(): void {
  let unshown = 0;
  for (const entry of kept.values()) if (entry.holders === 0) unshown++;
  for (const [key, entry] of kept) {
    if (unshown <= UNSHOWN_KEPT_MOST) return;
    if (entry.holders > 0) continue;
    kept.delete(key);
    unshown--;
    entry.url.then((url) => URL.revokeObjectURL(url), () => {});
  }
}

/** What a picture pasted into the canvas is not for: something typed in, a terminal, a tile (a frame or a drawn shape is the canvas). */
const NOT_THE_CANVAS = "input, textarea, [contenteditable]:not([contenteditable=false]), .xterm, .react-flow__node:not(.react-flow__node-shape, .react-flow__node-frame, .react-flow__node-widget)";

/**
 * Pictures pasted while the canvas has the keyboard, or dropped on it, go on the board: a pasted one
 * at the pointer (the middle of the view when it is elsewhere), a dropped one where it is let go.
 * `toCanvas` turns a point on the screen into one on the canvas.
 */
export function usePictureInput(pane: RefObject<HTMLElement | null>, live: RefObject<{ board: Board; toCanvas: (p: Point) => Point }>): void {
  useEffect(() => {
    const el = pane.current;
    if (!el) return undefined;
    let pointer: Point | null = null;
    const place = (files: File[], screen: Point) => {
      const { board, toCanvas } = live.current!;
      const at = toCanvas(screen);
      files.forEach((file, i) => void placePicture(board, file, { x: at.x + i * 24, y: at.y + i * 24 }));
    };
    const moved = (e: PointerEvent) => { pointer = { x: e.clientX, y: e.clientY }; };
    const left = () => { pointer = null; };
    const paste = (e: ClipboardEvent) => {
      if (e.defaultPrevented || el.offsetParent === null) return;
      const target = e.target instanceof Element ? e.target : document.activeElement;
      if (target && target !== document.body && (!el.contains(target) || target.closest(NOT_THE_CANVAS))) return;
      const files = picturesIn(e.clipboardData?.files);
      if (files.length === 0) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      place(files, pointer ?? { x: r.left + r.width / 2, y: r.top + r.height / 2 });
    };
    const carriesPicture = (e: DragEvent) => [...(e.dataTransfer?.items ?? [])].some((i) => i.kind === "file" && TAKEN.has(i.type));
    const over = (e: DragEvent) => {
      if (!carriesPicture(e) || (e.target as Element | null)?.closest?.(NOT_THE_CANVAS)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "copy";
    };
    const drop = (e: DragEvent) => {
      if ((e.target as Element | null)?.closest?.(NOT_THE_CANVAS)) return;
      const files = picturesIn(e.dataTransfer?.files);
      if (files.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      place(files, { x: e.clientX, y: e.clientY });
    };
    el.addEventListener("pointermove", moved);
    el.addEventListener("pointerleave", left);
    el.addEventListener("dragover", over);
    el.addEventListener("drop", drop);
    document.addEventListener("paste", paste);
    return () => {
      el.removeEventListener("pointermove", moved);
      el.removeEventListener("pointerleave", left);
      el.removeEventListener("dragover", over);
      el.removeEventListener("drop", drop);
      document.removeEventListener("paste", paste);
    };
  }, [pane, live]);
}
