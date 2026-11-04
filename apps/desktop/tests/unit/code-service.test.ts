/**
 * A view's `code` calls (protocol 1.19) reach the host methods the Code tile asks, in the folder of
 * the frame the view named (null: the workspace's), and a frame with no folder is told so.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const asked: unknown[] = [];
(globalThis as unknown as { window: unknown }).window = {
  hive: {
    codeFindFiles: (repo: string, query: string, limit: number) => { asked.push(["findFiles", repo, query, limit]); return Promise.resolve({ files: [], engine: "fff" }); },
    codeGrep: (repo: string, query: string, opts: unknown) => { asked.push(["grep", repo, query, opts]); return Promise.resolve({ lines: [], next: null, files: 0, engine: "fff" }); },
    codePicked: (repo: string, query: string, file: string) => { asked.push(["picked", repo, query, file]); return Promise.resolve(); },
  },
};

const { codeService } = await import("../../src/renderer/src/workspace/code-service");

const FOLDERS: Record<string, string> = { f1: "/work/shop-wt" };
const opened: unknown[] = [];
const code = codeService(
  (frameId) => (frameId === null ? "/work/shop" : FOLDERS[frameId] ?? null),
  async (frameId, path, at) => { opened.push([frameId, path, at]); return "ed1"; },
);

test("each call runs in the named frame's folder, the workspace's for null, with the view's options and no others", async () => {
  await code({ call: "findFiles", frameId: null, query: "cart" });
  await code({ call: "findFiles", frameId: "f1", query: "cart", limit: 7 });
  await code({ call: "grep", frameId: "f1", query: "TAX", mode: "regex", cursor: 3 });
  assert.equal(await code({ call: "picked", frameId: null, query: "cart", file: "src/cart.ts" }), null);
  assert.deepEqual(asked, [
    ["findFiles", "/work/shop", "cart", 50],
    ["findFiles", "/work/shop-wt", "cart", 7],
    ["grep", "/work/shop-wt", "TAX", { mode: "regex", cursor: 3 }],
    ["picked", "/work/shop", "cart", "src/cart.ts"],
  ]);
  assert.deepEqual(await code({ call: "open", frameId: "f1", file: "src/tax.ts", line: 3, col: 13 }), { tileId: "ed1" });
  assert.deepEqual(opened, [["f1", "src/tax.ts", { line: 3, col: 13 }]]);
});

test("a frame with no folder is refused as unsupported, and nothing is asked of the host", async () => {
  const before = asked.length;
  await assert.rejects(code({ call: "grep", frameId: "nofolder", query: "x" }), (e: { code?: string }) => e.code === "UNSUPPORTED");
  assert.equal(asked.length, before);
});
