import { boardEdit } from "@hivemind/workspace-doc/board-edit";
import type { BoardObject } from "@hivemind/workspace-doc/shapes";
import type { WorkspaceStore } from "../src/store.ts";

/** Make `repo`'s board `next`, as a window writes it: the edit from the board it read (`base`;
 *  null: none; not given: the board as the store holds it now). */
export function writeBoard(store: WorkspaceStore, repo: string, next: readonly unknown[], from: { writer?: string; base?: readonly unknown[] | null } = {}): void {
  const base = from.base === undefined ? store.getObjects(repo) : from.base ?? [];
  store.editObjects(repo, boardEdit(base as BoardObject[], next as BoardObject[]), { writer: from.writer });
}
