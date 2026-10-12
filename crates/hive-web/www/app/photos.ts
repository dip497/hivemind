// Photos given with a prompt, as the computer takes them: a png, jpeg, webp or gif kept as it is
// when small, else drawn again as a jpeg at most 2048 pixels on its longer side.

import type { Photo } from "./types.js";

/** The most photos one start takes (the computer's IMAGES_MAX). */
export const PHOTOS_MAX = 4;
const KEPT = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const SMALL = 1024 * 1024;
const SIDE = 2048;

const base64 = (bytes: ArrayBuffer): string => {
  const all = new Uint8Array(bytes);
  let text = "";
  for (let i = 0; i < all.length; i += 0x8000) text += String.fromCharCode(...all.subarray(i, i + 0x8000));
  return btoa(text);
};

export async function photoOf(file: Blob): Promise<Photo> {
  if (KEPT.includes(file.type) && file.size <= SMALL) return { type: file.type, data: base64(await file.arrayBuffer()) };
  const image = await createImageBitmap(file);
  const scale = Math.min(1, SIDE / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
  image.close();
  const jpeg = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/jpeg", 0.85));
  if (!jpeg) throw new Error("it could not be drawn again");
  return { type: "image/jpeg", data: base64(await jpeg.arrayBuffer()) };
}
