// The board's pictures as the host keeps them: named by the sha256 of their bytes, what each is and
// its size read from the bytes themselves, kept across a restart, capped, made smaller by a window
// when too large, and anything that is not a PNG, JPEG, WebP or GIF refused.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { BoardImages, IMAGE_BYTES_MOST, WORKSPACE_PICTURES_MOST } from "../src/board-images.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-board-images-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let made = 0;
const fresh = (shrink?: ConstructorParameters<typeof BoardImages>[0]["shrink"]) => {
  const dir = path.join(tmp, `s${++made}`);
  return { dir, images: new BoardImages({ dir, ...(shrink ? { shrink } : {}) }) };
};

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
/** A PNG whose header says it is `w` by `h`. */
const pngSized = (w: number, h: number) => {
  const b = Buffer.from(ONE_PIXEL_PNG);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
// A JPEG with an APP0 segment before its frame: 400 wide, 300 tall.
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1"),
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]),
  Buffer.from([0xff, 0xd9]),
]);
// The same JPEG with 320 KB of metadata before its frame, as a camera's can have.
const LATE_JPEG = Buffer.concat([JPEG.subarray(0, 2), ...Array.from({ length: 5 }, () => Buffer.concat([Buffer.from([0xff, 0xe1, 0xff, 0xff]), Buffer.alloc(0xfffd)])), JPEG.subarray(2)]);
const GIF = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.from([7, 0, 3, 0, 0, 0, 0]), Buffer.from(";", "latin1")]);
// An extended WebP: 1000 by 2000, each written as one less, in three bytes.
const WEBP = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.from([22, 0, 0, 0]), Buffer.from("WEBPVP8X", "latin1"), Buffer.from([10, 0, 0, 0, 0, 0, 0, 0]),
  Buffer.from([0xe7, 0x03, 0x00, 0xcf, 0x07, 0x00])]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');

const sent = (bytes: Buffer, type = "image/png") => ({ type, data: bytes.toString("base64") });
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

test("each picture is named by the sha256 of its bytes, with what it is and its size read from them, not from what the caller said", async () => {
  const { dir, images } = fresh();
  const cases: Array<[Buffer, string, number, number]> = [
    [ONE_PIXEL_PNG, "image/png", 1, 1], [JPEG, "image/jpeg", 400, 300], [GIF, "image/gif", 7, 3], [WEBP, "image/webp", 1000, 2000],
  ];
  for (const [bytes, type, width, height] of cases) {
    const kept = await images.keep("/w", sent(bytes, "image/gif"));
    assert.deepEqual(kept, { hash: sha(bytes), type, width, height });
    assert.deepEqual(await images.read("/w", kept.hash), { type, data: bytes.toString("base64") });
  }
  // The same bytes again are the same picture; and after a restart they are still there.
  assert.equal((await images.keep("/w", sent(JPEG))).hash, sha(JPEG));
  const again = new BoardImages({ dir });
  assert.deepEqual(again.find("/w", sha(JPEG)), { hash: sha(JPEG), type: "image/jpeg", width: 400, height: 300 });
  // Kept for one workspace, a picture is not another's.
  assert.equal(again.find("/other", sha(JPEG)), null);
  await images.keep("/w", sent(LATE_JPEG));
  assert.deepEqual(new BoardImages({ dir }).find("/w", sha(LATE_JPEG)), { hash: sha(LATE_JPEG), type: "image/jpeg", width: 400, height: 300 });
  assert.equal(await again.read("/w", "../../etc/passwd"), null);
});

test("SVG, text and a file over 10 MB are refused, saying what is taken", async () => {
  const { images } = fresh();
  await assert.rejects(images.keep("/w", sent(SVG, "image/svg+xml")), { code: "BAD_REQUEST", message: /PNG, JPEG, WebP or GIF/ });
  await assert.rejects(images.keep("/w", sent(Buffer.from("hello"))), { code: "BAD_REQUEST", message: /PNG, JPEG, WebP or GIF/ });
  await assert.rejects(images.keep("/w", { type: "image/png", data: "not base64!" }), { code: "BAD_REQUEST" });
  const big = Buffer.concat([pngSized(10, 10), Buffer.alloc(IMAGE_BYTES_MOST)]);
  await assert.rejects(images.keep("/w", sent(big)), { code: "BAD_REQUEST", message: /at most 10 MB/ });
});

test("a picture over 4096 pixels on its long side is kept as the window made it smaller, and refused where no window can", async () => {
  const asked: number[] = [];
  const { images } = fresh(async (_image, most) => { asked.push(most); return sent(pngSized(4096, 2048)); });
  const kept = await images.keep("/w", sent(pngSized(8192, 4096)));
  assert.deepEqual(asked, [4096]);
  assert.deepEqual([kept.width, kept.height, kept.hash], [4096, 2048, sha(pngSized(4096, 2048))]);
  // 4096 itself is kept as it is.
  assert.equal((await images.keep("/w", sent(pngSized(4096, 10)))).width, 4096);

  const none = fresh().images;
  await assert.rejects(none.keep("/w", sent(pngSized(4097, 10))), { code: "UNSUPPORTED", message: /4097×10: at most 4096/ });
  const stubborn = fresh(async (image) => image).images;
  await assert.rejects(stubborn.keep("/w", sent(pngSized(5000, 10))), { code: "FAILED" });
});

test("a workspace's board keeps at most 500 MB of pictures, counted across a restart; past that a new one is refused saying why, while another workspace and a picture already kept still go in", async () => {
  const { dir, images } = fresh();
  await images.keep("/w", sent(JPEG));
  // What is kept already counts: a sparse file stands for the pictures kept before a restart.
  const folder = path.join(dir, createHash("sha256").update("/w").digest("hex").slice(0, 32));
  fs.writeFileSync(path.join(folder, "f".repeat(64)), "");
  fs.truncateSync(path.join(folder, "f".repeat(64)), WORKSPACE_PICTURES_MOST - JPEG.length - 10);
  const after = new BoardImages({ dir });
  await assert.rejects(after.keep("/w", sent(GIF)), { code: "FILE_TOO_BIG", message: /at most 500 MB of pictures and holds 500\.0 MB: make the picture smaller/ });
  assert.equal(after.find("/w", sha(GIF)), null);
  assert.equal((await after.keep("/w", sent(JPEG))).hash, sha(JPEG));
  assert.equal((await after.keep("/other", sent(GIF))).hash, sha(GIF));
});
