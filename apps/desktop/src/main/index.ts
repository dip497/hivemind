import { installViewManagementIpc } from "./view-packages.js";
import { appShortcut, menuKey } from "./shortcuts";
import { recoverOnProcessLoss } from "./recover";
import desktopPkg from "../../package.json" with { type: "json" };
import { installPluginCatalogIpc } from "./plugin-catalog-ipc.js";
/** Electron main process — owns the BrowserWindow + IPC + PtyHost + git/worktree. */
import { app, BrowserWindow, clipboard, dialog, Menu, nativeImage, net, powerMonitor, protocol, screen, session, shell, webContents, type WebContents } from "electron";
import { isDay, promptProblem } from "@hivemind/view-sdk/protocol";
import { ActivityMeter } from "./pty-activity.js";
import { POLL_MS as PRESENCE_POLL_MS, PresenceMonitor, localDay, type PresenceTotals } from "./presence.js";
import { StatusLedger } from "./status-ledger.js";
import { ViewShare } from "./view-share.js";
import path from "node:path";
import { promises as fsp, statSync, readFileSync, writeFileSync, existsSync, cpSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  findRoot,
  listWorkspaces,
  registerWorkspace,
  resolveRootForIssue,
  writeAgentContext,
  writeConfig,
  WORKSPACE_FORMAT,
  installAgenticStack as coreInstallAgenticStack,
} from "@hivemind/core";
import os from "node:os";
import { agentById, agentForCmd, getCatalog, preferredAgent, setCatalog, type AgentProviderDef } from "@hivemind/agents";
import { agentPresence, discoverOptions, findBin, verifyAgent } from "@hivemind/agents/discover";
import { listSessions } from "@hivemind/agents/node";
import { agentAllowedIn, loadAgents, toWire } from "@hivemind/agents/load";
import * as ptyHost from "./pty-host.js";
import * as ptyDaemon from "./daemon-client.js";
import { isRemote, parseDeviceUri } from "@hivemind/core/remote-uri";
import { savedAuth } from "./remote/saved-hosts.js";
import { addMachine, checkMachine, deviceStatus, editMachine, initMachines, installOnMachine, machineSessions, reconnectMachineHost, removeMachine, setMachinePassword, snapshot as machinesSnapshot, updateMachine } from "./remote/machines.js";
import { deviceSessions } from "@hivemind/host/device-sessions";
import { remoteTarget } from "@hivemind/host/remote/targets";
import {
  spawnRemotePty, writeRemotePty, resizeRemotePty, killRemotePty, hasRemotePty, screenRemotePty, remoteKeepsScreen,
  pauseRemotePty, resumeRemotePty, detachRemotePty, setRemoteEventSink,
} from "./remote/pty.js";
import { remoteConns } from "@hivemind/host/remote/conn";
import { findGitRoot, computeRepoPath, projectDir } from "./workspace-paths.js";
// tmux-style persistence is ON by default — terminal sessions live in a
// detached daemon and survive the window closing. No user-facing flag.
// `HIVEMIND_PTY_DAEMON=0` is an internal escape hatch (debugging / a hostile
// environment where spawning the daemon fails) that falls back to the legacy
// in-process PTYs (which die with the window).
const PERSIST_PTY = process.env.HIVEMIND_PTY_DAEMON !== "0";
const ptyMod = PERSIST_PTY ? ptyDaemon : ptyHost;
const { spawnPty, writePty, resizePty, killPty, detachPty, hasSession, pausePty, resumePty } = ptyMod;
const killAllPtys = ptyMod.killAll;
import { applyShellEnvToProcess } from "@hivemind/agent-host/shell-env";
import { watchRepo } from "./fs-watcher.js";
import { registerAgentNotifications } from "./agent-notify.js";
import { getNotificationSettings, setNotificationSettings } from "./notification-settings-store.js";
import { normalizeNotificationSettings } from "../shared/notification-settings.js";
import { tagFromReleasesLatest } from "../shared/update-progress.js";
import type { AppErrorEvent, MachineAddRequest } from "../shared/ipc.js";
import { startPlanBridge, type PlanRequest } from "./plan-bridge.js";
import { randomUUID } from "node:crypto";
import { makeSpawnPacer } from "@hivemind/host/spawn-pacer";
import { PERSON, handle, handleEffect, on, performed } from "./app-ipc.js";
import { hostIntents } from "./audit.js";
import { ControlPlane } from "@hivemind/host/control/plane";
import { REATTACH_RESET } from "@hivemind/agent-host/daemon-endpoint";
import type { ReadScreen } from "@hivemind/agent-host/session-relay";
import { ipcPath, upgradeCommand, windowsStartMenuShortcut } from "./platform.js";
import { hcpSockPath } from "@hivemind/agent-host/hooks/token";
import { HcpError } from "@hivemind/host/control/protocol";
import { handleViewProtocol, listViewPackages, registerViewScheme, startViewWatchdog } from "./view-packages.js";
import { installSettingsIpc, reloadSettings, getSettings as getAppSettings, settingsFile, settingsBusy, settingsSettled } from "./settings-store.js";
import { flushWorkspaceStore, installWorkspaceStoreIpc, storeFor, workspaceStore } from "./workspace-store-ipc.js";
import { installIdentityIpc, machineIdentity } from "./identity.js";
import { defaultShellFor } from "@hivemind/agent-host/shell-spec";
import { dialDevice, installNetworkIpc, isYourDevice, movedAway, openJoined, peopleHere, personName, shownFrom, stopNetwork, terminalMachine } from "./network.js";
import { elsewhere, mayWriteShared, onceStarted, placedRun, refusedShared, startedByOthers, wroteShared } from "./shared-workspaces.js";
import { appWindowOf, broadcast, openWindows, registerWindow, userWindow } from "./windows.js";
import { patchSettingsExtras } from "@hivemind/core/settings";
import { toBareId, toPtyId } from "@hivemind/workspace-api/tile-id";
import { INITIAL_PROMPT_ENV } from "@hivemind/agent-host/initial-prompt";
import { WorkspaceServer, named, type Connection } from "@hivemind/workspace-api/server";
import { workspaceDomains } from "@hivemind/host/domains";
import { agents } from "@hivemind/host/agents";
import { Terminals, type SessionOutput } from "@hivemind/host/terminals";
import { Layouts, type Shown } from "@hivemind/host/store";
import { presence } from "@hivemind/host/presence";
import { Plans } from "@hivemind/host/plans";
import type { TerminalOpts } from "@hivemind/workspace-api/terminals";
import { serveWorkspaceApi } from "./workspace-ipc.js";
import { fileIn } from "@hivemind/host/repo-paths";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Set the app name EARLY (before the window is created) so Electron tags the
// X11 WM_CLASS as "hivemind" instead of the default "electron". Without this a
// source/dev run shows the generic Electron icon in the GNOME dock because no
// .desktop StartupWMClass matches "electron". (Packaged AppImage already gets
// this from electron-builder's executableName, but setting it is harmless there.)
app.setName("hivemind");
// Dev runs on a SEPARATE profile (~/.config/hivemind-dev) so `pnpm start`/`pnpm
// dev` never touch the installed AppImage's canvas, and both can run at once.
if (!app.isPackaged) app.setName("hivemind-dev");

// Windows drops every toast from an app whose AUMID doesn't match a Start Menu shortcut
// carrying the same id, so claim it before anything can notify. Inlined at build time:
// electron-builder strips `build` from the package.json it packages.
const windowsAppId: string = desktopPkg.build.appId;
if (process.platform === "win32") app.setAppUserModelId(windowsAppId);

// Rewrite the Start Menu shortcut with our AUMID: install.ps1 can only write an
// AUMID-less fallback (its COM API cannot set one), and without the id Windows drops
// toasts. Same file install.ps1 used, so there is exactly one shortcut; runs once at
// ready, packaged only, best-effort — a locked or missing Start Menu must never block
// the app.
function refreshWindowsStartMenuShortcut(): void {
  if (process.platform !== "win32" || !app.isPackaged || !windowsAppId) return;
  const lnk = windowsStartMenuShortcut();
  if (!lnk) return;
  try {
    shell.writeShortcutLink(lnk.file, existsSync(lnk.file) ? "replace" : "create", {
      target: process.execPath,
      cwd: path.dirname(process.execPath),
      appUserModelId: windowsAppId,
      description: "Hivemind",
    });
  } catch (e) {
    console.warn("hivemind: could not refresh the Start Menu shortcut:", (e as Error).message);
  }
}

/** The project each window opens on: the one `hivemind <path>` named for the first, the one the
 *  window that asked shows for a new one. */
const launchTargets = new WeakMap<WebContents, string | null>();

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
// First run opens MAXIMIZED. An infinite canvas is the whole point of the app, and
// 1440×920 floating on a large display shows a keyhole of it. The width/height are
// still the un-maximised size, so the first ⌘/double-click restore lands somewhere
// sane — and once the user resizes, `save()` persists whatever they chose (including
// `maximized: false`), so this default never fights them again.
const WIN_STATE_DEFAULTS: WinState = { width: 1440, height: 920, maximized: true };
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

async function createWindow(target: string | null = cliLaunchTarget): Promise<void> {
  // Remove the native File/Edit/View/Window/Help menu entirely (autoHideMenuBar
  // only hides it until Alt; this kills it outright). No app actions live there
  // — everything is in the in-canvas chrome + ⌘K palette.
  Menu.setApplicationMenu(null);
  // Export the browser-targets discovery path so spawned PTY agents inherit it
  // (set here — post-ready — because userData is only reliable now). Harmless
  // when the CDP enabler is off; the file just lists tiles with no endpoint.
  process.env.HIVEMIND_BROWSER_TARGETS = path.join(app.getPath("userData"), "browser-targets.json");
  const state = await loadWinState();
  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    ...(typeof state.x === "number" ? { x: state.x } : {}),
    ...(typeof state.y === "number" ? { y: state.y } : {}),
    minWidth: 720,
    minHeight: 560,
    backgroundColor: "#0d0e12",
    // Window / taskbar icon (Linux). The AppImage's desktop icon comes from
    // electron-builder's linux.icon; this sets the live window icon too.
    icon: path.join(__dirname, "../renderer/icon.png"),
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
      // BrowserTile renders web content in a <webview> — the only embed
      // primitive that lives IN the DOM (so it pans/zooms/clips with the
      // react-flow canvas transform) AND carries its own webContents (so an
      // agent can attach CDP via webContents.debugger and drive it). Each
      // guest is its own out-of-process Chromium renderer.
      webviewTag: true,
      // Keep compositor + RAF running when the window loses focus. Without this,
      // claude streaming into a backgrounded window stalls the xterm renderer
      // and the canvas tile freezes on refocus.
      backgroundThrottling: false,
    },
  });

  // Capture webContents up front — after `closed`, accessing
  // win.webContents throws "Object has been destroyed".
  const wc = win.webContents;
  registerWindow(win);
  workspaceIpc.connect(win.webContents);
  launchTargets.set(wc, target);

  attachWinStateSaver(win);
  // Maximize AFTER the window is mapped, not before. The window is created with
  // `show: false`, and a maximize request against an unmapped window is silently
  // dropped by several Linux WMs (mutter among them) — the app then opened at the
  // 1440×920 fallback no matter what the saved state said.
  win.on("ready-to-show", () => win.show());
  // Maximize once the window is actually MAPPED. The window is created with
  // `show: false`, and a maximize request against an unmapped X11 window is
  // silently dropped by mutter — issuing it in `ready-to-show`, before or after
  // show(), left the app at the 1440×920 fallback regardless of saved state
  // (window-state.json would then persist `maximized: false`, making it sticky).
  // `once("show")` + a macrotask lets the WM map the frame first.
  win.once("show", () => {
    if (!state.maximized) return;
    // A bare maximize() here is a no-op under mutter: the request races the WM
    // mapping the frame and is dropped (verified — `isMaximized()` stays false and
    // the window keeps its 1440x920 fallback, which then persists as
    // `maximized: false`). Snap to the display's work area first so the geometry is
    // right regardless, then ask the WM to own it as a real maximized window.
    setTimeout(() => {
      if (win.isDestroyed()) return;
      const { workArea } = screen.getDisplayMatching(win.getBounds());
      win.setBounds(workArea);
      win.maximize();
    }, 120);
  });
  // Stop the taskbar/dock attention (set by a native agent notification) the
  // moment the user looks at the window.
  win.on("focus", () => { try { win.flashFrame(false); } catch { /* unsupported */ } });

  // xterm's Terminal captures Ctrl+K (sends ^K / VT to the PTY) via
  // preventDefault on its hidden textarea — so window-level keydown for
  // Ctrl+K (palette) and Ctrl+N (new issue) never fire when a terminal has
  // focus. before-input-event sees the key BEFORE the DOM, so we forward
  // the intent over IPC and the renderer dispatches the same CustomEvents
  // the existing handlers listen for.
  wc.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (wc.isDestroyed()) return;
    // F11 → native fullscreen. Hides the OS titlebar (and the desktop top bar on
    // GNOME) so the canvas + wallpaper go edge-to-edge. Pair with the eye/zen
    // toggle to also hide the in-app chrome for a pure-wallpaper view.
    if (input.key === "F11" && !input.control && !input.meta && !input.shift && !input.alt) {
      event.preventDefault();
      try { win.setFullScreen(!win.isFullScreen()); } catch { /* window gone */ }
      return;
    }
    if (!(input.control || input.meta)) return;
    if (input.alt) return;
    const k = input.key.toLowerCase();
    // VS Code's app keys (see shortcuts.ts) — intercepted here, before xterm, so they work
    // from inside a terminal too.
    const action = appShortcut(input);
    if (action) {
      event.preventDefault();
      try { wc.send("menu:shortcut", action); } catch { /* destroyed mid-call */ }
      return;
    }
    // Tile scaling shortcuts forwarded to the renderer (xterm eats the keys when a
    // terminal is focused, so they must be intercepted here, like ⌘N/⌘L).
    // Ctrl/Cmd+Shift+F = toggle the crisp fit-to-screen overlay on the selected
    // tile; Ctrl/Cmd+Shift+0 = reset that tile's scale to the screen's best.
    if (input.shift) {
      if (k === "f") {
        event.preventDefault();
        try { wc.send("menu:fit-overlay"); } catch { /* destroyed mid-call */ }
      } else if (k === "0" || k === ")") {
        event.preventDefault();
        try { wc.send("menu:reset-scale"); } catch { /* destroyed mid-call */ }
      }
      return;
    }
    // Ctrl/Cmd+. focuses the selected tile. The plain `.` binding fails when a
    // terminal is focused (xterm consumes it), so the modifier combo is forwarded
    // from here instead. NEVER bind plain `.` (it's load-bearing terminal input).
    if (k === ".") {
      event.preventDefault();
      try { wc.send("menu:focus-tile"); } catch { /* destroyed mid-call */ }
      return;
    }
    const menu = menuKey(input);
    if (menu) {
      event.preventDefault();
      try { wc.send(`menu:${menu}`); } catch { /* destroyed mid-call */ }
    }
  });

  const stopViewWatchdog = startViewWatchdog(win);
  const stopRecover = recoverOnProcessLoss(win);
  // The repos it watches stop being watched for it as its connection closes (fs-watcher.ts).
  win.on("closed", () => {
    stopViewWatchdog();
    stopRecover();
  });
  wc.setWindowOpenHandler(({ url }) => {
    // Only web links reach the OS: plugin manifests supply some of these URLs.
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  // Harden every BrowserTile <webview> guest as it attaches. The guest is a
  // full Chromium renderer loading arbitrary web pages, so: (1) strip any
  // preload/nodeIntegration a page tries to negotiate, and (2) route window.open
  // / target=_blank to the OS browser instead of spawning rogue child windows on
  // the canvas. The page still renders + is fully agent-drivable over CDP.
  wc.on("will-attach-webview", (_e, webPreferences) => {
    // Defense in depth: never let an embedded page run with node access or a
    // preload, regardless of what attributes the <webview> element carries.
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
  });
  wc.on("did-attach-webview", (_e, guest) => {
    // One of this window's browser pages: the only kind a browser tile may register.
    const pages = browserPages.get(wc) ?? new Set<number>();
    browserPages.set(wc, pages);
    const pageId = guest.id;
    pages.add(pageId);
    guest.once("destroyed", () => { pages.delete(pageId); forgetBrowserPage(pageId); });
    guest.setWindowOpenHandler(({ url }) => {
      // A link/popup (target=_blank, window.open) inside a BrowserTile guest →
      // hand it back to the host renderer so the owning tile opens it as a NEW
      // TAB (canvas-native tabs), instead of spawning a rogue OS window.
      if (!wc.isDestroyed()) wc.send("browser:popup", { fromId: guest.id, url });
      return { action: "deny" };
    });
  });

  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) {
    win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: "right" });
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
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
handle("resolveProject", wrap(async (e, rootHint?: string) => {
  // A workspace shared with this person from elsewhere (M1): its host is dialled, and the window
  // shows its replica. It has no issues or folder here.
  if (typeof rootHint === "string" && rootHint.startsWith("hive://")) {
    await openJoined(rootHint.slice("hive://".length), (event) => workspaceServer.relay(event));
    return { root: null, cwd: rootHint, repoPath: rootHint };
  }
  const cwd = await projectDir(rootHint, process.cwd());
  const root = await findRoot(cwd);
  // The repo a frame's tiles run in. THREE cases, in priority order:
  //
  //  1. The picked dir (or an ancestor of it, up to $HOME) is itself a git
  //     repo → that git root IS the workspace repo. This is the common case
  //     AND the one that makes nested repos work: `.hivemind` may live in a
  //     PARENT folder (a monorepo / umbrella workspace that groups many
  //     sibling repos), yet the user picked a specific child repo. We must
  //     bind to the child they picked — not collapse up to `dirname(root)`,
  //     which would silently rebind the frame to the umbrella folder and lose
  //     the repo entirely (the "selecting a repo doesn't open it" bug).
  //  2. No git repo, but a `.hivemind/` exists → fall back to that workspace's
  //     directory (dirname(root)) so issues + tiles still resolve.
  //  3. Neither → null (empty playground).
  //
  // Issues stay keyed by `root` (the shared `.hivemind`, possibly the parent's)
  // — so a child repo bound this way still reads/writes the umbrella workspace's
  // issues while its terminals/editor/diff run in the child repo.
  const gitRoot = await findGitRoot(cwd);
  const repoPath = computeRepoPath(root, gitRoot);
  // Moved to another of the person's devices (M3): opened from there, as its owner.
  const moved = repoPath ? movedAway(repoPath) : null;
  if (moved) {
    await openJoined(moved.slice("hive://".length), (event) => workspaceServer.relay(event));
    return { root: null, cwd: moved, repoPath: moved };
  }
  if (repoPath) watchRepo(repoPath, workspaceIpc.connect(e.sender));
  // Index this workspace so cross-repo move/link/open can resolve its prefix.
  if (root) await registerWorkspace(root).catch(() => {});
  return { root, cwd, repoPath };
}));

// ── BrowserTile CDP bridge ────────────────────────────────────
// Each BrowserTile registers its <webview> guest's webContents id here, keyed
// by tileId. An agent (or in-app automation / `hive ctl`) then drives the VISIBLE
// tile by sending raw Chrome DevTools Protocol commands through `browserCdp` —
// Page.navigate, Input.dispatchMouseEvent (click), DOM.getDocument,
// Page.captureScreenshot, Runtime.evaluate, etc. This is the whole reason to
// use <webview> over <iframe>: the guest owns a real webContents, so
// webContents.debugger hands us full CDP for free, on the same pixels the user
// sees. The guest auto-attaches on the first command and stays attached.
interface BrowserGuest { webContentsId: number; frameId: string | null; url: string }
const browserGuests = new Map<string, BrowserGuest>();
/** Each app window's browser pages (its <webview> guests), by id, as they attach. */
const browserPages = new WeakMap<WebContents, Set<number>>();

// Discovery file the `hive-browser` skill reads so a spawned agent can find the
// right tab to drive: which BrowserTile lives in which frame, its current URL
// (used to match the CDP target via `agent-browser tab`), and the loopback CDP
// port. Written on every register/unregister/navigate so it never goes stale.
// Path is exported as $HIVEMIND_BROWSER_TARGETS into every PTY's environment.
function browserTargetsPath(): string {
  return path.join(app.getPath("userData"), "browser-targets.json");
}
async function writeBrowserTargets(): Promise<void> {
  const tiles = [...browserGuests.entries()].map(([tileId, g]) => ({
    tileId, frameId: g.frameId, url: g.url,
  }));
  const doc = {
    cdpEnabled: process.env.HIVEMIND_BROWSER_CDP === "1",
    cdpPort: process.env.HIVEMIND_BROWSER_CDP_PORT ?? null,
    cdpEndpoint: process.env.HIVEMIND_BROWSER_CDP === "1"
      ? `http://127.0.0.1:${process.env.HIVEMIND_BROWSER_CDP_PORT ?? "9333"}`
      : null,
    tiles,
  };
  await fsp.writeFile(browserTargetsPath(), JSON.stringify(doc, null, 2)).catch(() => {});
}

// A browser tile names the page it shows: one of its own window's browser pages, never another
// window's nor a window itself, which the debugger below would then drive.
on("browser:register", (e, tileId: unknown, webContentsId: unknown, frameId: unknown, url: unknown) => {
  if (typeof tileId !== "string" || typeof webContentsId !== "number" || !browserPages.get(e.sender)?.has(webContentsId)) return;
  browserGuests.set(tileId, { webContentsId, frameId: typeof frameId === "string" ? frameId : null, url: typeof url === "string" ? url : "" });
  void writeBrowserTargets();
});
/** A page that has gone takes its tile's registration with it (the tile closed, or its tab did). */
function forgetBrowserPage(pageId: number): void {
  let gone = false;
  for (const [tileId, g] of browserGuests) if (g.webContentsId === pageId) { browserGuests.delete(tileId); gone = true; }
  if (gone) void writeBrowserTargets();
}

function browserGuestFor(tileId: string): Electron.WebContents | null {
  const g = browserGuests.get(tileId);
  if (!g) return null;
  const guest = webContents.fromId(g.webContentsId);
  return guest && !guest.isDestroyed() ? guest : null;
}

handleEffect(
  "browserCdp",
  (tileId, method) => ({ target: named(tileId), detail: named(method) }),
  wrap(async (_e, tileId: string, method: string, params?: Record<string, unknown>) => {
    const guest = browserGuestFor(tileId);
    if (!guest) throw new Error(`no browser tile registered for ${tileId}`);
    // webContents.debugger and an open DevTools window both claim the one
    // debugger slot, so attach() throws if the tile's DevTools is open. Surface
    // that as an actionable message instead of a raw CDP error.
    if (!guest.debugger.isAttached()) {
      try {
        guest.debugger.attach("1.3");
      } catch (err) {
        if (guest.isDevToolsOpened()) {
          throw new Error("cannot attach CDP — this tile's DevTools is open; close it (toolbar wrench) and retry");
        }
        throw err;
      }
    }
    return await guest.debugger.sendCommand(method, params ?? {});
  }),
);

// Agent-browser settings for the in-app toggle. `active` = is the bridge live
// THIS session (the switch was applied at launch); `enabled` = the persisted
// choice. They differ between toggling and relaunching, which the UI surfaces.
handle("getBrowserSettings", () => ({
  active: process.env.HIVEMIND_BROWSER_CDP === "1",
  enabled: readSettings().browserCdp === true,
  port: process.env.HIVEMIND_BROWSER_CDP_PORT ?? "9333",
}));
handleEffect("setBrowserCdpEnabled", (enabled) => ({ detail: enabled ? "on" : "off" }), wrap(async (_e, enabled: boolean) => {
  await writeSettings({ browserCdp: !!enabled });
  return { ok: true as const };
}));

// ── notification preferences ──────────────────────────────────────────────
// The persisted blob lives in settings.json; this module owns the read + the
// in-memory cache the per-notice OS-popup gate reads. The renderer caches its
// own snapshot on load + on every change here (pushed back via the setter).
handle("getNotificationSettings", () => getNotificationSettings());
handleEffect("setNotificationSettings", () => ({}), wrap(async (_e, s: unknown) => {
  await setNotificationSettings(normalizeNotificationSettings(s));
  return { ok: true as const };
}));
// The install.sh launcher (`~/.local/bin/hivemind`). Relaunching THROUGH it is
// what makes "restart after update" land on the new version: the running
// AppImage can't overwrite itself, so install.sh stages the new build to
// `.staged` and the launcher swaps it in on its next start. A plain
// app.relaunch() re-execs the current (old) AppRun and silently skips that swap.
function resolveLauncherPath(): string | null {
  const launcher = process.platform === "win32" ? "hivemind.cmd" : "hivemind";
  const candidates = [
    process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "hivemind", "bin", launcher)
      : path.join(os.homedir(), ".local", "bin", launcher),
    // path.delimiter, not ":" — PATH is ";"-separated on Windows.
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, launcher)),
  ];
  for (const p of candidates) {
    try { if (statSync(p).isFile()) return p; } catch { /* not here */ }
  }
  return null;
}
handle("relaunchApp", () => {
  const launcher = resolveLauncherPath();
  if (launcher) app.relaunch({ execPath: launcher, args: [] });
  else app.relaunch();
  app.exit(0);
});

// ── app version + self-update ─────────────────────────────────────────────
handle("getAppVersion", () => app.getVersion());

// Strict "is `latest` newer than `current`" over dotted numeric versions.
// Tolerant of differing segment counts and non-numeric junk (→ 0).
function isNewerVersion(latest: string, current: string): boolean {
  const a = latest.split(".").map((n) => parseInt(n, 10) || 0);
  const b = current.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

// Fetch the latest GitHub release in MAIN (the renderer's CSP blocks the
// api.github.com request). Any failure — offline, DNS, rate-limit, non-200 —
// resolves to a no-update result so the UI shows nothing rather than an error.
/** A build the installer downloaded beside the running one, waiting for a restart. The
 *  installer records it apart from the installed version, and the launcher promotes it when
 *  it applies it (`install.sh`). Absent, unreadable or not newer: nothing is waiting. */
function stagedVersion(current: string): string | null {
  const dir = process.env.HIVEMIND_APP_DIR?.trim() || path.join(os.homedir(), ".hivemind-app");
  try {
    const v = readFileSync(path.join(dir, ".staged-version"), "utf8").trim().replace(/^v/, "");
    return v && isNewerVersion(v, current) ? v : null;
  } catch { return null; }
}

handle("checkForUpdate", async () => {
  const current = app.getVersion();
  const staged = stagedVersion(current);
  // Settings → Network: with the update check off, nothing is asked of GitHub (R16).
  if (!getAppSettings().network.updateCheck) return { current, latest: null, updateAvailable: false, ok: true, staged, off: true };
  // Test seam: the update affordances are driven by what GitHub answers, which an e2e cannot
  // arrange. Gated to non-packaged builds — in a shipped binary an env var must not be able
  // to tell the app an update exists (the same rule as the folder picker below).
  if (!app.isPackaged && process.env.HIVEMIND_TEST_UPDATE) {
    try {
      const t = JSON.parse(process.env.HIVEMIND_TEST_UPDATE) as { latest?: string; staged?: string };
      const latest = t.latest ?? null;
      return {
        current, latest, ok: true,
        updateAvailable: !!latest && isNewerVersion(latest, current),
        staged: t.staged && isNewerVersion(t.staged, current) ? t.staged : null,
      };
    } catch { /* not JSON: fall through to the real check */ }
  }
  // `ok` distinguishes a COMPLETED check (whose result the renderer can trust
  // and cache) from a FAILED one (offline / timeout / 403 rate-limit). Without
  // it a network blip returns updateAvailable:false — indistinguishable from a
  // genuine "up to date" — and clobbers a real "update available" banner.
  // The tag GitHub redirects `releases/latest` to: no api, so no 60-requests-an-hour limit
  // shared with everyone behind this address. The api is the fallback when that fails.
  try {
    const r = await net.fetch("https://github.com/dip497/hivemind/releases/latest", {
      cache: "no-store", headers: { "User-Agent": "hivemind-desktop" }, signal: AbortSignal.timeout(8000),
    });
    const latest = tagFromReleasesLatest(r.url);
    if (latest) return { current, latest, updateAvailable: isNewerVersion(latest, current), ok: true, staged };
  } catch { /* fall through to the api */ }
  try {
    const res = await net.fetch(
      // A cache would answer with the release before this one for its first minute (the api
      // sends max-age=60), and Chromium's own cache for longer: ask nobody's stored copy.
      `https://api.github.com/repos/dip497/hivemind/releases/latest?nocache=${Date.now()}`,
      {
        cache: "no-store",
        headers: { Accept: "application/vnd.github+json", "User-Agent": "hivemind-desktop", "Cache-Control": "no-cache" },
        // Never let the fetch hang forever: a stalled socket would otherwise
        // pin the renderer on "Checking…" with no way out.
        signal: AbortSignal.timeout(8000),
      },
    );
    // A non-2xx (notably 403 rate-limit) is NOT "up to date" — it's a failed
    // check. Report ok:false so the renderer keeps its last known-good state.
    if (!res.ok) return { current, latest: null, updateAvailable: false, ok: false, staged };
    const json = (await res.json()) as { tag_name?: string };
    const latest = (json.tag_name ?? "").replace(/^v/, "").trim();
    if (!latest) return { current, latest: null, updateAvailable: false, ok: false, staged };
    return { current, latest, updateAvailable: isNewerVersion(latest, current), ok: true, staged };
  } catch {
    return { current, latest: null, updateAvailable: false, ok: false, staged };
  }
});

// Upgrade-in-place for the IN-APP button: run the same installer `hivemind
// upgrade` uses, STREAM its output to the renderer (last line of each chunk →
// `update:progress`) so the user sees it working, and resolve with the exit
// status. Does NOT quit — the renderer shows success/failure, then calls
// `relaunchApp()` (which goes through the launcher, applying the staged build).
// The bare-CLI `upgrade` arg path still uses runUpgradeAndExit (it runs in a
// real terminal, so inherited stdio + exit is correct there).
handleEffect("runUpgrade", () => ({}), () => new Promise<{ ok: boolean; code: number | null }>((resolve) => {
  // Test seam (non-packaged only, as above): replay the installer's lines instead of running
  // it, so an e2e can drive what the user reads without downloading a release.
  const scripted = !app.isPackaged && process.env.HIVEMIND_TEST_UPDATE;
  if (scripted) {
    let lines: string[] = [];
    try { lines = (JSON.parse(scripted) as { progress?: string[] }).progress ?? []; } catch { lines = []; }
    if (lines.length) {
      let i = 0;
      const next = (): void => {
        if (i >= lines.length) { resolve({ ok: true, code: 0 }); return; }
        broadcast("update:progress", lines[i]!);
        i++;
        setTimeout(next, 150);
      };
      next();
      return;
    }
  }
  const up = upgradeCommand("dip497/hivemind");
  const child = spawn(up.file, up.args, { stdio: ["ignore", "pipe", "pipe"] });
  const relay = (d: Buffer) => {
    const line = d.toString().split("\n").map((s) => s.trim()).filter(Boolean).pop();
    if (line) broadcast("update:progress", line);
  };
  child.stdout?.on("data", relay);
  child.stderr?.on("data", relay);
  child.on("error", () => resolve({ ok: false, code: 127 }));
  child.on("close", (code) => resolve({ ok: code === 0, code: code ?? null }));
}));

// The repo passed on the CLI (`hivemind .`), or null for a bare launch (then
// the renderer falls back to its persisted last-project).
handle("getLaunchTarget", (e) => launchTargets.get(e.sender) ?? null);
// A New Window command: another window on the workspace the asking one shows.
handle("window:new", (e) => createWindow(workspaceShownBy(e.sender)));

// findGitRoot + computeRepoPath now live in ./workspace-paths (pure + tested).

// Folder picker for "Open project". Returns the selected absolute path or
// null if the user cancelled. Renderer then invokes `resolveProject` with
// that path as the hint, which rebuilds root/repoPath for the new workspace.
handle("pickProjectFolder", async () => {
  // Test seam: e2e can't drive a native folder dialog, so return a fixed dir
  // when HIVEMIND_TEST_PICK_DIR is set. Gated to non-packaged builds — in a
  // shipped binary a user's `.bashrc` or hostile process must not be able to
  // silently hijack the picker by setting this env var (P0 from security review).
  if (!app.isPackaged && process.env.HIVEMIND_TEST_PICK_DIR) {
    return process.env.HIVEMIND_TEST_PICK_DIR;
  }
  const win = userWindow();
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    title: "Open project",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});
// Initialize a .hivemind/ workspace in `dir` (no terminal needed). Mirrors
// `hive init --prefix`. Returns the new root path. Renderer then re-resolves
// the project so the New-issue button + board light up.
handleEffect(
  "initWorkspace",
  (dir, prefix) => ({ target: named(dir), detail: named(prefix)?.toUpperCase() }),
  wrap(async (_e, dir: string, prefixRaw: string) => {
    const prefix = String(prefixRaw).toUpperCase();
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(prefix)) {
      throw new Error(`prefix must be UPPERCASE 2-10 chars (got: ${prefix})`);
    }
    const root = path.join(dir, ".hivemind");
    const existing = await findRoot(dir);
    if (existing === root) throw new Error(`.hivemind/ already exists at ${root}`);
    await fsp.mkdir(path.join(root, "issues"), { recursive: true });
    await writeConfig(root, { prefix, next_id: 1, agents: {}, format: WORKSPACE_FORMAT });
    await writeAgentContext(root);
    // Install the agentic stack by default — a brand-new workspace should be
    // agent-ready so "Work on this" actually works (the agent gets the hive
    // skills + CLAUDE.md section). Idempotent.
    await installAgenticStack(dir);
    return { root };
  })
);

// Idempotent installer for the agentic stack (the same code path as `hive init`
// — @hivemind/core's installAgenticStack): CLAUDE.md agentic section + the
// hive skills (hive-work / hive-workflow / hivemind / hive-browser) + retirement
// of a stale `.mcp.json` hive entry. Without this, a spawned agent has no skill
// telling it how to work an issue with `hive`, so "Work on this" would silently
// do nothing — the gap the user hit.
async function installAgenticStack(dir: string): Promise<void> {
  await coreInstallAgenticStack(dir);
}

// Ensure the agentic stack exists for an already-initialized workspace (called
// before "Work on this" + manually via the workspace switcher). dir = repo dir.
handleEffect(
  "installAgentic",
  (dir) => ({ target: named(dir) }),
  wrap(async (_e, dir: string) => {
    const root = await findRoot(dir);
    // No-op (don't throw) when the dir has no .hivemind workspace. This handler
    // is fired best-effort on bind / switch; a repo without `hive init` simply
    // has nothing to install, and throwing here surfaced a noisy main-process
    // "Error occurred in handler for 'installAgentic'" for an expected state.
    if (!root) return { ok: false, reason: "no-workspace" as const };
    await installAgenticStack(dir);
    return { ok: true as const };
  }),
);
// ── cross-repo: registry + transfer + links ─────────────────────────────
handle("listWorkspaces", wrap(async () => listWorkspaces({ persistPrune: true })));
handle(
  "resolveIssueRoot",
  wrap(async (_e, id: string) => ({ root: await resolveRootForIssue(id) })),
);

// Files the terminal will hand to the OS opener — a VIEWABLE allowlist, not a
// denylist, so executables / installers / shortcuts (.exe .desktop .lnk .msi
// .app .sh-binaries …) are never launched: anything not listed is refused.
const OPENABLE_EXT = new Set([
  ".html", ".htm", ".md", ".markdown", ".txt", ".text", ".log", ".rtf", ".pdf", ".csv", ".tsv",
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".env", ".xml", ".svg",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".kts",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".hh", ".cs", ".php", ".swift", ".scala", ".sh", ".bash", ".zsh",
  ".fish", ".sql", ".css", ".scss", ".sass", ".less", ".vue", ".svelte", ".astro", ".lua", ".pl", ".r",
  ".dart", ".ex", ".exs", ".erl", ".clj", ".hs", ".ml", ".gradle", ".groovy", ".tf", ".proto", ".graphql",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".avif", ".tiff", ".mp4", ".webm", ".mov", ".mp3", ".wav", ".ogg",
]);

// Open a file/dir clicked in the terminal with the OS default app (xdg-open via
// shell.openPath). The file-link provider passes the raw matched token + the
// tile's cwd. Hardened (automated security review): (1) CONFINE to the tile's
// workspace via realpath — rejects absolute/`..`/symlink escapes; (2) ALLOWLIST
// viewable extensions — never hands an executable/installer/shortcut to the OS
// opener; (3) extensionless files (Makefile, LICENSE) only when NOT executable.
handleEffect("openPathInApp", (repo, target) => ({ target: fileIn(repo, target) }), wrap(async (_e, repoPath: string, target: string) => {
  if (!target) return { ok: false, error: "no target" };
  let t = target.trim();
  if (t.startsWith("file://")) {
    try { t = decodeURIComponent(new URL(t).pathname); } catch { return { ok: false, error: "bad file uri" }; }
  }
  t = t.replace(/:\d+(?::\d+)?$/, "").replace(/[)\].,;:'"]+$/, ""); // drop :line:col + trailing punctuation
  if (t.startsWith("~/")) t = path.join(os.homedir(), t.slice(2));
  // A local opener can't reach an ssh:// workspace or a non-file URI; and we need
  // a real workspace to confine against.
  if (isRemote(repoPath) || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return { ok: false, error: "not a local path" };
  if (!repoPath) return { ok: false, error: "no workspace to scope to" };
  const resolved = path.resolve(repoPath, t);
  const st = await fsp.stat(resolved).catch(() => null);
  if (!st) return { ok: false, error: "not found" };
  // (1) Confine to the workspace — realpath both sides so a symlink can't escape.
  let realResolved: string, realRepo: string;
  try {
    realResolved = await fsp.realpath(resolved);
    realRepo = await fsp.realpath(repoPath);
  } catch { return { ok: false, error: "unresolvable" }; }
  if (realResolved !== realRepo && !realResolved.startsWith(realRepo + path.sep)) {
    return { ok: false, error: "outside workspace" };
  }
  // (2)/(3) Type gate (dirs open the file manager — no gate needed).
  if (st.isFile()) {
    const ext = path.extname(realResolved).toLowerCase();
    if (ext) {
      if (!OPENABLE_EXT.has(ext)) return { ok: false, error: `refused (${ext})` };
    } else if (st.mode & 0o111) {
      return { ok: false, error: "refused (executable)" };
    }
  }
  const err = await shell.openPath(realResolved); // "" on success
  return err ? { ok: false, error: err } : { ok: true };
}));

// Diagnostics sink: append render-quality lines to userData/render-diag.log so a
// blurry-text report becomes a readable trace (incl. over SSH). Best-effort and
// self-capping — truncate to the last ~64KB when it grows past 128KB so it never
// balloons. Never throws into the renderer.
async function writeDiagLog(line: string): Promise<void> {
  try {
    const file = path.join(app.getPath("userData"), "render-diag.log");
    try {
      const st = statSync(file);
      if (st.size > 128 * 1024) {
        const tail = readFileSync(file, "utf8").slice(-64 * 1024);
        writeFileSync(file, tail);
      }
    } catch { /* file not there yet */ }
    await fsp.appendFile(file, `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch { /* diagnostics must never break the app */ }
}
handle("diagLog", async (_e, line: string) => { await writeDiagLog(line); });

// ── remote (SSH) frames ─────────────────────────────────────────────────
// Probe + auth-register a host, returning its home dir (the connectivity check
// behind "attach remote"). `uri` is ssh://[user@]host[:port]/ — the path is
// ignored here (the picker chooses it next).
// Keychain fallback for the connection pool: when a remote tile is restored
// after an app restart, the in-memory auth map is empty, so the pool resolves
// the saved (safeStorage-encrypted) credential here instead of failing with
// "All configured authentication methods failed". A password we can't decrypt
// (keychain key changed) resolves to null → the clear "no credential" error,
// prompting re-entry rather than a silent credential-less connect.
remoteConns.setAuthResolver((hostId) => {
  const saved = savedAuth(hostId);
  if (!saved || saved.passwordDecryptFailed) return null;
  return saved.auth;
});
// Machines: the catalog `hive machine` edits, plus each host's live state.
handle("machines:get", wrap(async () => machinesSnapshot()));
handleEffect("machines:add", (req) => ({ target: named(req?.target) }), wrap(async (_e, req: MachineAddRequest) => addMachine(req)));
handleEffect("machines:check", (id) => ({ target: named(id) }), wrap(async (_e, id: string) => checkMachine(String(id))));
handleEffect("machines:install", (id) => ({ target: named(id) }), wrap(async (_e, id: string) => installOnMachine(String(id))));
handleEffect("machines:update", (id) => ({ target: named(id) }), wrap(async (_e, id: string, patch: { label?: string; enabled?: boolean }) => updateMachine(String(id), patch ?? {})));
handleEffect("machines:edit", (id, patch) => ({ target: named(id), detail: named(patch?.target) }), wrap(async (_e, id: string, patch: { target: string; label?: string; password?: string }) => editMachine(String(id), {
  target: String(patch?.target ?? ""),
  ...(typeof patch?.label === "string" ? { label: patch.label } : {}),
  ...(typeof patch?.password === "string" && patch.password ? { password: patch.password } : {}),
})));
handleEffect("machines:remove", (id) => ({ target: named(id) }), wrap(async (_e, id: string) => removeMachine(String(id))));
handleEffect("machines:set-password", (id) => ({ target: named(id) }), wrap(async (_e, id: string, password: string) => setMachinePassword(String(id), String(password))));
handle("machines:sessions", wrap(async (_e, uri: string | null) => machineSessions(uri ? String(uri) : null)));
handleEffect("machines:reconnect", (id) => ({ target: named(id) }), wrap(async (_e, hostId: string) => { reconnectMachineHost(String(hostId)); }));
// List a remote directory for the folder picker. `dir` empty → the host's home.
handle("sshListDir", wrap(async (_e, uri: string, dir: string) => {
  const target = remoteTarget(String(uri));
  const fs = await remoteConns.fs(target);
  const start = dir && dir.trim() ? dir : await fs.home();
  const real = await fs.realpath(start).catch(() => start);
  const entries = await fs.readdir(real);
  return { dir: real, entries };
}));

// PTY
// Sliding-window spawn rate-limit (see ptySpawn handler): over the limit a spawn waits
// for room rather than failing, so restoring a large workspace no longer kills tiles.
const recordPtySpawn = makeSpawnPacer({ windowMs: 10_000, max: 24, queueMax: 128 });

// The control plane (`hive ctl`, @hivemind/host/control/plane): what it keeps of the agents here
// — output, turns, statuses, pipes, held messages — fed from the SAME pty data main relays to the
// windows, so an agent's output and turns are captured with no window showing it. Its socket
// opens in startHcpControlPlane().
const control: ControlPlane = new ControlPlane({
  dir: () => app.getPath("userData"),
  publish: (event, ...params) => workspaceServer.publish(event, ...params),
  // Used by agent.send and pipe forwarding.
  write: (tileId, data, paste) => {
    if (onYourDevices.holds(tileId)) { onYourDevices.write(tileId, data, paste); return true; }
    if (hasRemotePty(tileId)) { writeRemotePty(tileId, data, paste); return true; }
    if (hasSession(tileId)) { writePty(tileId, data, paste); return true; }
    return false; // dead/unknown tile → agent.send surfaces TILE_NOT_FOUND
  },
  // A window lays a spawned tile out, and starts its session.
  spawned: () => {},
  windowsUp: () => openWindows().length > 0,
  // Every verb routes through the boot scan first: spawn resolves the agent by id and other verbs
  // read its capabilities, so none may run against a half-set catalog.
  ready: () => agentsScanned,
  diag: (line) => void writeDiagLog(line),
  methods: () => ({
    callRenderer: hcpCallRenderer,
    toolsSettings: () => getAppSettings().tools,
    reloadSettings: () => reloadSettings().then((s) => ({ ok: true, preset: s.appearance.preset })),
    // A worker of a remote agent runs on that host: this PATH says nothing about it.
    defaultAgentId: async () => {
      await shellEnvReady;
      return preferredAgent((getAppSettings() as { agents?: { defaultAgent?: string } }).agents?.defaultAgent, (d) => !!findBin(d.bin))?.id;
    },
    agentInstalled: async (def, callerTile) => {
      if (callerTile && hasRemotePty(callerTile)) return true;
      await shellEnvReady;
      return !!findBin(def.bin);
    },
    workspaces: workspaceStore(),
    shownWorkspace,
    launchOptions: (agentId) => getAppSettings().agents.options[agentId] ?? {},
    endSession: (tileId) => terminals.end(tileId),
    sessionHeld: (id) => hasSession(id) || hasRemotePty(id),
    intents: hostIntents(),
  }),
});
// View protocol 1.3: output levels for watched tiles (a window asks with terminal.watchActivity).
const ptyActivity = new ActivityMeter((levels) => {
  workspaceServer.publish("terminal.activity", levels);
});
/** Push a NON-FATAL background-subsystem error to the renderer as a toast, so
 *  nothing fails silently (e.g. a stale PTY daemon that breaks hook injection).
 *  Fatal errors still use dialogs. Idempotent + cheap; safe to call pre-window. */
function pushAppError(message: string, source: string): void {
  broadcast("app:error", { message, source } satisfies AppErrorEvent);
}

// The ONE teardown path for a tile whose pty has exited (crash, kill, or a
// tile.close that killed it). Both the local and remote onExit handlers funnel
// through here, and so does a kill (ptyKill: a daemon tells its killer nothing
// of the exit), so no teardown path leaks control-plane state, and a blocked
// agent.read or approval on it is answered now.
const onPtyExit = (tileId: string): void => control.exited(tileId);

// ── terminals ─────────────────────────────────────────────────
// Every session's output to every window that shows it (@hivemind/host/terminals, on
// @hivemind/agent-host/session-relay): main holds one attach per session, and a window that mounts
// a tile another window already shows joins it, its screen first. How a session runs is main's:
// the daemon or this process, or ssh for a remote frame.
/** Terminals in frames on the person's other devices (M3): in each device's daemon, over hive-net.
 *  One on a participant's machine (M4) is watched, as their app shows it. */
const onYourDevices = deviceSessions({
  dial: dialDevice,
  mine: isYourDevice,
  shown: shownFrom,
  onEvent: (topic, data) => control.fromMachine(topic, data),
  onStatus: (device, state, detail) => deviceStatus(device, state, detail),
});

/** The host's screen for a session, read in order with its output; null when it keeps none. */
function screenOf(tileId: string): ReadScreen | null {
  if (onYourDevices.holds(tileId)) return onYourDevices.screen(tileId);
  if (hasRemotePty(tileId)) return remoteKeepsScreen(tileId) ? (cb) => screenRemotePty(tileId, cb) : null;
  return PERSIST_PTY && hasSession(tileId) ? (cb) => ptyDaemon.screenPty(tileId, cb) : null;
}
function setPtyPaused(tileId: string, paused: boolean): void {
  if (onYourDevices.holds(tileId)) { if (paused) onYourDevices.pause(tileId); else onYourDevices.resume(tileId); }
  else if (hasRemotePty(tileId)) { if (paused) pauseRemotePty(tileId); else resumeRemotePty(tileId); }
  else if (paused) pausePty(tileId);
  else resumePty(tileId);
}


// The boot agent scan, kept as a promise: the first frame must not wait on it,
// but an HCP spawn/bind must not race it — a just-installed agent only resolves
// by id once the scan has set the catalog.
let agentsScanned: Promise<void> = Promise.resolve();


/** Who is at a client of this host, as the others are told: a peer is the person its certificate
 *  names, under the name they joined with; a window is the person at this machine. */
const whoIs = (c: Connection): { person: string; name: string } => c.actor.kind === "peer"
  ? { person: c.actor.person, name: personName(c.actor.person) }
  : { person: machineIdentity().personId, name: getAppSettings().profile.name || os.userInfo().username };

const terminals = new Terminals({
  intents: hostIntents(),
  relay: {
    // The HCP output recorder is fed from the coalesced batch, not per pty read: its three
    // strip-ANSI regex passes then run once per batch, and an escape sequence split across two
    // reads is stripped as a whole. (The agent.stream broadcast stays per chunk.)
    record: (tileId, data) => control.recorder.record(tileId, data),
    screenPrefix: REATTACH_RESET,
    // Every window minimized or hidden: no renderer can paint, so stretch the batching
    // (backgroundThrottling is off: a backgrounded agent must keep streaming).
    hidden: () => BrowserWindow.getAllWindows().every((w) => w.isDestroyed() || w.isMinimized() || !w.isVisible()),
  },
  askedByHost: (bare) => control.takeSpawned(bare),
  // Who holds each terminal's keyboard, and each session's size, told to every client (M2).
  publish: (event, ...params) => workspaceServer.publish(event, ...params),
  who: whoIs,
  // A terminal on a participant's machine is typed into and sized there, by its person (M4).
  machineOf: terminalMachine,
  watchActivity: (tiles) => ptyActivity.setWatched(tiles),
  onError: (m) => console.warn(`[terminals] ${m}`),
  backend: {
    start: startSession,
    // Only a person's keystrokes come this way (programmatic writes go through the mailbox), so an
    // interrupt key here is the user stopping the agent's turn.
    write: (tileId, data, paste) => {
      control.status.input(toBareId(tileId), data);
      if (onYourDevices.holds(tileId)) onYourDevices.write(tileId, data, paste);
      else if (hasRemotePty(tileId)) writeRemotePty(tileId, data, paste); else writePty(tileId, data, paste);
    },
    echoes: (tileId) => !hasRemotePty(tileId) && !onYourDevices.holds(tileId),
    resize: (tileId, cols, rows) => {
      if (onYourDevices.holds(tileId)) onYourDevices.resize(tileId, cols, rows);
      else if (hasRemotePty(tileId)) resizeRemotePty(tileId, cols, rows); else resizePty(tileId, cols, rows);
    },
    pause: (tileId) => setPtyPaused(tileId, true),
    resume: (tileId) => setPtyPaused(tileId, false),
    // A daemon tells its killer nothing of the exit, so the teardown runs here: anything waiting on
    // the tile (a parent's read, an approval) is answered now, not at its timeout, and nothing asks
    // after its status or its agent again.
    kill: (tileId) => {
      if (onYourDevices.holds(tileId)) onYourDevices.kill(tileId);
      else if (hasRemotePty(tileId)) killRemotePty(tileId); else killPty(tileId);
      onPtyExit(tileId);
      control.forget(tileId);
    },
    detach: (tileId) => {
      if (onYourDevices.holds(tileId)) onYourDevices.detach(tileId);
      else if (hasRemotePty(tileId)) detachRemotePty(tileId); else detachPty(tileId);
    },
    screen: screenOf,
  },
});

/** Start (or, with a daemon, attach to) the session a tile runs. */
async function startSession(opts: TerminalOpts, out: SessionOutput): Promise<{ pid: number }> {
  // A tile of a workspace shared from elsewhere runs on this machine only as its person placed it
  // here (M4): never with what the workspace's document says, which its host's owner may change.
  // One someone else put in a frame of theirs here is that one's to start, when they let the
  // people there run agents here: a window here shows it once it runs, and never starts it.
  const placed = placedRun(opts.tile ?? toBareId(opts.tileId));
  const theirs = placed === null && !opts.attachOnly && PERSIST_PTY && startedByOthers(opts.tile ?? toBareId(opts.tileId));
  if (placed === null && !opts.attachOnly && !theirs) throw new Error("someone else placed this tile on your computer: it runs here only if you place it");
  if (theirs) opts = { ...opts, attachOnly: true, liveOnly: true };
  if (placed) {
    const shell = defaultShellFor();
    opts = { ...opts, cmd: placed.cmd ?? shell.cmd, args: placed.args ?? (placed.cmd ? [] : shell.args) };
  }
  const spawning = agentForCmd(opts.cmd);
  // An agent a repository ships runs in that repository, not wherever a tile happens to be.
  if (spawning && !agentAllowedIn(spawning, opts.cwd)) {
    throw new Error(`${spawning.label} comes from ${spawning.sourceRoot} and only runs in tiles there`);
  }
  { const d = spawning; if (d) control.agentOf.set(toBareId(opts.tileId), d.id); else control.agentOf.delete(toBareId(opts.tileId)); }
  // Spawn rate-limit: a compromised renderer (XSS via rendered diff/issue
  // content) could fork-bomb the host through ptySpawn. Cap spawns per sliding
  // window — the dev-bridge already guards the identical call; the IPC path
  // must too. And reject a non-directory cwd up front (otherwise it surfaces as
  // an opaque node-pty throw later).
  // Showing an existing session starts no process, so it cannot fork-bomb anything.
  if (!("attachOnly" in opts && opts.attachOnly)) await recordPtySpawn();
  // Supervised worker? Inject HIVE_SUPERVISE into its spawn env so the daemon
  // installs the PreToolUse permission-broker hook (HCP Phase 6). opts.tileId is
  // the pty id; the policy is keyed by the bare id.
  const supSpec = control.supervise.get(toBareId(opts.tileId));
  if (supSpec) opts = { ...opts, env: { ...(opts.env ?? {}), HIVE_SUPERVISE: supSpec } };
  // An initial ▶ Work prompt rides the spawn env (crosses the wire + persists),
  // to be appended as claude's positional argv at exec (applyInitialPrompt) —
  // this is the auto-submitting path that replaced typing into the booting TUI.
  if (opts.initialPrompt) {
    opts = { ...opts, env: { ...(opts.env ?? {}), [INITIAL_PROMPT_ENV]: opts.initialPrompt } };
  }
  // The window watches from the first byte: an attach's screen arrives as data.
  const bare = toBareId(opts.tileId);
  const callbacks = {
    onData: (data: string, replay?: boolean) => { control.output(bare, data); out.data(data, replay); if (!replay) ptyActivity.note(bare, data.length); },
    // What is pending (recorded and shipped), then the exit, BEFORE the HCP teardown forgets the tile.
    onExit: (code: number, signal?: number) => { out.exit(code, signal); onPtyExit(opts.tileId); },
  };
  // A frame on this device named by its id is a frame here, at its path.
  const onDevice = parseDeviceUri(opts.cwd);
  if (onDevice?.device === machineIdentity().deviceId) opts = { ...opts, cwd: onDevice.path };
  // Remote frame (a machine:// or ssh:// cwd): on another of the person's devices, in its daemon
  // over hive-net (M3); on a saved machine or an ssh host, over ssh, in-main. Skip the local
  // cwd stat + shell-env patch (those are for the LOCAL host). The data/exit
  // plumbing is identical.
  if (isRemote(opts.cwd)) {
    if (onDevice) return onYourDevices.start(opts, { data: callbacks.onData, exit: callbacks.onExit, size: out.size });
    return spawnRemotePty(opts, remoteTarget(opts.cwd), callbacks);
  }
  if (opts.cwd) {
    const st = await fsp.stat(opts.cwd).catch(() => null);
    if (!st?.isDirectory()) throw new Error(`pty cwd is not a directory: ${opts.cwd}`);
  }
  // Ensure the user's PATH/tokens are patched into process.env BEFORE the PTY
  // (or, in daemon mode, the daemon process that inherits this env) spawns —
  // otherwise `claude`/`gh`/nvm-node may not resolve. Idempotent + cached.
  await applyShellEnvToProcess();
  // A PTY can outlive its windows and emit data/exit after they are gone: the relay skips a
  // viewer whose window is destroyed.
  return theirs ? onceStarted(() => spawnPty(opts, callbacks)) : spawnPty(opts, callbacks);
}

/** The workspace store, through the workspace API: each window writes as itself. */
// A copy of a workspace shared from elsewhere is written only while its host lets this person
// edit its board (M1), and only with what their role there allows.
const layouts = new Layouts(storeFor, {
  mayWrite: (repo) => !repo.startsWith("hive://") || mayWriteShared(repo.slice("hive://".length)),
  refuse: (repo, before, after) => (repo.startsWith("hive://") ? refusedShared(repo.slice("hive://".length), before, after) : null),
  // What a window here places on this machine in a workspace shared from elsewhere (M4).
  wrote: (repo, before, after) => { if (repo.startsWith("hive://")) wroteShared(repo, before, after); },
});

// The workspace API (R8): git and worktrees, files, issues, review comments, agents' status and
/** Plans agents hand off, told to every client, answered by one who may drive agents (M2). */
const plans = new Plans({
  publish: (event, ...params) => workspaceServer.publish(event, ...params),
  who: whoIs,
  repoOf: (bare) => workspaceStore().workspaceOf(bare),
});

// links, terminals, the store and who is where on it (M1). Each window is a connection to it (workspace-ipc.ts), which is
// answered as the person at the window, and sent its events.
const workspaceServer: WorkspaceServer = new WorkspaceServer([
  ...workspaceDomains,
  layouts.domain,
  agents({ statuses: () => control.status.all(), links: () => control.links() }),
  terminals.domain,
  plans.domain,
  presence(() => workspaceServer, () => machineIdentity().personId),
  peopleHere.domain,
], hostIntents(), (m) => console.warn(`[workspace] ${m}`));
const workspaceIpc = serveWorkspaceApi(workspaceServer, elsewhere);

/** The workspace a window shows, or null. */
const workspaceShownBy = (wc: WebContents): string | null => {
  const connection = workspaceIpc.find(wc);
  return (connection && layouts.shownBy(connection)?.repo) ?? null;
};
/** The workspace the window the user is at shows, and the frame the user is in there: the
 *  focused window's, else any window's. */
function shownWorkspace(): Shown | null {
  const focused = BrowserWindow.getFocusedWindow();
  const connection = focused ? workspaceIpc.find(focused.webContents) : undefined;
  return (connection && layouts.shownBy(connection)) ?? layouts.anyShown();
}

// ── lifecycle ─────────────────────────────────────────────────

// Patch process.env.PATH from the user's login shell BEFORE any pty/git spawn
// happens. Fire-and-forget — pty.spawn() and child_process.spawn() pick up the
// patched env on next tick. (superset.sh pattern; we hand-rolled equivalent
// of sindresorhus/shell-env in ./shell-env.ts so we don't add a runtime dep.)
// Anything that reads PATH to find an agent waits on this, so a call in the first
// seconds is answered against the user's shell, not the one Electron inherited.
const shellEnvReady = applyShellEnvToProcess().catch(() => ({}));

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
  // EarlyEstablishGpuChannel/EstablishGpuChannelAsync: faster first paint (VS Code).
  // PlatformHEVCDecoderSupport + VaapiVideoDecoder(LinuxGL): enable HEVC/H.265
  // wallpaper playback via the GPU's hardware decoder (Chromium ships no software
  // HEVC decoder). Works on VAAPI-capable GPUs (Intel/AMD); a clip that still can't
  // decode falls back to the gradient wallpaper. H.264 always worked regardless.
  "EarlyEstablishGpuChannel,EstablishGpuChannelAsync,PlatformHEVCDecoderSupport,VaapiVideoDecoder,VaapiVideoDecodeLinuxGL",
);
// VAAPI hardware video decode is often gated behind the GPU blocklist on Linux;
// allow it so the iGPU's HEVC decoder is actually used.
app.commandLine.appendSwitch("ignore-gpu-blocklist");
// Many xterm WebGL terminals can coexist. Default cap is 16 in Chromium; raise
// it so a workspace with several claude/shell tiles doesn't silently fall back
// to the DOM renderer when the 16th WebGL context is requested. VS Code uses 32.
app.commandLine.appendSwitch("max-active-webgl-contexts", "32");

// ── Agent browser-use (CDP) enabler ───────────────────────────
// Opt-in (HIVEMIND_BROWSER_CDP=1): expose a LOOPBACK Chrome DevTools Protocol
// port so a spawned agent in a PTY tile can drive a BrowserTile with
// `agent-browser --cdp <port>` (see the `hive-browser` skill). The port + the
// discovery-file path are exported into the environment, which every PTY
// inherits (pty-host spreads process.env) — so the agent sees
// $HIVEMIND_BROWSER_CDP_PORT and $HIVEMIND_BROWSER_TARGETS with no extra wiring.
// SECURITY: a remote-debugging port also exposes the app's OWN window, so this
// is off by default and bound to 127.0.0.1 — only enable it for agents you trust.
// Persisted app settings live in <userData>/settings.json. Read SYNC here
// because the remote-debugging switch must be set before app-ready (it can't be
// toggled at runtime — that's why the UI toggle persists a choice + relaunches).
function readSettings(): { browserCdp?: boolean } {
  try { return JSON.parse(readFileSync(settingsFile(), "utf8")) as { browserCdp?: boolean }; }
  catch { return {}; }
}
// The theme lives in this same file (identical path in a packaged app), so the
// write goes through the shared lock in @hivemind/core/settings instead of a
// read-then-write that would erase a concurrent theme edit. The READ above stays
// synchronous: it runs before app-ready, and reads lose nothing.
async function writeSettings(patch: Record<string, unknown>): Promise<void> {
  await patchSettingsExtras(patch, settingsFile());
}
// Enable the agent-browser CDP bridge when the env var OR the persisted setting
// asks for it. The env var stays an escape hatch; the Settings toggle is the
// normal path. SECURITY: a debug port also exposes the app window, so this is
// off by default and bound to 127.0.0.1.
if (process.env.HIVEMIND_BROWSER_CDP === "1" || readSettings().browserCdp === true) {
  const port = process.env.HIVEMIND_BROWSER_CDP_PORT || "9333";
  app.commandLine.appendSwitch("remote-debugging-port", port);
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  process.env.HIVEMIND_BROWSER_CDP = "1";
  process.env.HIVEMIND_BROWSER_CDP_PORT = port;
  // $HIVEMIND_BROWSER_TARGETS is set post-ready in createWindow (userData path
  // is only reliable then) — before any PTY spawns, so agents still inherit it.
}
// NOTE: we intentionally do NOT set disable-gpu-vsync / ignore-gpu-blocklist /
// disable-frame-rate-limit / enable-zero-copy / force_high_performance_gpu /
// CanvasOopRasterization. Those are debug flags (vsync/framerate) or
// driver-bypass risks (blocklist) or no-ops (zero-copy doesn't touch xyflow
// transform compositing; CanvasOopRasterization is default-on since Chromium
// M113 / Electron 25+). VS Code, Figma, Slack, Discord ship none of them.
// backgroundThrottling: false (BrowserWindow webPreferences) is the correct
// supported lever for keeping RAF alive on unfocused windows.

// `hivemind upgrade` should UPDATE, not open a window. New installs intercept
// this in the install.sh launcher, but an OLD launcher (or a bare symlink to
// the AppImage) passes the literal word "upgrade" straight to this binary,
// where Electron would otherwise ignore the unknown arg and just open a window.
// Handle it at the binary level so upgrade is correct regardless of launcher age:
// run the official installer, stream its output, and exit — never create a window.
function runUpgradeAndExit(): void {
  const up = upgradeCommand("dip497/hivemind");
  process.stdout.write("hivemind: upgrading via the official installer…\n");
  const child = spawn(up.file, up.args, { stdio: "inherit" });
  child.on("error", () => app.exit(127));
  child.on("close", (code) => app.exit(code ?? 0));
}

if (process.argv.slice(1).some((a) => a === "upgrade" || a === "--upgrade")) {
  runUpgradeAndExit();
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv, workingDirectory) => {
    const win = userWindow();
    if (!win) {
      void createWindow(resolveLaunchTarget(argv, workingDirectory || process.cwd()));
    } else {
      if (win.isMinimized()) win.restore();
      win.focus();
      // `hivemind <path>` run while a window is already open → switch it to
      // that repo instead of just refocusing the (stale) current project.
      const target = resolveLaunchTarget(argv, workingDirectory || process.cwd());
      if (target) win.webContents.send("open-project", target);
    }
  });
  // Persistent local-video wallpaper: serve a user-picked clip by its real path
  // via a custom scheme. A blob: URL can't survive a reload (in-memory), and a
  // raw file:// is blocked by webSecurity + CSP — so the theme stores a stable
  // `hm-media://v/<encoded-abs-path>` URL and main streams the file here. Must be
  // registered as privileged BEFORE app `ready`.
  protocol.registerSchemesAsPrivileged([
    { scheme: "hm-media", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
    // Custom-media layers (user-supplied background + transparent overlay). Same
    // sandbox model as hm-media, but keyed by BARE FILENAME (hivemedia://<file>)
    // and confined to userData/media. `stream: true` is REQUIRED so <video>
    // range-requests (seek/loop) work.
    { scheme: "hivemedia", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
  // Community view packages: hm-view://<id>/… served to sandboxed iframes.
  registerViewScheme();
  app.whenReady().then(async () => {
    refreshWindowsStartMenuShortcut();
    handleViewProtocol();
    installSettingsIpc(broadcast);
    installIdentityIpc();
    // The person's other devices run terminals here in this computer's daemon, when it has one.
    // A participant who lends their machine's keyboards, or keeps them again (M4).
    installNetworkIpc(workspaceServer, PERSIST_PTY ? ptyDaemon.connectDaemon : undefined, (device) => terminals.machineChanged(`peer:${device}`));
    installWorkspaceStoreIpc(layouts, workspaceIpc.connect, (change) =>
      workspaceServer.publishTo((c) => !layouts.made(c, change), "store.changed", { repo: change.repo, part: change.part }));
    void initMachines({
      send: (snap) => broadcast("machines:changed", snap),
      listLocalSessions: () => (PERSIST_PTY ? ptyDaemon.listSessions() : Promise.resolve([])),
      version: app.getVersion(),
    }).catch((e: unknown) => console.warn("[machines] init failed:", e));
    installViewManagementIpc();
    installPluginCatalogIpc();
    handle("views:list", wrap(async (_e, repoRoot: string | null) => listViewPackages(repoRoot ? String(repoRoot) : null)));

    // A repo's agents belong to that repo. Opening a second workspace must not take the
    // first one's agents out of the catalog (its tiles still spawn through it), and a
    // repo's agent must not become spawnable everywhere — ptySpawn enforces the second.
    const repoAgents = new Map<string, AgentProviderDef[]>();
    const publishCatalog = (defs: AgentProviderDef[], repoRoot?: string): void => {
      if (repoRoot) repoAgents.set(path.resolve(repoRoot), defs.filter((d) => d.sourceRoot));
      const all = defs.filter((d) => !d.sourceRoot);
      const taken = new Set(all.map((d) => d.id));
      for (const list of repoAgents.values()) {
        for (const d of list) if (!taken.has(d.id)) { taken.add(d.id); all.push(d); }
      }
      setCatalog(all);
    };
    // Only manifests come from disk — nothing agent-specific is compiled in any more.
    let lastLoaded: Awaited<ReturnType<typeof loadAgents>>["loaded"] = [];
    const scanAgents = async (repoRoot?: string) => {
      const disabled = (getAppSettings() as { agents?: { disabled?: string[] } }).agents?.disabled ?? [];
      const r = await loadAgents({ repoRoot, disabled });
      // Defs of switched-off agents, so their settings pages still answer.
      lastLoaded = r.loaded;
      return r;
    };
    // Not awaited at startup: the first frame must not wait on optional disk I/O.
    agentsScanned = scanAgents().then(({ defs, loaded }) => {
      publishCatalog(defs); // main resolves providers for spawn + HCP binding too
      for (const a of loaded) {
        if (a.error) console.warn(`[agents] ${a.id} (${a.source}) not loaded: ${a.error}`);
      }
    }).catch((e: unknown) => {
      console.warn("[agents] manifest scan failed:", e);
    });
    handle("agents:list", wrap(async (_e, repoRoot: string | null) => {
      const { defs, loaded, shadowed } = await scanAgents(repoRoot ? String(repoRoot) : undefined);
      // Main resolves providers too (spawn, HCP), so a rescan refreshes this process as well.
      // The reply stays scoped to the workspace that asked: other repos' agents are in
      // main's catalog for their own tiles, not in this one's pickers.
      publishCatalog(defs, repoRoot ? String(repoRoot) : undefined);
      return { agents: toWire(loaded), shadowed };
    }));
    // Switched-off agents are not in the catalog but still have a card.
    const knownDef = (id: string) => agentById(id) ?? lastLoaded.find((a) => a.id === id && a.def)?.def;
    // Detection must see the PATH tiles launch with, which the login shell supplies.
    handle("agents:option-choices", wrap(async (_e, id: string) => {
      await applyShellEnvToProcess();
      const def = knownDef(String(id));
      return def ? discoverOptions(def) : {};
    }));
    handle("agents:presence", wrap(async () => {
      await applyShellEnvToProcess();
      return Object.fromEntries(getCatalog().map((d) => [d.id, agentPresence(d)]));
    }));
    handle("agents:verify", wrap(async (_e, id: string) => {
      await applyShellEnvToProcess();
      const def = knownDef(String(id));
      return def ? verifyAgent(def) : { path: null };
    }));
    // Browser-tile extensions (prototype): load every UNPACKED extension in
    // <userData>/browser-extensions/<name>/ into the SAME session the <webview>
    // tiles use (partition "persist:browser"). Drop an unpacked extension dir
    // (one containing manifest.json) there and restart. NOTE: Electron implements
    // only a SUBSET of the chrome.* APIs — devtools + simple content-script / MV2
    // extensions work well; heavy MV3 (service-worker + declarativeNetRequest)
    // support is partial. Installed Chrome extensions can't be imported directly;
    // point this at extension SOURCE folders. Best-effort — a bad extension logs
    // and is skipped, never blocks startup.
    try {
      const extRoot = path.join(app.getPath("userData"), "browser-extensions");
      mkdirSync(extRoot, { recursive: true });
      const ses = session.fromPartition("persist:browser");
      let loaded = 0;
      for (const name of readdirSync(extRoot)) {
        const dir = path.join(extRoot, name);
        try {
          if (!statSync(dir).isDirectory() || !existsSync(path.join(dir, "manifest.json"))) continue;
          const ext = await ses.loadExtension(dir, { allowFileAccess: true });
          console.log(`[browser] loaded extension: ${ext.name} v${ext.version}`);
          loaded++;
        } catch (err) {
          console.warn(`[browser] skipped extension "${name}": ${(err as Error).message}`);
        }
      }
      if (loaded === 0) console.log(`[browser] no extensions — drop unpacked dirs in ${extRoot}`);
    } catch (err) {
      console.warn(`[browser] extension load failed: ${(err as Error).message}`);
    }

    // Wallpaper media is CONFINED to a sandboxed dir under userData. The
    // hm-media:// handler serves ONLY files inside it — never an arbitrary path
    // from the URL. Without this confinement the scheme is an arbitrary-file-read
    // primitive (e.g. hm-media://v/<encoded /etc/passwd>), reachable from the
    // untrusted web content a BrowserTile <webview> can load. Range-forwarded so
    // the video can seek/loop.
    // Beside settings.json, which names these files: a dev run keeps its own userData profile
    // but shares settings with the app, so media kept in userData was missing on the other side.
    const wallpaperDir = path.join(path.dirname(settingsFile()), "wallpapers");
    protocol.handle("hm-media", (request) => {
      try {
        const abs = path.resolve(decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, "")));
        if (abs !== wallpaperDir && !abs.startsWith(wallpaperDir + path.sep)) {
          return new Response("forbidden", { status: 403 });
        }
        if (!existsSync(abs) || !statSync(abs).isFile()) return new Response("not found", { status: 404 });
        return net.fetch(pathToFileURL(abs).toString(), { headers: request.headers });
      } catch {
        return new Response("bad request", { status: 400 });
      }
    });
    // Import a user-picked image/video INTO the sandboxed dir and return its
    // hm-media:// URL. Copying (a) confines what the protocol can ever read to
    // files the user explicitly chose, and (b) makes the wallpaper survive the
    // original being moved/deleted. The dest name is a hash of the source path
    // (+ext) so re-picking the same file is idempotent.
    // Classify a wallpaper file by extension so import can prune OLD files of the
    // same kind — only one video + one image can ever be active, so keeping every
    // file the user ever picked just leaked hundreds of MB into userData.
    const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".mkv", ".m4v", ".ogv"]);
    const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".bmp"]);
    const mediaKind = (f: string): "video" | "image" | null => {
      const e = path.extname(f).toLowerCase();
      return VIDEO_EXT.has(e) ? "video" : IMAGE_EXT.has(e) ? "image" : null;
    };
    handle("wallpaper:import", (_e, srcPath: unknown) => {
      try {
        const src = path.resolve(String(srcPath));
        if (!existsSync(src) || !statSync(src).isFile()) return null;
        mkdirSync(wallpaperDir, { recursive: true });
        // Keep the original basename (sanitized) so the customizer shows a
        // recognizable name; prefix a short hash of the source path for
        // uniqueness + idempotent re-pick.
        const base = path.basename(src).replace(/[^.\w-]/g, "_").slice(-60);
        const dest = path.join(wallpaperDir, `${createHash("sha1").update(src).digest("hex").slice(0, 8)}-${base}`);
        cpSync(src, dest);
        // Prune previously-imported files of the SAME kind (the just-replaced
        // wallpaper + any older orphans) — only the newest video/image is ever
        // referenced, so this caps the dir at one video + one image instead of
        // accumulating every pick forever.
        const kind = mediaKind(dest);
        if (kind) {
          for (const f of readdirSync(wallpaperDir)) {
            const abs = path.join(wallpaperDir, f);
            if (abs !== dest && mediaKind(abs) === kind) {
              try { unlinkSync(abs); } catch { /* best-effort */ }
            }
          }
        }
        return `hm-media://v/${encodeURIComponent(dest)}`;
      } catch {
        return null;
      }
    });

    // ── Custom-media layers (bring-your-own background + overlay) ─────────────
    // Files the user picks are COPIED into userData/media and served by bare
    // filename via hivemedia://<file>. Copying confines what the protocol can
    // ever read to files the user explicitly chose (never an arbitrary path from
    // the URL), and survives the original being moved/deleted.
    const mediaDir = path.join(path.dirname(settingsFile()), "media"); // beside settings.json (see wallpaperDir)
    protocol.handle("hivemedia", (request) => {
      try {
        // hivemedia://media/<filename> — the filename rides in the PATH (host is
        // the fixed marker "media"). Resolve against mediaDir, then verify it
        // never escaped the dir (path-traversal guard).
        const u = new URL(request.url);
        const rawName = u.pathname.replace(/^\/+/, "");
        const name = decodeURIComponent(rawName);
        const abs = path.resolve(mediaDir, name);
        if (abs !== mediaDir && !abs.startsWith(mediaDir + path.sep)) {
          return new Response("forbidden", { status: 403 });
        }
        if (!existsSync(abs) || !statSync(abs).isFile()) return new Response("not found", { status: 404 });
        return net.fetch(pathToFileURL(abs).toString(), { headers: request.headers });
      } catch {
        return new Response("bad request", { status: 400 });
      }
    });
    // Pick a media file for a given layer, copy it into userData/media under a
    // safe unique name, and return its hivemedia:// URL + classification. Returns
    // null if the user cancels.
    const MEDIA_VIDEO_EXT = new Set(["webm", "mp4", "mov"]);
    handle("media:pick", async (_e, slotRaw: unknown) => {
      // Slot key → a per-slot filename PREFIX: "background", or "overlay:<id>" — one of
      // many stacked overlays, each its OWN slot so a new/replaced overlay only prunes
      // ITS file, never a sibling's. The id is sanitized (it names a file + a prune glob).
      const slot = typeof slotRaw === "string" ? slotRaw : "";
      if (slot !== "background" && !slot.startsWith("overlay:")) return null;
      const prefix = slot === "background"
        ? "background"
        : `overlay-${slot.slice("overlay:".length).replace(/[^a-z0-9-]/gi, "").slice(0, 40) || "x"}`;
      const win = userWindow();
      if (!win) return null;
      const result = await dialog.showOpenDialog(win, {
        properties: ["openFile"],
        filters: [{ name: "Media", extensions: ["webm", "gif", "apng", "png", "jpg", "jpeg", "webp", "mp4", "mov"] }],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      const src = result.filePaths[0]!;
      try {
        if (!existsSync(src) || !statSync(src).isFile()) return null;
        mkdirSync(mediaDir, { recursive: true });
        // Sanitize the extension to a short alnum token; default to bin if odd.
        const rawExt = path.extname(src).replace(/^\./, "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "bin";
        const filename = `${prefix}-${Date.now()}.${rawExt}`;
        const dest = path.join(mediaDir, filename);
        cpSync(src, dest);
        // Prune older files for THIS slot only — only the newest is ever
        // referenced per slot, so this caps the dir without touching sibling
        // overlays (each has a distinct `overlay-<id>-` prefix).
        for (const f of readdirSync(mediaDir)) {
          if (f !== filename && f.startsWith(`${prefix}-`)) {
            try { unlinkSync(path.join(mediaDir, f)); } catch { /* best-effort */ }
          }
        }
        const kind = MEDIA_VIDEO_EXT.has(rawExt) ? "video" : "image";
        // Filename rides in the PATH under a fixed "media" host — a bare
        // `hivemedia://<filename>` would parse <filename> as the HOST (empty
        // path), which the handler can't resolve. See the handler above.
        return { url: `hivemedia://media/${filename}`, kind, name: path.basename(src) };
      } catch {
        return null;
      }
    });
    // Dev rebuild safety: if a daemon from an older build is still running,
    // replace it BEFORE the renderer attaches tiles, so new sessions carry the
    // current code (HCP/plan hooks + env injection). No-op in prod / when current.
    if (PERSIST_PTY) {
      try { await ptyDaemon.ensureFreshDaemon(); }
      catch (e) {
        // Best-effort, but a stale daemon means injected hooks may be wrong →
        // notifications themselves could silently break. Surface it once as a
        // non-blocking toast instead of swallowing entirely.
        pushAppError(`Couldn't refresh the PTY daemon: ${(e as Error).message ?? "unknown error"}`, "pty-daemon");
      }
    }
    void createWindow();
    // Native OS notifications for agents that need you — driven by the renderer's
    // agent-status bus over IPC (multi-agent, transition-deduped). Reads
    // The window the user is at, read lazily; gated on it not being focused inside the bridge.
    registerAgentNotifications(userWindow);
    startPlanReviewBridge();
    startHcpControlPlane();
    startViewHost();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  });
}

// ── plan review bridge ───────────────────────────────────────────────────────
// The injected PreToolUse(ExitPlanMode) hook connects to this unix socket when
// an agent hands off a plan. We hold the hook connection (via `reply`) until
// someone who may drive agents answers it over the workspace API (`plans.ts`:
// every window and every peer of the workspace is told). Socket path mirrors the
// one the daemon injects into the hook command (both derive from userData).
function startPlanReviewBridge(): void {
  const sock = ipcPath(app.getPath("userData"), "plan-bridge.sock");
  startPlanBridge(sock, (req: PlanRequest) => {
    if (openWindows().length === 0) { req.reply("allow"); return; } // fail-open: no UI
    // The agent waits on a person: that is its status until the review is answered or dropped.
    const bare = toBareId(req.tileId);
    control.status.event(bare, { event: "input.requested", kind: "plan" });
    plans.ask({ requestId: req.requestId, tileId: req.tileId, plan: req.plan, cwd: req.cwd }, (decision, feedback) => {
      control.status.event(bare, { event: "input.resolved" });
      req.reply(decision, feedback);
    });
    req.onAbort(() => {
      control.status.event(bare, { event: "input.resolved" });
      plans.drop(req.requestId);
    });
  });
}

// ── HCP: the control plane ───────────────────────────────────────────────────
// A 0600 unix socket where `hive ctl` (and any driver) drives the running app: spawn
// agents on the canvas, send them input, read their replies. Renderer verbs
// (tile.*) cross the request-id-correlated "hcp:command"/"hcp:result" channel
// (twin of plan-review). Main verbs (agent.send/read) run here against the
// recorder + turn tracker. The injected Stop hook reports finished turns.
const pendingHcp = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout }>();
/** Verbs every window carries out, each for its own workspace and lists (`hive views install`,
 *  `hive agents install`); the rest are for the window the user is at, which answers. */
const EVERY_WINDOW = new Set(["views.rescan", "agents.rescan"]);
function hcpCallRenderer(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
  const win = userWindow();
  if (!win) return Promise.reject(new HcpError("APP_NO_RENDERER", "hivemind window not open"));
  if (EVERY_WINDOW.has(method)) {
    for (const other of openWindows()) {
      if (other !== win) callWindow(other, method, params, timeoutMs).catch((e: unknown) => console.warn(`[hcp] ${method} in another window:`, e));
    }
  }
  return callWindow(win, method, params, timeoutMs);
}
function callWindow(win: BrowserWindow, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingHcp.delete(id);
      reject(new HcpError("TIMEOUT", `renderer verb ${method} timed out`));
    }, timeoutMs);
    pendingHcp.set(id, { resolve, reject, timer });
    win.webContents.send("hcp:command", { id, method, params });
  });
}
handle(
  "hcp:result",
  wrap(async (_e, id: string, ok: boolean, result: unknown, errorMessage?: string) => {
    const p = pendingHcp.get(id);
    if (!p) return;
    pendingHcp.delete(id);
    clearTimeout(p.timer);
    if (ok) p.resolve(result);
    else p.reject(new HcpError("INTERNAL", errorMessage || "renderer verb failed"));
  }),
);
/** View protocol 1.3 host services: the status ledger, presence, and sharing an image. */
function startViewHost(): void {
  let ledger: StatusLedger | null = new StatusLedger(path.join(app.getPath("userData"), "status-ledger"));
  try { ledger.boot(); } catch (e) { console.warn("[ledger] off:", e); ledger = null; }
  const totals = new Map<string, PresenceTotals>();
  const presence = new PresenceMonitor({
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    focused: () => openWindows().some((w) => w.isFocused()),
    dayOf: localDay,
    onChange: (p) => broadcast("presence:changed", p),
    onTotals: (day, t) => totals.set(day, t),
  });
  const persistTotals = () => { for (const [day, t] of totals) ledger?.setPresenceTotals(day, t); totals.clear(); };
  setInterval(() => presence.evaluate(), PRESENCE_POLL_MS).unref();
  setInterval(() => { ledger?.heartbeat(); persistTotals(); }, 60_000).unref();
  powerMonitor.on("lock-screen", () => presence.setLocked(true));
  powerMonitor.on("suspend", () => presence.setLocked(true));
  powerMonitor.on("unlock-screen", () => presence.setLocked(false));
  powerMonitor.on("resume", () => presence.setLocked(false));
  app.on("browser-window-focus", () => presence.evaluate());
  app.on("browser-window-blur", () => presence.evaluate());
  app.on("before-quit", () => { presence.evaluate(); persistTotals(); ledger?.stop(); });

  on("viewLedger:append", (_e, lines: unknown) => { if (Array.isArray(lines)) ledger?.append(lines.slice(0, 10_000)); });
  handle("viewLedger:snapshot", () => ledger?.snapshot() ?? []);
  handle("viewLedger:history", (_e, layoutKey: unknown, day: unknown) => {
    if (typeof layoutKey !== "string" || !isDay(day)) throw new Error("bad history request");
    if (!ledger) throw new Error("the status ledger is off");
    persistTotals();
    return ledger.history(layoutKey, day);
  });
  handle("presence:now", () => presence.current);

  const share = new ViewShare({
    reencode: (bytes) => {
      const img = nativeImage.createFromBuffer(Buffer.from(bytes));
      if (img.isEmpty()) return null;
      const { width, height } = img.getSize();
      return { png: img.toPNG(), width, height };
    },
    copy: (png) => clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(png))),
    chooseSavePath: async (name) => {
      const opts = { defaultPath: path.join(app.getPath("pictures"), name), filters: [{ name: "PNG image", extensions: ["png"] }] };
      const win = userWindow();
      const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
      return r.canceled || !r.filePath ? null : r.filePath;
    },
  });
  handle("viewShare:prepare", (_e, png: unknown) => {
    const buf = png instanceof ArrayBuffer ? png : ArrayBuffer.isView(png) ? png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer : null;
    if (!buf) throw new Error("not an image");
    return share.prepare(buf);
  });
  handle("viewShare:commit", (_e, token: unknown, action: unknown, name: unknown) => {
    if (typeof token !== "string" || (action !== "copy" && action !== "save" && action !== "cancel")) throw new Error("bad share request");
    return share.commit(token, action, typeof name === "string" ? name : "");
  });
}

function startHcpControlPlane(): void {
  // View protocol 1.4: a folder's past sessions, without what the agent wrote; a prompt the user
  // confirmed, delivered like `hive ctl send` (held while the agent is mid-turn).
  handle("view:sessions", async (_e, agentId: unknown, cwd: unknown) => {
    const def = typeof agentId === "string" ? agentById(agentId) : undefined;
    if (!def || typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new Error("bad sessions request");
    const rows = await listSessions(def, { cwd, limit: 100 });
    return rows.map((s) => ({ id: s.id, ...(s.updated ? { updated: s.updated } : {}), ...(s.prompt ? { prompt: s.prompt } : {}) }));
  });
  handle("view:prompt", async (_e, tileId: unknown, text: unknown) => {
    if (typeof tileId !== "string" || promptProblem(text)) throw new Error("bad prompt");
    await control.dispatch("agent.send", { tileId, text }, { actor: { kind: "person" } }); // the person at the window
  });
  control.listen(hcpSockPath(app.getPath("userData")), (err: Error) => pushAppError(`Agent control plane is off: ${err.message}. \`hive ctl\` cannot reach this app.`, "hcp"));
  // A machine's daemon keeps the status of the sessions it runs (R6): shown here as it has it.
  // Only a machine's own report does that: from then on the session's local reports are ignored.
  setRemoteEventSink((topic, data) => control.fromMachine(topic, data));
  ptyMod.setDaemonEventSink((method, params) => control.event(method, params));
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
  flushWorkspaceStore();
  try {
    session.defaultSession.flushStorageData();
  } catch {
    /* best-effort */
  }
  // A settings write still running (the window's last edit, sent as it closed) finishes
  // first: app.exit would cut it off.
  void settingsSettled(SETTINGS_QUIT_WAIT_MS).then(() => {
    const t = setTimeout(() => app.exit(0), 150);
    t.unref?.();
  });
}

/** How long quitting waits for a settings write: a write that has to wait for another
 *  writer's lock gives up after 5 s, so this is enough for it to finish either way. */
const SETTINGS_QUIT_WAIT_MS = 6_000;

// The normal quit (not daemon mode) waits for a settings write still running, once, then
// quits again: exiting mid-write loses the change and can leave settings.json's lock behind.
let settingsWaitedOnQuit = false;
app.on("will-quit", (e) => {
  if (settingsWaitedOnQuit || !settingsBusy()) return;
  e.preventDefault();
  settingsWaitedOnQuit = true;
  void settingsSettled(SETTINGS_QUIT_WAIT_MS).then(() => app.quit());
});

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
  flushWorkspaceStore();
  stopNetwork();
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
