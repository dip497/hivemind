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
  "store.objectsWithIds": "view",
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
  // Mirroring a tracker's issues (a sync service at edit role, design jira-sync §5.4).
  "issue.ingest": "edit",
  "issue.workflow": "view",
  // Writing issues is editing the workspace: a service (a tool plugin's grant) and a guest who may
  // edit, each signed as itself in the issue's activity.
  "issue.create": "edit",
  "issue.update": "edit",
  "issue.setState": "edit",
  "issue.comment": "edit",
  "review.list": "view",
  // Handing a branch of one's own to the host: it lands as a branch of its own, and a Diff tile
  // shows it (M4). Nothing of the host's is changed.
  "git.handOff": "edit",
  // A tool plugin's service, of its own plugin alone (the host checks its grant's plugin): what
  // it is set to and its secrets, and the commands it answers (`plugin-services.ts`).
  "plugin.options": "view",
  "secret.get": "view",
  // The person, or a service for its own plugin's declared secrets (a sign-in it keeps).
  "secret.set": "view",
  "plugin.serve": "view",
  "plugin.answer": "view",
  // How the host looks: a guest shows its workspace that way.
  "appearance.get": "view",
  // Being there: where one's pointer is, and what one has selected.
  "presence.set": "view",
  "widget.all": "view",
  "agent.list": "view",
  "agent.since": "view",
  "widget.asset": "view",
  "widget.packages": "view",
  // Pressing a widget changes what it keeps, as editing the board does.
  "widget.press": "edit",
  // Watching terminals, and no longer watching one.
  "terminal.show": "view",
  "terminal.history": "view",
  "terminal.flow": "view",
  "terminal.ack": "view",
  "terminal.detach": "view",
  "terminal.watchActivity": "view",
  // Seeing what a sleeping agent last showed.
  "terminal.saved": "view",
  // Editing the board is the document's own sync (`doc-sync.ts`), where the host takes only what
  // the role allows: the store's writes are the owner's.
  // Typing into a terminal (with the keyboard handed over, R4) and sizing it; asking for its
  // keyboard, and handing on one held. Taking it back is the host's.
  "terminal.write": "terminals",
  "terminal.resize": "terminals",
  "terminal.fit": "terminals",
  "terminal.keyboard.ask": "terminals",
  "terminal.keyboard.give": "terminals",
  // Answering what an agent waits on (a plan, a supervised tool use, its screen), and sending one
  // a message, from wherever the person is (M5), is driving agents.
  "agent.answer": "agents",
  "agent.send": "agents",
  // Seeing what may be started there and what an agent changed; starting one, interrupting its
  // turn and closing it is driving agents (spec/agents.md).
  "agent.startable": "view",
  "agent.diff": "view",
  "agent.conversation": "view",
  "agent.tool": "view",
  "agent.approval": "view",
  "agent.transcript": "view",
  "agent.start": "agents",
  // Where one may be started: the machine's projects, the folders opened lately and those inside a
  // project, which name the person's folders, so only to whoever may start one (0.8).
  "agent.places": "agents",
  "agent.folders": "agents",
  // Opening a frame on a folder or a new worktree of the workspace, and closing one, so agents
  // can be started there (0.20).
  "frame.open": "agents",
  "frame.close": "agents",
  "agent.interrupt": "agents",
  // Naming an agent, typing keys to it and piping one's replies to another drive it; reading its
  // reply and the sessions it keeps see it; opening a tool's tile edits the board (0.23).
  "agent.rename": "agents",
  "agent.keys": "agents",
  "link.connect": "agents",
  "link.disconnect": "agents",
  "agent.read": "view",
  "agent.output": "view",
  "agent.sessions": "view",
  "tool.open": "edit",
  "agent.close": "agents",
  "agent.sleep": "agents",
  "agent.wake": "agents",
  "terminal.open": "agents",
  "terminal.close": "agents",
  // A community view on a remote screen (P8): listing them, their files, opening one on the
  // workspace and talking to it is anyone's with access; what the view may do there is what the
  // caller may (`view.open`).
  "view.list": "view",
  "view.file": "view",
  "view.open": "view",
  "view.post": "view",
  "view.screen": "view",
  "view.close": "view",
};

/** The machine's own methods (0.23): a peer's device is another machine, so they are no peer's,
 *  the person's own devices included. An agent on this machine keeps them, but joining and serving
 *  a folder: those are the person's, since a tile is kept to its own workspace. */
const MACHINE = new Set(["view.emit", "plugin.list", "plugin.commands", "plugin.open", "plugin.call", "plugin.close", "tile.focus", "tile.look", "views.rescan", "agents.rescan",
  "widgets.rescan", "tools.rescan", "settings.reload", "host.status", "host.join", "host.add"]);

/** Why a peer with `access`, or an agent here in `tile`, may not call `method`, in words that name
 *  what works instead. */
export function refusalOf(who: { access: Access; tile?: string }, method: string): string {
  if (method === "host.join") {
    return "joining a workspace is the person's, at this machine: run `hive join <link>` in a terminal of your own, not from an agent's tile or another device. Your own devices need no link: what they hold opens from Open recent → On your devices in the app";
  }
  if (method === "host.add") {
    return "serving a folder as a workspace is the person's, at this machine: run `hive host add <folder>` in a terminal of your own, not from an agent's tile or another device";
  }
  if (MACHINE.has(method) && who.tile === undefined) return `${method} is this machine's own: ask it at the machine, in its app or with \`hive\` there`;
  return `${method} is not open to your role on this workspace`;
}

/** Whether a peer with `access`, or an agent here in `tile`, may call `method`. */
export function mayCall(who: { access: Access; tile?: string }, method: string): boolean {
  if (MACHINE.has(method)) return who.tile !== undefined && method !== "host.join" && method !== "host.add";
  if (who.access === "owner") return true;
  const { access } = who;
  const least = Object.hasOwn(LEAST, method) ? LEAST[method] : undefined;
  return least !== undefined && ROLES.indexOf(access) >= ROLES.indexOf(least);
}
