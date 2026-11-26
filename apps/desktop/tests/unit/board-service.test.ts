/**
 * A view's board requests (protocol 1.20) reach the workspace API's board methods for the workspace
 * it shows, written as the view itself; and what changed is told by page, an arrow on its start's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { boardService, type AskBoard } from "../../src/renderer/src/workspace/board-service";
import type { BoardObject, FrameRecord } from "@hivemind/workspace-doc/shapes";

const shape = (id: string, frame?: string): BoardObject => ({ kind: "shape", id, form: "rect", x: 0, y: 0, w: 10, h: 10, ...(frame ? { frame } : {}) });
const arrow = (id: string, from: string): BoardObject => ({ kind: "arrow", id, from: { id: from, side: "right" }, to: { id: "s1", side: "left" }, label: "" });
const FRAMES: FrameRecord[] = [
  { id: "pay", title: "Payments", page: true } as FrameRecord,
  { id: "box", title: "Inside", parentFrameId: "pay" } as FrameRecord,
];
const BOARD: Record<string, BoardObject> = {
  s1: shape("s1"), s2: shape("s2", "box"), s3: shape("s3", "pay"),
  a1: arrow("a1", "s2"), a2: arrow("a2", "t1"), a3: arrow("a3", "far"), far: shape("far", "box"),
};

function service(repo: string | null = "/work/shop", answer: (method: string) => unknown = () => ({})) {
  const asked: unknown[][] = [];
  const reads: string[][] = [];
  const ask = (async (method: string, ...rest: unknown[]) => { asked.push([method, ...rest]); return answer(method); }) as AskBoard;
  const board = boardService({
    viewId: "@ada/map", repo: () => repo, ask,
    frames: () => FRAMES, frameOf: () => ({ t1: "pay" }),
    objects: (_repo, ids) => { reads.push(ids); return Object.fromEntries(ids.map((id) => [id, BOARD[id] ?? null])); },
    changes: () => () => {},
  });
  return { board, asked, reads };
}

test("each request is asked of the shown workspace as the view's own writer, with only the fields that method takes", async () => {
  const { board, asked } = service("/work/shop", (m) => (m === "board.picture" ? { width: 2, height: 3, svg: "<svg/>" } : { undone: true }));
  await board.call("boardRead", { page: "pay", ids: ["s1"], stray: 1 } as object);
  assert.deepEqual(await board.call("boardPicture", { page: null, png: true } as object), { width: 2, height: 3, svg: "<svg/>" });
  await board.call("boardDraw", { boxes: [{ id: "a", text: "Cart" }], page: "pay" });
  await board.call("boardUndo", {});
  assert.deepEqual(asked, [
    ["board.read", "view:@ada/map", "/work/shop", { ids: ["s1"], page: "pay" }],
    ["board.picture", "view:@ada/map", "/work/shop", { page: null }],
    ["board.draw", "view:@ada/map", "/work/shop", { boxes: [{ id: "a", text: "Cart" }], page: "pay" }],
    ["board.undo", "view:@ada/map", "/work/shop"],
  ]);
});

test("a refusal is said in the view's codes, and a view with no workspace is told so before anything is asked", async () => {
  const { board } = service("/work/shop", () => { throw Object.assign(new Error("no page p9 on this board"), { code: "NOT_FOUND" }); });
  await assert.rejects(board.call("boardRead", { page: "p9" }), (e: { code?: string; message: string }) => e.code === "BAD_REQUEST" && e.message.includes("p9"));
  const none = service(null);
  await assert.rejects(none.board.call("boardDraw", { shapes: [] }), (e: { code?: string }) => e.code === "UNSUPPORTED");
  assert.deepEqual(none.asked, []);
});

test("changed ids are told by the page they are on, an arrow on its start's page, and gone ones as removed", () => {
  const { board, reads } = service();
  assert.deepEqual(board.told(["s1", "s2", "s3", "a1", "a2", "a3", "gone"]), [
    { changed: ["s1"], removed: ["gone"] },
    { changed: ["s2", "s3", "a1", "a2", "a3"], removed: [], page: "pay" },
  ]);
  // The changed ids are read once together; only an arrow's start not among them is read on its own.
  assert.deepEqual(reads, [["s1", "s2", "s3", "a1", "a2", "a3", "gone"], ["far"]]);
  assert.deepEqual(board.told(["gone"]), [{ changed: [], removed: ["gone"] }]);
});
