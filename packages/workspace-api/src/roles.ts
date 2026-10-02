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
  // Handing a branch of one's own to the host: it lands as a branch of its own, and a Diff tile
  // shows it (M4). Nothing of the host's is changed.
  "git.handOff": "edit",
  // Being there: where one's pointer is, and what one has selected.
  "presence.set": "view",
  // Watching terminals, and no longer watching one.
  "terminal.show": "view",
  "terminal.flow": "view",
  "terminal.detach": "view",
  "terminal.watchActivity": "view",
  // Editing the board is the document's own sync (`doc-sync.ts`), where the host takes only what
  // the role allows: the store's writes are the owner's.
  // Typing into a terminal (with the keyboard handed over, R4) and sizing it; asking for its
  // keyboard, and handing on one held. Taking it back is the host's.
  "terminal.write": "terminals",
  "terminal.resize": "terminals",
  "terminal.keyboard.ask": "terminals",
  "terminal.keyboard.give": "terminals",
  // Seeing the plans agents wait on a person for; answering one, and starting and ending what
  // runs on the host, is driving agents.
  "plan.list": "view",
  "plan.decide": "agents",
  // Answering what an agent waits on the person for, and sending one a message, from wherever
  // they are (M5).
  "agent.answer": "agents",
  "agent.send": "agents",
  // Seeing what may be started there and what an agent changed; starting one, interrupting its
  // turn and closing it is driving agents (spec/agents.md).
  "agent.startable": "view",
  "agent.diff": "view",
  "agent.conversation": "view",
  "agent.start": "agents",
  "agent.interrupt": "agents",
  "agent.close": "agents",
  "terminal.open": "agents",
  "terminal.close": "agents",
  // A community view on a remote screen (P8): listing them, their files, opening one on the
  // workspace and talking to it is anyone's with access; what the view may do there is what the
  // caller may (`view.open`).
  "view.list": "view",
  "view.file": "view",
  "view.open": "view",
  "view.post": "view",
  "view.close": "view",
};

/** Whether someone with `access` may call `method`. */
export function mayCall(access: Access, method: string): boolean {
  if (access === "owner") return true;
  const least = Object.hasOwn(LEAST, method) ? LEAST[method] : undefined;
  return least !== undefined && ROLES.indexOf(access) >= ROLES.indexOf(least);
}
