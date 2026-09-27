import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ViewShare, checkPng, shareFileName } from "../../src/main/view-share";
import { SHARE_MAX_BYTES, SHARE_MAX_SIDE } from "@hivemind/view-sdk/protocol";

function png(width: number, height: number, extra = 0): Uint8Array {
  const b = new Uint8Array(33 + extra);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, width);
  v.setUint32(20, height);
  return b;
}

test("checkPng: signature, header, size and sides", () => {
  assert.deepEqual(checkPng(png(1200, 675)), { width: 1200, height: 675 });
  assert.match((checkPng(new TextEncoder().encode("GIF89a................")) as { problem: string }).problem, /not a PNG/);
  assert.match((checkPng(png(SHARE_MAX_SIDE + 1, 10)) as { problem: string }).problem, /px/);
  assert.match((checkPng(png(0, 10)) as { problem: string }).problem, /px/);
  assert.match((checkPng(png(10, 10, SHARE_MAX_BYTES)) as { problem: string }).problem, /bytes/);
});

test("the file name keeps only safe characters and carries the date", () => {
  const now = new Date(2026, 8, 23).getTime();
  assert.equal(shareFileName("performance-review", "Valley", now), "performance-review-2026-09-23.png");
  assert.equal(shareFileName("../../etc/passwd", "Valley", now), "etcpasswd-2026-09-23.png");
  assert.equal(shareFileName("", "Valley", now), "Valley-2026-09-23.png");
});

test("only the re-encoded image leaves; cancel and an unknown token share nothing", async () => {
  const copied: Uint8Array[] = [];
  const clean = new Uint8Array([1, 2, 3]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "share-"));
  const share = new ViewShare({
    reencode: () => ({ png: clean, width: 10, height: 10 }),
    copy: (b) => copied.push(b),
    chooseSavePath: async (name) => path.join(dir, name),
  });
  const a = share.prepare(png(10, 10, 100).buffer as ArrayBuffer);
  assert.match(a.preview, /^data:image\/png;base64,/);
  assert.equal(await share.commit(a.token, "copy", "x"), "copied");
  assert.deepEqual(copied, [clean]);
  assert.equal(await share.commit(a.token, "copy", "x"), "cancelled"); // a token is used once
  const b = share.prepare(png(10, 10).buffer as ArrayBuffer);
  assert.equal(await share.commit(b.token, "save", "card"), "saved");
  assert.deepEqual([...fs.readFileSync(fs.readdirSync(dir).map((n) => path.join(dir, n))[0]!)], [1, 2, 3]);
  const c = share.prepare(png(10, 10).buffer as ArrayBuffer);
  assert.equal(await share.commit(c.token, "cancel", "x"), "cancelled");
  assert.throws(() => share.prepare(new ArrayBuffer(4)), /PNG|bytes/);
});
