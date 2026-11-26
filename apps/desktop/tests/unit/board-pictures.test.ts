// A picture on the board keeps one object URL while it is shown (board-images.ts): the URL of a
// picture shown nowhere is let go once more than a few are, so deleted pictures and other
// workspaces' do not stay in memory.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BoardImage } from "@hivemind/workspace-doc/shapes";

const fetched: string[] = [];
Object.assign(globalThis, {
  window: { hive: { boardImage: async (_repo: string, hash: string) => { fetched.push(hash); return { type: "image/png", data: btoa(hash) }; } } },
});
const revoked = new Set<string>();
const revoke = URL.revokeObjectURL;
URL.revokeObjectURL = (url: string) => { revoked.add(url); revoke(url); };
const { holdPicture } = await import("../../src/renderer/src/board-objects/board-images.ts");

const picture = (hash: string) => ({ hash, type: "image/png", width: 10, height: 10 }) as BoardImage;
const settle = () => new Promise((r) => setTimeout(r, 10));

test("a shown picture is fetched once and its URL kept; pictures shown nowhere keep theirs only up to a bound, the longest unshown let go first", async () => {
  const shown = holdPicture("ws", picture("kept"));
  const again = holdPicture("ws", picture("kept"));
  assert.equal(await shown.url, await again.url);
  again.release();
  const gone: Array<{ url: Promise<string>; release: () => void }> = [];
  for (let i = 0; i < 40; i++) gone.push(holdPicture("ws", picture(`p${i}`)));
  const urls = await Promise.all(gone.map((g) => g.url));
  for (const g of gone) g.release();
  await settle();
  assert.ok(!revoked.has(await shown.url), "a picture still shown keeps its URL");
  assert.equal(urls.filter((u) => revoked.has(u)).length, 40 - 24, "all but the most recent unshown are let go");
  assert.ok(revoked.has(urls[0]!) && !revoked.has(urls[39]!), "the longest unshown goes first");
  fetched.length = 0;
  await holdPicture("ws", picture("p39")).url;
  await holdPicture("ws", picture("p0")).url;
  assert.deepEqual(fetched, ["p0"], "a kept one is shown again without a fetch; a let-go one is fetched again");
});
