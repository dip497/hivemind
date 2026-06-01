/** Electron main process — owns the BrowserWindow + IPC + PtyHost + git/worktree. */
import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from "electron";
import path from "node:path";
import { promises as fsp, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  appendActivity,
  commentOnIssue,
  createIssue,
  deleteIssue as deleteIssueCore,
  findRoot,
  linkIssues,
  listIssues,
  listWorkspaces,
  readIssue,
  registerWorkspace,
  resolveRootForIssue,
  transferIssue,
  unlinkIssues,
  updateIssue,
  writeAgentContext,
  writeConfig,
  writeIssue,
  templates,
  type IssueState,
  type LinkType,
} from "@hivemind/core";
import os from "node:os";
import type { IssuePatch } from "@hivemind/core/storage";
import * as ptyHost from "./pty-host.js";
import * as ptyDaemon from "./daemon-client.js";
// tmux-style persistence is ON by default — terminal sessions live in a
// detached daemon and survive the window closing. No user-facing flag.
// `HIVEMIND_PTY_DAEMON=0` is an internal escape hatch (debugging / a hostile
// environment where spawning the daemon fails) that falls back to the legacy
// in-process PTYs (which die with the window).
const PERSIST_PTY = process.env.HIVEMIND_PTY_DAEMON !== "0";
const ptyMod = PERSIST_PTY ? ptyDaemon : ptyHost;
const { spawnPty, writePty, resizePty, killPty, detachPty } = ptyMod;
const killAllPtys = ptyMod.killAll;
import { applyShellEnvToProcess } from "./shell-env.js";
import {
  gitCommit,
  gitConflictedFile,
  gitDiff,
  gitDiscard,
  gitFileContents,
  gitListFiles,
  gitPush,
  gitStage,
  gitStatus,
  gitUnstage,
  gitWriteResolved,
  worktreeCreate,
  worktreeList,
  worktreePrune,
  worktreeRemove,
} from "./git-adapter.js";
import { unwatchAll, watchRepo } from "./fs-watcher.js";
import { registerAgentNotifications } from "./agent-notify.js";
import type {
  DiffScope,
  WorktreeCreateOpts,
} from "../shared/ipc.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;

// ── CLI launch target ─────────────────────────────────────────
// Lets `hivemind .` / `hivemind /path/to/repo` open THAT repo instead of the
// persisted last-project. Packaged: argv = [exe, ...args]; dev: [electron,
// main.js, ...args] — slice past the binary/script, skip flags + bundle paths,
// and return the first arg that resolves to an existing directory.
function resolveLaunchTarget(argv: string[], cwd: string): string | null {
  const args = argv.slice(app.isPackaged ? 1 : 2);
  for (const a of args) {
    if (!a || a.startsWith("-")) continue;
    if (/\.(js|cjs|mjs|asar|appimage)$/i.test(a)) continue;
    const resolved = path.resolve(cwd, a);
    try {
      if (statSync(resolved).isDirectory()) return resolved;
    } catch {
      /* not a path arg */
    }
  }
  return null;
}
const cliLaunchTarget = resolveLaunchTarget(process.argv, process.cwd());

// ── window-state persistence ──────────────────────────────────
// Restore size/position/maximized between launches. Lives in userData/
// window-state.json. Best-effort — corrupt/missing file just falls back to
// defaults. Debounced save on resize/move (300ms) avoids hammering disk.
interface WinState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized?: boolean;
}
const WIN_STATE_DEFAULTS: WinState = { width: 1440, height: 920 };
function winStatePath(): string {
  return path.join(app.getPath("userData"), "window-state.json");
}
async function loadWinState(): Promise<WinState> {
  try {
    const raw = await fsp.readFile(winStatePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<WinState>;
    if (
      typeof parsed.width === "number" &&
      typeof parsed.height === "number" &&
      parsed.width >= 800 &&
      parsed.height >= 600
    ) {
      return { ...WIN_STATE_DEFAULTS, ...parsed };
    }
  } catch {
    /* missing or corrupt */
  }
  return WIN_STATE_DEFAULTS;
}
function attachWinStateSaver(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null;
  const save = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (win.isDestroyed()) return;
      const bounds = win.getNormalBounds();
      const state: WinState = {
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y,
        maximized: win.isMaximized(),
      };
      void fsp
        .writeFile(winStatePath(), JSON.stringify(state), "utf8")
        .catch(() => {/* best-effort */});
    }, 300);
  };
  win.on("resize", save);
  win.on("move", save);
  win.on("maximize", save);
  win.on("unmaximize", save);
}

async function createWindow(): Promise<void> {
  // Remove the native File/Edit/View/Window/Help menu entirely (autoHideMenuBar
  // only hides it until Alt; this kills it outright). No app actions live there
  // — everything is in the in-canvas chrome + ⌘K palette.
  Menu.setApplicationMenu(null);
  const state = await loadWinState();
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    ...(typeof state.x === "number" ? { x: state.x } : {}),
    ...(typeof state.y === "number" ? { y: state.y } : {}),
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#0d0e12",
    titleBarStyle: "default",
    // Hide the native File/Edit/View/Window menu bar — it's redundant chrome
    // (no app-specific actions live there; everything is in the in-app top bar
    // + ⌘K palette) and it breaks the bespoke deep-navy frameless feel. Alt
    // still reveals it on Linux/Windows if ever needed.
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      // electron-vite emits the preload as ESM (index.mjs). Hardcoding `.js`
      // here silently breaks production because the file doesn't exist →
      // window.hive is undefined → app loads as if in browser mode.
      preload: path.join(__dirname, "../preload/index.mjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Keep compositor + RAF running when the window loses focus. Without this,
      // claude streaming into a backgrounded window stalls the xterm renderer
      // and the canvas tile freezes on refocus.
      backgroundThrottling: false,
    },
  });

  // Capture webContents up front — after `closed`, accessing
  // mainWindow.webContents throws "Object has been destroyed".
  const wc = mainWindow.webContents;

  if (state.maximized) mainWindow.maximize();
  attachWinStateSaver(mainWindow);
  mainWindow.on("ready-to-show", () => mainWindow?.show());
  // Stop the taskbar/dock attention (set by a native agent notification) the
  // moment the user looks at the window.
  mainWindow.on("focus", () => { try { mainWindow?.flashFrame(false); } catch { /* unsupported */ } });

  // xterm's Terminal captures Ctrl+K (sends ^K / VT to the PTY) via
  // preventDefault on its hidden textarea — so window-level keydown for
  // Ctrl+K (palette) and Ctrl+N (new issue) never fire when a terminal has
  // focus. before-input-event sees the key BEFORE the DOM, so we forward
  // the intent over IPC and the renderer dispatches the same CustomEvents
  // the existing handlers listen for.
  wc.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (!(input.control || input.meta)) return;
    if (input.shift || input.alt) return;
    if (wc.isDestroyed()) return;
    const k = input.key.toLowerCase();
    if (k === "k") {
      event.preventDefault();
      try { wc.send("menu:open-palette"); } catch { /* destroyed mid-call */ }
    } else if (k === "n") {
      event.preventDefault();
      try { wc.send("menu:new-issue"); } catch { /* destroyed mid-call */ }
    } else if (k === "o") {
      // VSCode parity: Ctrl+O opens a folder picker.
      event.preventDefault();
      try { wc.send("menu:open-folder"); } catch { /* destroyed mid-call */ }
    } else if (k === "r") {
      // VSCode parity: Ctrl+R opens the "recent projects" picker.
      event.preventDefault();
      try { wc.send("menu:open-recent"); } catch { /* destroyed mid-call */ }
    }
  });

  mainWindow.on("closed", () => {
    // Use the pre-captured wc — mainWindow.webContents getter throws after
    // the window is destroyed. unwatchAll just needs the reference to clean
    // up watchers keyed off it; it doesn't call methods on a dead object.
    try { unwatchAll(wc); } catch { /* watcher map already cleaned */ }
    mainWindow = null;
  });
  wc.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) {
    mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: "right" });
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

// ── IPC handlers ──────────────────────────────────────────────

/**
 * Wrap an ipcMain.handle callback so thrown errors are normalized into a
 * `[handler] message (code)` form. Electron's default invoke-error wrapping
 * loses the .code property (ENOENT/EACCES are useful in renderer) and adds
 * `Error invoking remote method 'X':` noise. We re-throw a fresh Error with
 * a stable message so renderer-side `instanceof Error` / `err.message`
 * checks work consistently.
 *
 * NOTE: this does NOT prevent unhandled rejections on the renderer — callers
 * still need `.catch()`. It only normalizes the error surface. Adding a
 * renderer-side global error toast is tracked separately (out of scope here
 * because preload + renderer are owned by other agents).
 */
function wrap<A extends unknown[], R>(
  fn: (e: Electron.IpcMainInvokeEvent, ...args: A) => Promise<R> | R,
): (e: Electron.IpcMainInvokeEvent, ...args: A) => Promise<R> {
  return async (e, ...args) => {
    try {
      return await fn(e, ...args);
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      const msg = error.message ?? String(err);
      const code = error.code ? ` (${error.code})` : "";
      throw new Error(`${msg}${code}`);
    }
  };
}

// hive-core
ipcMain.handle("resolveProject", wrap(async (e, rootHint?: string) => {
  const cwd = rootHint ?? process.cwd();
  const root = await findRoot(cwd);
  // Fallback: if there's no .hivemind/ workspace, walk up to find a .git/
  // dir. The diff + file-tree tiles only need a git repo (they call `git
  // diff`, `git ls-files`, `git show :file`) — gating them on .hivemind/
  // existing made them dead-on-arrival for any user who hadn't run
  // `hive init` yet. Issues still need a real root.
  const repoPath = root ? path.dirname(root) : await findGitRoot(cwd);
  if (repoPath) watchRepo(repoPath, e.sender);
  // Index this workspace so cross-repo move/link/open can resolve its prefix.
  if (root) await registerWorkspace(root).catch(() => {});
  return { root, cwd, repoPath };
}));

// The repo passed on the CLI (`hivemind .`), or null for a bare launch (then
// the renderer falls back to its persisted last-project).
ipcMain.handle("getLaunchTarget", () => cliLaunchTarget);

async function findGitRoot(start: string): Promise<string | null> {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const home = os.homedir();
  let dir = start;
  for (let i = 0; i < 40; i++) {
    // Stop AT (not past) the user's home dir — many users keep dotfiles in a
    // git repo at $HOME, which would otherwise be matched as a "git root".
    // Walking up from any random launch cwd would then point the fs-watcher
    // at the whole home tree, triggering EACCES on /.wine, ELOOP on symlink
    // farms (~/.rig/skills/*), and tens of thousands of unrelated paths to
    // chokidar — visible in the logs as the lag the user just reported.
    if (dir === home || dir === path.dirname(home) || dir === "/") return null;
    try {
      await fs.access(path.join(dir, ".git"));
      return dir;
    } catch { /* not here */ }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// Folder picker for "Open project". Returns the selected absolute path or
// null if the user cancelled. Renderer then invokes `resolveProject` with
// that path as the hint, which rebuilds root/repoPath for the new workspace.
ipcMain.handle("pickProjectFolder", async () => {
  // Test seam: e2e can't drive a native folder dialog, so return a fixed dir
  // when HIVEMIND_TEST_PICK_DIR is set. Gated to non-packaged builds — in a
  // shipped binary a user's `.bashrc` or hostile process must not be able to
  // silently hijack the picker by setting this env var (P0 from security review).
  if (!app.isPackaged && process.env.HIVEMIND_TEST_PICK_DIR) {
    return process.env.HIVEMIND_TEST_PICK_DIR;
  }
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Open project",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});
// Initialize a .hivemind/ workspace in `dir` (no terminal needed). Mirrors
// `hive init --prefix`. Returns the new root path. Renderer then re-resolves
// the project so the New-issue button + board light up.
ipcMain.handle(
  "initWorkspace",
  wrap(async (_e, dir: string, prefixRaw: string) => {
    const prefix = String(prefixRaw).toUpperCase();
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(prefix)) {
      throw new Error(`prefix must be UPPERCASE 2-10 chars (got: ${prefix})`);
    }
    const root = path.join(dir, ".hivemind");
    const existing = await findRoot(dir);
    if (existing === root) throw new Error(`.hivemind/ already exists at ${root}`);
    await fsp.mkdir(path.join(root, "issues"), { recursive: true });
    await writeConfig(root, { prefix, next_id: 1, agents: {} });
    await writeAgentContext(root);
    // Install the agentic stack by default — a brand-new workspace should be
    // agent-ready so "Work on this" actually works (claude gets the hive MCP +
    // hive-work skill). Idempotent.
    await installAgenticStack(dir, root);
    return { root };
  })
);

// Resolve the installed `hive` CLI for .mcp.json (claude's MCP spawns it).
async function resolveHiveCliPath(): Promise<string> {
  const candidates = [
    path.join(os.homedir(), ".local", "bin", "hive"),
    ...(process.env.PATH ?? "").split(":").filter(Boolean).map((d) => path.join(d, "hive")),
  ];
  for (const p of candidates) {
    try {
      const st = await fsp.stat(p);
      if (st.isFile()) return p;
    } catch {
      /* not here */
    }
  }
  return "hive";
}

// Idempotent installer for the agentic stack (mirrors `hive init --agentic`):
// CLAUDE.md agentic section + .mcp.json (merged) + .claude/skills/hive-work.
// Without this, a spawned claude has no hive MCP tools / skill, so working an
// issue silently does nothing — the gap the user hit.
async function installAgenticStack(dir: string, root: string): Promise<void> {
  const hiveCli = await resolveHiveCliPath();

  const claudePath = path.join(dir, "CLAUDE.md");
  const MARK = /<!--\s*hivemind:agentic:start\s*-->[\s\S]*?<!--\s*hivemind:agentic:end\s*-->\n?/;
  try {
    const existing = await fsp.readFile(claudePath, "utf8");
    const next = MARK.test(existing)
      ? existing.replace(MARK, templates.agenticClaudeAppend().trim() + "\n")
      : existing + templates.agenticClaudeAppend();
    await fsp.writeFile(claudePath, next, "utf8");
  } catch {
    await fsp.writeFile(
      claudePath,
      `# CLAUDE.md\n\n(Project rules go here.)\n${templates.agenticClaudeAppend()}`,
      "utf8",
    );
  }

  const mcpPath = path.join(dir, ".mcp.json");
  const ours = JSON.parse(templates.mcpJson(hiveCli, root)) as { mcpServers: Record<string, unknown> };
  let merged: { mcpServers?: Record<string, unknown> } = {};
  try {
    merged = JSON.parse(await fsp.readFile(mcpPath, "utf8")) as typeof merged;
  } catch {
    /* fresh */
  }
  merged.mcpServers = { ...(merged.mcpServers ?? {}), ...ours.mcpServers };
  await fsp.writeFile(mcpPath, JSON.stringify(merged, null, 2) + "\n", "utf8");

  const skillPath = path.join(dir, ".claude", "skills", "hive-work", "SKILL.md");
  try {
    await fsp.stat(skillPath);
  } catch {
    await fsp.mkdir(path.dirname(skillPath), { recursive: true });
    await fsp.writeFile(skillPath, templates.HIVE_WORK_SKILL, "utf8");
  }
}

// Ensure the agentic stack exists for an already-initialized workspace (called
// before "Work on this" + manually via the workspace switcher). dir = repo dir.
ipcMain.handle(
  "installAgentic",
  wrap(async (_e, dir: string) => {
    const root = await findRoot(dir);
    // No-op (don't throw) when the dir has no .hivemind workspace. This handler
    // is fired best-effort on bind / switch; a repo without `hive init` simply
    // has nothing to install, and throwing here surfaced a noisy main-process
    // "Error occurred in handler for 'installAgentic'" for an expected state.
    if (!root) return { ok: false, reason: "no-workspace" as const };
    await installAgenticStack(dir, root);
    return { ok: true as const };
  }),
);
ipcMain.handle("listIssues", wrap(async (_e, root: string) => listIssues(root)));
// ── cross-repo: registry + transfer + links ─────────────────────────────
ipcMain.handle("listWorkspaces", wrap(async () => listWorkspaces({ persistPrune: true })));
ipcMain.handle(
  "resolveIssueRoot",
  wrap(async (_e, id: string) => ({ root: await resolveRootForIssue(id) })),
);
ipcMain.handle(
  "moveIssue",
  wrap(async (_e, root: string, id: string, destPrefix: string, mode: "move" | "copy") =>
    transferIssue(root, id, String(destPrefix).toUpperCase(), { mode, actor: "ui" }),
  ),
);
ipcMain.handle(
  "linkIssue",
  wrap(async (_e, root: string, id: string, otherId: string, type: LinkType) =>
    linkIssues(root, id, otherId, type, "ui"),
  ),
);
ipcMain.handle(
  "unlinkIssue",
  wrap(async (_e, root: string, id: string, otherId: string) => ({
    removed: await unlinkIssues(root, id, otherId, "ui"),
  })),
);
ipcMain.handle("readIssue", wrap(async (_e, root: string, id: string) => readIssue(root, id)));
ipcMain.handle(
  "updateIssueState",
  wrap(async (_e, root: string, id: string, state: IssueState, note?: string) => {
    const issue = await readIssue(root, id);
    appendActivity(issue, "ui", `state ${issue.state} → ${state}${note ? ` · ${note}` : ""}`);
    issue.state = state;
    await writeIssue(issue);
    await writeAgentContext(root);
    return issue;
  })
);
ipcMain.handle(
  "createIssue",
  wrap(async (_e, root: string, opts: Parameters<typeof createIssue>[1]) => {
    const issue = await createIssue(root, opts);
    await writeAgentContext(root);
    return issue;
  })
);
ipcMain.handle(
  "updateIssue",
  wrap(async (_e, root: string, id: string, patch: IssuePatch) => {
    const issue = await updateIssue(root, id, patch, "ui");
    await writeAgentContext(root);
    return issue;
  })
);
ipcMain.handle(
  "commentOnIssue",
  wrap(async (_e, root: string, id: string, message: string) => {
    const issue = await commentOnIssue(root, id, message, "ui");
    await writeAgentContext(root);
    return issue;
  })
);
ipcMain.handle("deleteIssue", wrap(async (_e, root: string, id: string) => {
  await deleteIssueCore(root, id);
  await writeAgentContext(root);
}));

// git
ipcMain.handle("gitStatus", wrap((_e, repoPath: string) => gitStatus(repoPath)));
ipcMain.handle("gitListFiles", wrap((_e, repoPath: string) => gitListFiles(repoPath)));
// Each `file`/`files` IPC arg is verified to stay inside `repoPath` before
// reaching git-adapter — git-adapter joins them onto repoPath for `fs.rm`,
// `fs.writeFile`, and `git show :path`, so an unguarded `../etc/passwd` arg
// would otherwise read or clobber arbitrary disk locations (P0 from review).
ipcMain.handle("gitDiff", wrap((_e, repoPath: string, scope: DiffScope, file?: string) =>
  gitDiff(repoPath, scope, file == null ? file : assertInRepo(repoPath, file))
));
ipcMain.handle(
  "gitFileContents",
  wrap((_e, repoPath: string, file: string, rev: "HEAD" | "INDEX" | "WORKING") =>
    gitFileContents(repoPath, assertInRepo(repoPath, file), rev))
);
ipcMain.handle("gitStage", wrap((_e, repoPath: string, files: string[]) =>
  gitStage(repoPath, assertAllInRepo(repoPath, files))
));
ipcMain.handle("gitUnstage", wrap((_e, repoPath: string, files: string[]) =>
  gitUnstage(repoPath, assertAllInRepo(repoPath, files))
));
ipcMain.handle("gitDiscard", wrap((_e, repoPath: string, files: string[]) =>
  gitDiscard(repoPath, assertAllInRepo(repoPath, files))
));
ipcMain.handle("gitCommit", wrap((_e, repoPath: string, message: string, allowEmpty?: boolean) =>
  gitCommit(repoPath, message, allowEmpty)
));
ipcMain.handle("gitPush", wrap((_e, repoPath: string, setUpstream?: boolean) =>
  gitPush(repoPath, setUpstream)
));
ipcMain.handle("gitConflictedFile", wrap((_e, repoPath: string, file: string) =>
  gitConflictedFile(repoPath, assertInRepo(repoPath, file))
));
ipcMain.handle("gitWriteResolved", wrap((_e, repoPath: string, file: string, contents: string) =>
  gitWriteResolved(repoPath, assertInRepo(repoPath, file), contents)
));

// plain filesystem (editor tile) — resolve relPath against repoPath and reject
// any path that escapes the repo root (path traversal / absolute-path attack).
function resolveInRepo(repoPath: string, relPath: string): string {
  const root = path.resolve(repoPath);
  const abs = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`path escapes repo: ${relPath}`);
  }
  return abs;
}
// Variant for git CLI args: validates the path stays inside repoPath but
// returns the ORIGINAL relPath (git commands receive paths relative to the
// repo, not absolute). Throws on escape so callers fail-loud at the IPC
// boundary. Use for every file/files arg that flows from the renderer into
// a git-adapter function (which then hands them to `git` or `fs`).
function assertInRepo(repoPath: string, relPath: string): string {
  resolveInRepo(repoPath, relPath);
  return relPath;
}
function assertAllInRepo(repoPath: string, paths: readonly string[]): string[] {
  for (const p of paths) resolveInRepo(repoPath, p);
  return paths.slice();
}
ipcMain.handle("fileRead", wrap((_e, repoPath: string, relPath: string) =>
  fsp.readFile(resolveInRepo(repoPath, relPath), "utf8")
));
ipcMain.handle("fileWrite", wrap((_e, repoPath: string, relPath: string, contents: string) =>
  fsp.writeFile(resolveInRepo(repoPath, relPath), contents, "utf8")
));

// worktree
ipcMain.handle("worktreeList", wrap((_e, repoPath: string) => worktreeList(repoPath)));
ipcMain.handle("worktreeCreate", wrap((_e, repoPath: string, opts: WorktreeCreateOpts) =>
  worktreeCreate(repoPath, opts)
));
ipcMain.handle("worktreeRemove", wrap((_e, repoPath: string, wtPath: string, force?: boolean) =>
  worktreeRemove(repoPath, wtPath, force)
));
ipcMain.handle("worktreePrune", wrap((_e, repoPath: string) => worktreePrune(repoPath)));

// PTY
ipcMain.handle("ptySpawn", wrap(async (e, opts: Parameters<typeof spawnPty>[0]) => {
  // Ensure the user's PATH/tokens are patched into process.env BEFORE the PTY
  // (or, in daemon mode, the daemon process that inherits this env) spawns —
  // otherwise `claude`/`gh`/nvm-node may not resolve. Idempotent + cached.
  await applyShellEnvToProcess();
  const sender = e.sender;
  // Guard against `Object has been destroyed` — a PTY can outlive the
  // renderer (window closed mid-session) and emit data/exit after the
  // sender is gone. Silently drop those instead of crashing main.
  const safeSend = (channel: string, payload: unknown) => {
    if (sender.isDestroyed()) return;
    try {
      sender.send(channel, payload);
    } catch {
      /* race — sender destroyed between check and send */
    }
  };
  return spawnPty(opts, {
    onData: (data) => safeSend(`pty:data:${opts.tileId}`, data),
    onExit: (code, signal) => safeSend(`pty:exit:${opts.tileId}`, { code, signal }),
  });
}));
ipcMain.on("ptyWrite", (_e, tileId: string, data: string) => writePty(tileId, data));
ipcMain.on("ptyResize", (_e, tileId: string, cols: number, rows: number) =>
  resizePty(tileId, cols, rows)
);
ipcMain.on("ptyKill", (_e, tileId: string) => killPty(tileId));
// Detach (window closed / tile unmounted): daemon keeps the session alive;
// in-process path treats it as a kill.
ipcMain.on("ptyDetach", (_e, tileId: string) => detachPty(tileId));

// ── lifecycle ─────────────────────────────────────────────────

// Patch process.env.PATH from the user's login shell BEFORE any pty/git spawn
// happens. Fire-and-forget — pty.spawn() and child_process.spawn() pick up the
// patched env on next tick. (superset.sh pattern; we hand-rolled equivalent
// of sindresorhus/shell-env in ./shell-env.ts so we don't add a runtime dep.)
void applyShellEnvToProcess();

// Safety net for unhandled rejections from libraries we don't control
// (chokidar's internal `add` throws EACCES/ELOOP from inside async code,
// bubbling past its own error listener — GH paulmillr/chokidar#1378). Log
// quietly so the process doesn't get stalled by warning floods, but DON'T
// crash the app — these are background-watcher failures, not user-visible.
process.on("unhandledRejection", (reason) => {
  const msg = (reason as Error)?.message ?? String(reason);
  if (/EACCES|ELOOP|EPERM|ENOENT|ENOSPC/.test(msg)) return; // expected
  console.warn("[main:unhandledRejection]", msg);
});

// Single-instance lock. Without this, double-clicking the launcher (or
// systemd-restarting an already-running instance) opens a second window
// watching the same repo — duplicating chokidar watchers, doubling fs:changed
// events, and racing window-state writes. requestSingleInstanceLock() returns
// false in the second instance; we focus the existing window and quit.
// GPU process startup: speed up the renderer↔GPU handshake (Chromium issue
// 40208065). These two features are what VS Code ships in production for the
// same reason — first paint and first compositor frame are not gated on a
// synchronous GPU channel establishment. Set BEFORE app.ready.
// Source: https://github.com/microsoft/vscode/blob/main/src/main.ts
app.commandLine.appendSwitch(
  "enable-features",
  "EarlyEstablishGpuChannel,EstablishGpuChannelAsync",
);
// Many xterm WebGL terminals can coexist. Default cap is 16 in Chromium; raise
// it so a workspace with several claude/shell tiles doesn't silently fall back
// to the DOM renderer when the 16th WebGL context is requested. VS Code uses 32.
app.commandLine.appendSwitch("max-active-webgl-contexts", "32");
// NOTE: we intentionally do NOT set disable-gpu-vsync / ignore-gpu-blocklist /
// disable-frame-rate-limit / enable-zero-copy / force_high_performance_gpu /
// CanvasOopRasterization. Those are debug flags (vsync/framerate) or
// driver-bypass risks (blocklist) or no-ops (zero-copy doesn't touch xyflow
// transform compositing; CanvasOopRasterization is default-on since Chromium
// M113 / Electron 25+). VS Code, Figma, Slack, Discord ship none of them.
// backgroundThrottling: false (BrowserWindow webPreferences) is the correct
// supported lever for keeping RAF alive on unfocused windows.

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv, workingDirectory) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      // `hivemind <path>` run while a window is already open → switch it to
      // that repo instead of just refocusing the (stale) current project.
      const target = resolveLaunchTarget(argv, workingDirectory || process.cwd());
      if (target) mainWindow.webContents.send("open-project", target);
    }
  });
  app.whenReady().then(() => {
    void createWindow();
    // Native OS notifications for agents that need you — driven by the renderer's
    // agent-status bus over IPC (multi-agent, transition-deduped). Reads
    // `mainWindow` lazily; gated on window-not-focused inside the bridge.
    registerAgentNotifications(() => mainWindow);
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  });
}

// In daemon mode the normal quit hangs (~60s): this UI process owns no PTY
// children to reap, yet some platform handle keeps the loop alive. Terminal
// state is safe in the detached daemon, so we force a hard exit. BUT first flush
// Chromium storage to disk — app.exit() skips the graceful flush, which would
// otherwise lose the canvas tile-layout (localStorage). Flush, then exit a beat
// later. Closing the socket signals the daemon to detach; sessions keep running.
function forceExitAfterFlush(): void {
  try {
    killAllPtys();
  } catch {
    /* best-effort */
  }
  try {
    session.defaultSession.flushStorageData();
  } catch {
    /* best-effort */
  }
  const t = setTimeout(() => app.exit(0), 150);
  t.unref?.();
}

// Linux: quit when last window closes (no menu-bar persistence like macOS).
app.on("window-all-closed", () => {
  if (PERSIST_PTY) forceExitAfterFlush();
  else app.quit();
});

// Reap any live PTY processes before exit — otherwise bash/claude sessions
// keep running and emit data to a destroyed sender, throwing `Object has
// been destroyed`. (Daemon mode reaps nothing here — sessions persist; the
// socket teardown in killAll just unblocks exit.)
app.on("before-quit", () => {
  // Catches every quit path that doesn't go through window-all-closed
  // (app.quit / Cmd+Q / playwright's app.close). Daemon mode force-exits after
  // flushing storage; legacy mode reaps in-process PTYs and quits normally.
  if (PERSIST_PTY) {
    forceExitAfterFlush();
    return;
  }
  try {
    killAllPtys();
  } catch {
    /* best-effort */
  }
});
