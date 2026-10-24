/**
 * The part of `window.hive` the workspace API answers, made from a window's connection to it: the
 * app's preload and the dev bridge's page both give the renderer this, so the two cannot differ.
 */
import type { WorkspaceClient } from "@hivemind/workspace-api/client";
import type { Role } from "@hivemind/workspace-host/access";
import type { IssueChange } from "@hivemind/workspace-api/methods";
import type { HiveApi } from "./ipc.js";

export function hiveOverWorkspace(workspace: WorkspaceClient) {
  /** Listeners for an event that names what it is about first (a terminal, a repo), by that name:
   *  one listener on the client for each, however many tiles listen. */
  function byKey<E extends "terminal.data" | "terminal.exit" | "file.changed">(event: E) {
    type Rest = E extends "terminal.data" ? string : E extends "terminal.exit" ? { code: number; signal?: number } : { paths: string[] };
    const listeners = new Map<string, Set<(value: Rest) => void>>();
    workspace.on(event, ((key: string, value: Rest) => {
      for (const cb of listeners.get(key) ?? []) cb(value);
    }) as never);
    return {
      on: (key: string, cb: (value: Rest) => void): (() => void) => {
        let set = listeners.get(key);
        if (!set) listeners.set(key, (set = new Set()));
        set.add(cb);
        return () => {
          set!.delete(cb);
          if (set!.size === 0 && listeners.get(key) === set) listeners.delete(key);
        };
      },
    };
  }
  const terminalData = byKey("terminal.data");
  const terminalExit = byKey("terminal.exit");
  const fileChanged = byKey("file.changed");
  // An issue's change, by the `.hivemind` it is kept in: that is what a plugin's issues know.
  const issueChanged = new Map<string, Set<(change: IssueChange) => void>>();
  workspace.on("issue.changed", (_repo, change) => {
    for (const cb of issueChanged.get(change.root) ?? []) cb(change);
  });

  return {
    listIssues: (root) => workspace.call("issue.list", root),
    readIssue: (root, id) => workspace.call("issue.read", root, id),
    issueWorkflow: (root) => workspace.call("issue.workflow", root),
    updateIssueState: (root, id, state, note) => workspace.call("issue.setState", root, id, state, note),
    createIssue: (root, opts) => workspace.call("issue.create", root, opts),
    updateIssue: (root, id, patch) => workspace.call("issue.update", root, id, patch),
    commentOnIssue: (root, id, message) => workspace.call("issue.comment", root, id, message),
    deleteIssue: (root, id) => workspace.call("issue.delete", root, id),
    checkStartWork: (root, id) => workspace.call("issue.checkStart", root, id),
    startIssue: (repo, id, opts) => workspace.call("issue.start", repo, id, opts),
    moveIssue: (root, id, destPrefix, mode) => workspace.call("issue.move", root, id, destPrefix, mode),
    linkIssue: (root, id, otherId, type) => workspace.call("issue.link", root, id, otherId, type),
    unlinkIssue: (root, id, otherId) => workspace.call("issue.unlink", root, id, otherId),
    reviewList: (repo) => workspace.call("review.list", repo),
    reviewSave: (repo, comments) => workspace.call("review.save", repo, comments),
    gitStatus: (repo) => workspace.call("git.status", repo),
    gitListFiles: (repo) => workspace.call("git.listFiles", repo),
    gitListBranches: (repo) => workspace.call("git.listBranches", repo),
    gitDiff: (repo, scope, file) => workspace.call("git.diff", repo, scope, file),
    gitFileContents: (repo, file, rev) => workspace.call("git.fileContents", repo, file, rev),
    gitStage: (repo, files) => workspace.call("git.stage", repo, files),
    gitUnstage: (repo, files) => workspace.call("git.unstage", repo, files),
    gitDiscard: (repo, files) => workspace.call("git.discard", repo, files),
    gitCommit: (repo, message, allowEmpty) => workspace.call("git.commit", repo, message, allowEmpty),
    gitPush: (repo, setUpstream) => workspace.call("git.push", repo, setUpstream),
    gitPull: (repo) => workspace.call("git.pull", repo),
    gitConflictedFile: (repo, file) => workspace.call("git.conflictedFile", repo, file),
    gitWriteResolved: (repo, file, contents) => workspace.call("git.writeResolved", repo, file, contents),
    fileRead: (repo, file) => workspace.call("file.read", repo, file),
    fileWrite: (repo, file, contents) => workspace.call("file.write", repo, file, contents),
    ptyActivityWatch: (tiles) => workspace.notice("terminal.watchActivity", tiles),
    onPtyActivity: (cb) => workspace.on("terminal.activity", cb),
    worktreeList: (repo) => workspace.call("worktree.list", repo),
    worktreeCreate: (repo, opts) => workspace.call("worktree.create", repo, opts),
    worktreeRemove: (repo, worktree, force) => workspace.call("worktree.remove", repo, worktree, force),
    worktreePrune: (repo) => workspace.call("worktree.prune", repo),
    ptySpawn: (opts) => workspace.call("terminal.open", opts),
    ptySaved: (tile, lines) => workspace.call("terminal.saved", tile, lines),
    ptyWrite: (tile, data, paste) => workspace.notice("terminal.write", tile, data, paste),
    ptyInterest: (tile, shown) => workspace.notice("terminal.show", tile, shown),
    ptyHistory: (tile, lines) => workspace.notice("terminal.history", tile, lines),
    ptyResize: (tile, cols, rows) => workspace.notice("terminal.resize", tile, cols, rows),
    ptyFit: (tile, cols, rows) => workspace.notice("terminal.fit", tile, cols, rows),
    ptyKill: (tile) => workspace.notice("terminal.close", tile),
    ptyDetach: (tile) => workspace.notice("terminal.detach", tile),
    ptyFlow: (tile, paused) => workspace.notice("terminal.flow", tile, paused),
    keyboardAsk: (tile) => workspace.notice("terminal.keyboard.ask", tile),
    keyboardGive: (tile, to) => workspace.notice("terminal.keyboard.give", tile, to),
    keyboardTake: (tile) => workspace.notice("terminal.keyboard.take", tile),
    onKeyboard: (cb) => workspace.on("terminal.keyboard", cb),
    onKeyboardAsked: (cb) => workspace.on("terminal.keyboard.asked", cb),
    onTerminalSize: (cb) => workspace.on("terminal.size", cb),
    onTyping: (cb) => workspace.on("terminal.typing", cb),
    share: (repo, role, expiresIn, reusable) => workspace.call("people.invite", repo, role, expiresIn, reusable),
    onJoinRequest: (cb) => workspace.on("people.asked", (repo, question) => cb({ repo, ...question })),
    onJoinAnswered: (cb) => workspace.on("people.answered", cb),
    answerJoin: (repo, req, allow) => void workspace.call("people.answer", repo, req, allow).catch(() => { /* the host went: it declines */ }),
    people: (repo) => workspace.call("people.list", repo),
    setRole: (repo, person, role) => workspace.call("people.role", repo, person, role as Role),
    removePerson: (repo, person) => workspace.call("people.remove", repo, person),
    grants: () => workspace.call("grant.list"),
    grantCreate: (grant) => workspace.call("grant.create", grant),
    grantRevoke: (id) => workspace.call("grant.revoke", id),
    onWorkspaceChanged: (cb) => workspace.on("store.changed", cb),
    workspaceShown: (repo, frame) => workspace.notice("store.shown", repo, frame),
    boardPresenceSet: (repo, state) => workspace.notice("presence.set", repo, state),
    onBoardPresence: (cb) => workspace.on("presence.changed", cb),
    widgetDraw: (repo, id, tree) => workspace.notice("widget.draw", repo, id, tree),
    widgetsDrawn: (repo) => workspace.call("widget.all", repo),
    onWidgetDrawn: (cb) => workspace.on("widget.drawn", cb),
    widgetPress: (repo, id, press) => workspace.notice("widget.press", repo, id, press),
    onWidgetPressed: (cb) => workspace.on("widget.pressed", cb),
    widgetRun: (repo) => workspace.call("widget.run", repo),
    widgetPackagesOf: (repo) => workspace.call("widget.packages", repo),
    widgetRelease: (repo) => workspace.notice("widget.release", repo),
    onWidgetRunner: (cb) => workspace.on("widget.runner", cb),
    viewOpen: (id, repo, screen) => workspace.call("view.open", id, repo, screen, true),
    viewPost: (session, message, repo) => workspace.notice("view.post", session, message, repo),
    viewScreen: (session, screen, repo) => workspace.notice("view.screen", session, screen, repo),
    viewClose: (session, repo) => workspace.call("view.close", session, repo),
    onViewSaid: (cb) => workspace.on("view.said", cb),
    onViewRects: (cb) => workspace.on("view.rects", cb),
    onViewEnded: (cb) => workspace.on("view.ended", cb),
    widgetAsset: (repo, widget, name) => workspace.call("widget.asset", repo, widget, name),
    agentList: (repo) => workspace.call("agent.list", repo),
    agentSince: (repo, seq) => workspace.call("agent.since", repo, seq),
    agentAnswer: (tile, since, answer) => workspace.call("agent.answer", tile, since, answer),
    agentSleep: (repo, target, force) => workspace.call("agent.sleep", repo, target, force),
    agentWake: (repo, target) => workspace.call("agent.wake", repo, target),
    // View protocol 1.4: a folder's past sessions, without what the agent wrote; a prompt the user
    // confirmed, held while the agent is mid-turn.
    viewSessions: async (agent, cwd) => (await workspace.call("agent.sessions", cwd, agent, 100)).sessions
      .map((s) => ({ id: s.id, ...(s.updated ? { updated: s.updated } : {}), ...(s.prompt ? { prompt: s.prompt } : {}) })),
    viewPrompt: async (tile, text) => {
      if (!(await workspace.call("agent.send", tile, text)).sent) throw new Error(`no agent runs in tile ${tile}`);
    },
    // The workspaces on this machine, as the drive socket serves them.
    hostWorkspaces: async () => (await workspace.call("host.status")).workspaces.map((w) => w.repo),
    onAgentChanged: (cb) => workspace.on("agent.changed", cb),
    onAgentEvent: (cb) => workspace.on("agent.event", cb),
    onHcpSpawn: (cb) => workspace.on("link.spawn", cb),
    onHcpSpawned: (cb) => workspace.on("tile.opened", cb),
    onHcpPipe: (cb) => workspace.on("link.pipe", cb),
    hcpStatusAll: () => workspace.call("status.all"),
    hcpLinks: () => workspace.call("link.list"),
    onHcpStatus: (cb) => workspace.on("status.changed", cb),
    onPtyData: terminalData.on,
    onPtyExit: terminalExit.on,
    onFsChanged: fileChanged.on,
    onIssueChanged: (root, cb) => {
      let set = issueChanged.get(root);
      if (!set) issueChanged.set(root, (set = new Set()));
      set.add(cb);
      return () => {
        set!.delete(cb);
        if (set!.size === 0 && issueChanged.get(root) === set) issueChanged.delete(root);
      };
    },
  } satisfies Partial<HiveApi>;
}
