/**
 * Protocol 1.19's `code`: a view's search and open in a frame's folder, through the same host
 * methods the Code tile asks (fff, else git). The link has checked the permission and the frame.
 */
import type { LinkServices } from "@hivemind/view-host/link";

const coded = (code: "UNSUPPORTED", message: string) => Object.assign(new Error(message), { code });
export function codeService(
  frameRepo: (frameId: string | null) => string | null,
  openFile: (frameId: string | null, path: string, at?: { line?: number; col?: number }) => Promise<string | null>,
): NonNullable<LinkServices["code"]> {
  return async (c) => {
    const repo = frameRepo(c.frameId);
    if (!repo) throw coded("UNSUPPORTED", "this frame has no folder");
    switch (c.call) {
      case "findFiles": return window.hive.codeFindFiles(repo, c.query, c.limit ?? 50);
      case "grep": return window.hive.codeGrep(repo, c.query, { ...(c.mode ? { mode: c.mode } : {}), ...(c.cursor !== undefined ? { cursor: c.cursor } : {}), ...(c.caseSensitive !== undefined ? { caseSensitive: c.caseSensitive } : {}) });
      case "picked": await window.hive.codePicked(repo, c.query, c.file); return null;
      case "open": return { tileId: await openFile(c.frameId, c.file, { ...(c.line !== undefined ? { line: c.line } : {}), ...(c.col !== undefined ? { col: c.col } : {}) }) };
    }
  };
}
