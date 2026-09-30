/**
 * What each role may ask a workspace's host, over the network (M1; design §6). A method or notice
 * named here needs at least that role; any other is the owner's alone, so a method added later
 * is closed to peers until it is named here.
 */
import { ROLES, type Access, type Role } from "@hivemind/workspace-host/access";

const LEAST: Record<string, Role> = {
  // Seeing the workspace: the board, its tiles' state, and the files and history they show.
  "store.open": "view",
  "store.core": "view",
  "store.view": "view",
  "store.objects": "view",
  "store.shown": "view",
  "status.all": "view",
  "link.list": "view",
  "git.status": "view",
  "git.listFiles": "view",
  "git.listBranches": "view",
  "git.diff": "view",
  "git.fileContents": "view",
  "worktree.list": "view",
  "file.read": "view",
  "issue.list": "view",
  "issue.read": "view",
  "review.list": "view",
  // Being there: where one's pointer is, and what one has selected.
  "presence.set": "view",
  // Watching terminals.
  "terminal.show": "view",
  "terminal.flow": "view",
  "terminal.watchActivity": "view",
  // Editing the board.
  "store.setCore": "edit",
  "store.setView": "edit",
  "store.setObjects": "edit",
  "store.undo": "edit",
  "store.redo": "edit",
  // Typing into a terminal (with the keyboard handed over, R4) and sizing it.
  "terminal.write": "terminals",
  "terminal.resize": "terminals",
  // Starting and ending what runs on the host.
  "terminal.open": "agents",
  "terminal.close": "agents",
};

/** Whether someone with `access` may call `method`. */
export function mayCall(access: Access, method: string): boolean {
  if (access === "owner") return true;
  const least = Object.hasOwn(LEAST, method) ? LEAST[method] : undefined;
  return least !== undefined && ROLES.indexOf(access) >= ROLES.indexOf(least);
}
