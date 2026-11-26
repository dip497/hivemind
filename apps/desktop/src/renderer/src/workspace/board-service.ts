/**
 * Protocol 1.20's `board`: a view's board requests, answered by the workspace API's `board.*` for the
 * workspace it shows, written as the view (`view:<id>`) so its undo takes back only its own writes;
 * and what changes on that board, with the page it is in, as the view is told it. The link has checked the permission.
 */
import type { LinkServices } from "@hivemind/view-host/link";
import type {
  BoardRequest, ViewBoardChange, ViewBoardChangeAsk, ViewBoardChanged, ViewBoardDrawAsk, ViewBoardDrawn, ViewBoardEraseAsk,
  ViewBoardPicture, ViewBoardPictureAsk, ViewBoardReadAsk, ViewBoardReading,
} from "@hivemind/view-sdk/protocol";
import type { BoardAsk, BoardChangeAsk, BoardDrawAsk, BoardEraseAsk, BoardPictureAsk } from "@hivemind/workspace-api/board";
import type { Params, Result } from "@hivemind/workspace-api/methods";
import { pageOf } from "@hivemind/workspace-doc/pages";
import type { BoardObject, FrameRecord } from "@hivemind/workspace-doc/shapes";

export type BoardMethod = "board.read" | "board.picture" | "board.draw" | "board.change" | "board.erase" | "board.undo";
/** One of the workspace API's board methods, written as `writer`. */
export type AskBoard = <M extends BoardMethod>(method: M, writer: string, ...params: Params<M>) => Promise<Result<M>>;

export interface BoardServiceOptions {
  viewId: string;
  /** The workspace the view shows, or null. */
  repo: () => string | null;
  ask: AskBoard;
  frames: () => readonly FrameRecord[];
  /** Each tile's frame. */
  frameOf: () => Readonly<Record<string, string | undefined>>;
  /** These objects of `repo`'s board as they are now (null: gone), or null when they could not be read. */
  objects: (repo: string, ids: string[]) => Record<string, BoardObject | null> | null;
  /** Hear the ids of what changes on the shown workspace's board, whoever writes it, until stopped. */
  changes: (cb: (ids: readonly string[]) => void) => () => void;
}

const coded = (code: string, message: string) => Object.assign(new Error(message), { code });
/** The view hears a refusal in its own codes. */
const VIEW_CODE: Record<string, string> = { BAD_REQUEST: "BAD_REQUEST", NOT_FOUND: "BAD_REQUEST", FORBIDDEN: "DECLINED", UNSUPPORTED: "UNSUPPORTED" };

export function boardService(o: BoardServiceOptions): NonNullable<LinkServices["board"]> {
  const writer = `view:${o.viewId}`;

  const answer = async (repo: string, name: BoardRequest, ask: object): Promise<unknown> => {
    switch (name) {
      case "boardRead": {
        const { ids, drawing, limit, check, page } = ask as ViewBoardReadAsk;
        const asked: BoardAsk = { ...(ids ? { ids } : {}), ...(drawing ? { drawing } : {}), ...(limit !== undefined ? { limit } : {}), ...(check ? { check } : {}), ...(page !== undefined ? { page } : {}) };
        const read: ViewBoardReading = await o.ask("board.read", writer, repo, asked);
        return read;
      }
      case "boardPicture": {
        const { page, drawing, theme } = ask as ViewBoardPictureAsk;
        const asked: BoardPictureAsk = { ...(page !== undefined ? { page } : {}), ...(drawing ? { drawing } : {}), ...(theme ? { theme } : {}) };
        const p = await o.ask("board.picture", writer, repo, asked);
        if (!("svg" in p)) throw coded("UNSUPPORTED", "no picture could be drawn");
        const picture: ViewBoardPicture = { width: p.width, height: p.height, svg: p.svg };
        return picture;
      }
      case "boardDraw": {
        const asked: BoardDrawAsk = ask as ViewBoardDrawAsk;
        const drawn: ViewBoardDrawn = await o.ask("board.draw", writer, repo, asked);
        return drawn;
      }
      case "boardChange": {
        const asked: BoardChangeAsk = ask as ViewBoardChangeAsk;
        const changed: ViewBoardChanged = await o.ask("board.change", writer, repo, asked);
        return changed;
      }
      case "boardErase": {
        const asked: BoardEraseAsk = ask as ViewBoardEraseAsk;
        return o.ask("board.erase", writer, repo, asked);
      }
      case "boardUndo": return o.ask("board.undo", writer, repo);
    }
  };

  /** The nearest page an object is in; an arrow is where its start is. */
  const pageOfObject = (repo: string, b: BoardObject, found: Record<string, BoardObject | null>): string | null => {
    const frames = o.frames();
    if (b.kind !== "arrow") return pageOf(frames, b.frame);
    const start = b.from.id;
    const frameOf = o.frameOf();
    if (Object.hasOwn(frameOf, start)) return pageOf(frames, frameOf[start]);
    const frame = frames.find((f) => f.id === start);
    if (frame) return pageOf(frames, frame.parentFrameId);
    const end = Object.hasOwn(found, start) ? found[start] : o.objects(repo, [start])?.[start];
    return end && end.kind !== "arrow" ? pageOf(frames, end.frame) : null;
  };

  return {
    call: async (name, ask) => {
      const repo = o.repo();
      if (!repo) throw coded("UNSUPPORTED", "this view shows no workspace");
      try {
        return await answer(repo, name, ask);
      } catch (e) {
        const code = (e as { code?: unknown })?.code;
        throw typeof code === "string" && VIEW_CODE[code] ? coded(VIEW_CODE[code]!, (e as Error).message) : e;
      }
    },
    follow: (cb) => o.changes(cb),
    told: (ids): ViewBoardChange[] => {
      const repo = o.repo();
      if (!repo || ids.length === 0) return [];
      const found = o.objects(repo, [...ids]);
      if (!found) return [{ changed: [...ids], removed: [] }];
      const byPage = new Map<string | null, string[]>();
      const removed: string[] = [];
      for (const id of ids) {
        const b = found[id];
        if (!b) { removed.push(id); continue; }
        const page = pageOfObject(repo, b, found);
        const list = byPage.get(page);
        if (list) list.push(id); else byPage.set(page, [id]);
      }
      const told: ViewBoardChange[] = [...byPage].map(([page, changed]) => ({ changed, removed: [], ...(page ? { page } : {}) }));
      if (removed.length === 0) return told;
      if (told.length === 0) return [{ changed: [], removed }];
      told[0] = { ...told[0]!, removed };
      return told;
    },
  };
}
