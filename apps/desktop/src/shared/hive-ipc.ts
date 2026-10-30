/**
 * `window.hive` over the window's channels to main, whatever carries them: Electron's IPC in an app
 * window (preload), the browser server's socket in a tab (docs/design/browser-app-2026-10-13.md).
 * A channel main serves only to its own windows leaves its member out, so a tab has no member it
 * cannot use.
 */
import { WorkspaceClient } from "@hivemind/workspace-api/client";
import type { Answer, EventMessage } from "@hivemind/workspace-api/protocol";
import type { HiveApi } from "./ipc.js";
import { hiveOverWorkspace } from "./hive-over-workspace.js";
import { FRAME_EVENT, GONE_EVENT, SHOWN_EVENT, WATCHED_EVENT } from "./page-input.js";

/** One way to reach main's channels. */
export interface IpcPort {
  invoke(channel: string, ...args: unknown[]): Promise<any>;
  send(channel: string, ...args: unknown[]): void;
  sendSync(channel: string, ...args: unknown[]): any;
  /** Hear `channel`; the function returned stops. */
  on(channel: string, listener: (...args: any[]) => void): () => void;
  /** Main answers `channel` over this port. */
  serves(channel: string): boolean;
}

/** The workspace API (R8) over the port: calls on one channel, notices on another, events on a third. */
export function workspaceOver(port: IpcPort): WorkspaceClient {
  return new WorkspaceClient({
    call: (method, params) => port.invoke("workspace", method, params) as Promise<Answer>,
    notice: (method, params) => port.send("workspace:notice", method, params),
    events: (listener) => { port.on("workspace:event", (message: EventMessage) => listener(message)); },
  });
}

export function hiveOverIpc(port: IpcPort, workspace: WorkspaceClient): Omit<HiveApi, "platform" | "getPathForFile" | "resourceUrl"> {
  const invoke = (channel: string) => (...args: unknown[]) => port.invoke(channel, ...args);
  const send = (channel: string) => (...args: unknown[]) => port.send(channel, ...args);
  /** Only where main serves the channel over this port. */
  const local = <F>(channel: string, f: F): F | undefined => (port.serves(channel) ? f : undefined);
  return {
    ...hiveOverWorkspace(workspace),
    resolveProject: (rootHint) => port.invoke("resolveProject", rootHint),
    pickProjectFolder: local("pickProjectFolder", invoke("pickProjectFolder")),
    initWorkspace: (dir, prefix) => port.invoke("initWorkspace", dir, prefix),
    installAgentic: (dir) => port.invoke("installAgentic", dir),

    listWorkspaces: () => port.invoke("listWorkspaces"),
    workspaceSummaries: () => port.invoke("workspaceSummaries"),
    removeWorkspace: (repo) => port.invoke("removeWorkspace", repo),
    resolveIssueRoot: (id) => port.invoke("resolveIssueRoot", id),

    openPathInApp: local("openPathInApp", invoke("openPathInApp")),

    diagLog: (line) => port.invoke("diagLog", line),

    machinesGet: () => port.invoke("machines:get"),
    onMachines: (cb) => port.on("machines:changed", cb),
    machineAdd: (req) => port.invoke("machines:add", req),
    machineCheck: (id) => port.invoke("machines:check", id),
    machineUpdate: (id, patch) => port.invoke("machines:update", id, patch),
    machineEdit: (id, patch) => port.invoke("machines:edit", id, patch),
    viewLedgerAppend: (lines) => port.send("viewLedger:append", lines),
    viewLedgerSnapshot: () => port.invoke("viewLedger:snapshot"),
    viewHistory: (layoutKey, day) => port.invoke("viewLedger:history", layoutKey, day),
    presenceNow: () => port.invoke("presence:now"),
    onPresence: (cb) => port.on("presence:changed", cb),
    viewSharePrepare: local("viewShare:prepare", invoke("viewShare:prepare")),
    viewShareCommit: local("viewShare:commit", invoke("viewShare:commit")),

    machineRemove: (id) => port.invoke("machines:remove", id),
    machineSetPassword: (id, password) => port.invoke("machines:set-password", id, password),
    machineSessions: (uri) => port.invoke("machines:sessions", uri),
    machineReconnect: (hostId) => port.invoke("machines:reconnect", hostId),
    sshListDir: (uri, dir) => port.invoke("sshListDir", uri, dir),

    notifyAgent: local("notify:agent", send("notify:agent")),
    onSound: local("notify:sound-result", (cb) => port.on("notify:sound", cb)),
    soundResult: local("notify:sound-result", send("notify:sound-result")),
    themeSoundBytes: local("notify:theme-sound", invoke("notify:theme-sound")),
    notifyWidget: local("notify:widget", send("notify:widget")),
    layersShown: (repo, shown) => port.send("layers:shown", repo, shown),
    recentFolders: (folders) => port.send("recent:folders", folders),

    browserRegister: local("browser:register", send("browser:register")),
    browserCdp: local("browserCdp", invoke("browserCdp")),
    browserWatch: (tileId) => port.invoke("browserWatch", tileId),
    browserUnwatch: (tileId) => port.send("browserUnwatch", tileId),
    browserFrameShown: (tileId) => port.send("browserFrameShown", tileId),
    browserInput: (tileId, input) => port.invoke("browserInput", tileId, input),
    browserPick: (tileId, fx, fy) => port.invoke("browserPick", tileId, fx, fy),
    browserPickArea: (tileId, fx, fy, fw, fh) => port.invoke("browserPickArea", tileId, fx, fy, fw, fh),
    browserHighlight: (tileId, point) => port.invoke("browserHighlight", tileId, point),
    browserNote: (tileId, repoPath, note) => port.invoke("browserNote", tileId, repoPath, note),
    browserPins: (tileId, pins) => port.invoke("browserPins", tileId, pins),
    browserHoldStill: (tileId, still) => port.invoke("browserHoldStill", tileId, still),
    onBrowserFrame: (cb) => port.on(FRAME_EVENT, cb),
    onBrowserPageShown: (cb) => port.on(SHOWN_EVENT, cb),
    onBrowserPageGone: (cb) => port.on(GONE_EVENT, cb),
    onBrowserWatched: (cb) => port.on(WATCHED_EVENT, cb),
    answerBrowserPermission: local("browser:permission-answer", send("browser:permission-answer")),
    browserSiteRights: local("browser:site-rights", invoke("browser:site-rights")),
    setBrowserSiteRight: local("browser:set-site-right", invoke("browser:set-site-right")),
    getBrowserSettings: local("getBrowserSettings", invoke("getBrowserSettings")),
    setBrowserCdpEnabled: local("setBrowserCdpEnabled", invoke("setBrowserCdpEnabled")),
    relaunchApp: local("relaunchApp", invoke("relaunchApp")),
    quit: local("quit:ask", invoke("quit:ask")),
    quitAndStopEverything: local("quit:stop-everything", invoke("quit:stop-everything")),
    answerQuit: local("quit:answer", invoke("quit:answer")),
    onQuitAsk: (cb) => port.on("quit:ask", cb),
    identity: () => port.invoke("identity:get"),
    joinPreview: (text) => port.invoke("net:join-preview", text),
    join: (text) => port.invoke("net:join", text),
    joined: () => port.invoke("net:joined"),
    sharedStatus: (workspace) => port.invoke("net:shared-status", workspace),
    onSharedStatus: (cb) => port.on("net:shared-status", cb),
    sharedLooks: (workspace) => port.invoke("net:shared-looks", workspace),
    onSharedLooks: (cb) => port.on("net:shared-looks", cb),
    leave: (workspace) => port.invoke("net:leave", workspace),
    machineGrant: (workspace) => port.invoke("net:machine-grant", workspace),
    setMachineGrant: (workspace, grant) => port.invoke("net:set-machine-grant", workspace, grant),
    handOff: (workspace, uri) => port.invoke("net:hand-off", workspace, uri),
    browserAppStatus: () => port.invoke("browserApp:status"),
    onBrowserAppChanged: (cb) => port.on("browserApp:changed", cb),
    devices: () => port.invoke("net:devices"),
    onDevicesChanged: (cb) => port.on("net:devices-changed", () => cb()),
    phonePage: (page) => port.invoke("net:phone-page", page),
    connectOffer: (repo) => port.invoke("net:connect-offer", repo),
    connectCancel: () => port.invoke("net:connect-cancel"),
    connectState: () => port.invoke("net:connect-state"),
    onConnectChanged: (cb) => port.on("net:connect-changed", cb),
    connectAnswer: (id, answer) => port.invoke("net:connect-answer", id, answer),
    connectEnter: (text) => port.invoke("net:connect-enter", text),
    onConnectEntering: (cb) => port.on("net:connect-entering", cb),
    connectSure: (yes) => port.invoke("net:connect-sure", yes),
    pairEnter: (text) => port.invoke("net:pair-enter", text),
    unpair: (device) => port.invoke("net:unpair", device),
    deviceWorkspaces: () => port.invoke("net:device-workspaces"),
    openDeviceWorkspace: (device, workspace, name) => port.invoke("net:open-device-workspace", device, workspace, name),
    moveHosting: (repo, device) => port.invoke("net:move-hosting", repo, device),
    folderHere: (workspace) => port.invoke("net:folder-here", workspace),
    moveHostingHere: (workspace) => port.invoke("net:move-hosting-here", workspace),
    takeOver: (workspace) => port.invoke("net:take-over", workspace),
    network: () => port.invoke("net:network"),
    networkHealth: () => port.invoke("net:network-health"),
    useNetwork: (given) => port.invoke("net:use-network", given),
    onNetworkChanged: (cb) => port.on("net:network-changed", () => cb()),
    getAppVersion: () => port.invoke("getAppVersion"),
    settingsSync: () => port.sendSync("settings:get-sync"),
    workspaceCoreSync: (repo) => port.sendSync("workspace:core-sync", repo),
    workspaceViewSync: (repo, viewId) => port.sendSync("workspace:view-sync", repo, viewId),
    workspaceSetCoreSync: (repo, core, base) => { port.sendSync("workspace:set-core-sync", repo, core, base); },
    workspaceSetViewSync: (repo, viewId, layout, base) => { port.sendSync("workspace:set-view-sync", repo, viewId, layout, base); },
    workspaceImportSync: (repo, legacy) => { port.sendSync("workspace:import-sync", repo, legacy); },
    workspaceObjectsSync: (repo) => port.sendSync("workspace:objects-sync", repo),
    workspaceObjectsWithIdsSync: (repo, ids) => port.sendSync("workspace:objects-with-ids-sync", repo, ids),
    workspaceEditObjectsSync: (repo, edit) => { port.sendSync("workspace:edit-objects-sync", repo, edit); },
    workspaceUndoSync: (repo) => port.sendSync("workspace:undo-sync", repo),
    workspaceRedoSync: (repo) => port.sendSync("workspace:redo-sync", repo),
    settingsGet: () => port.invoke("settings:get"),
    settingsSet: (p, v) => port.invoke("settings:set", p, v),
    settingsPatch: (patches) => port.invoke("settings:patch", patches),
    settingsPath: () => port.invoke("settings:path"),
    onSettingsChanged: (cb) => port.on("settings:changed", cb),
    listViews: (repoRoot) => port.invoke("views:list", repoRoot),
    listWallpapers: () => port.invoke("wallpapers:list"),
    onWallpapersChanged: (cb) => port.on("wallpapers:changed", () => cb()),
    listAgents: (repoRoot) => port.invoke("agents:list", repoRoot),
    agentOptionChoices: (id) => port.invoke("agents:option-choices", id),
    agentPresence: () => port.invoke("agents:presence"),
    verifyAgent: (id) => port.invoke("agents:verify", id),
    pluginCatalog: () => port.invoke("plugins:catalog"),
    pluginCatalogSkipped: () => port.invoke("plugins:catalog-skipped"),
    pluginReadme: (from) => port.invoke("plugins:readme", from),
    listWidgets: () => port.invoke("widgets:list"),
    removeWidget: (id) => port.invoke("widgets:remove", id),
    onWidgetsChanged: (cb) => port.on("widgets:changed", () => cb()),
    toolPackages: () => port.invoke("tools:list"),
    toolHostExports: (map) => port.invoke("tools:host-exports", map),
    removeToolPackage: (id) => port.invoke("tools:remove", id),
    toolRun: (call) => port.invoke("tools:run", call),
    onToolsChanged: (cb) => port.on("tools:changed", () => cb()),
    services: () => port.invoke("services:list"),
    serviceLog: (plugin) => port.invoke("services:log", plugin),
    onServicesChanged: (cb) => port.on("services:changed", () => cb()),
    outdatedAgents: () => port.invoke("plugins:outdated"),
    reviewCatalogPlugin: (type, id) => port.invoke("plugins:review", type, id),
    installCatalogAgent: (token) => port.invoke("plugins:install-agent", token),
    installCatalogWidget: (token) => port.invoke("plugins:install-widget", token),
    installCatalogTool: (token) => port.invoke("plugins:install-tool", token),
    installCatalogPackage: (token) => port.invoke("plugins:install-package", token),
    removeAgent: (id) => port.invoke("agents:remove", id),
    autoInstallAgents: () => port.invoke("agents:auto-install"),
    installViewPackage: (token) => port.invoke("views:install", token),
    removeViewPackage: (id) => port.invoke("views:remove", id),
    switchPlugin: (kind, id, on) => port.invoke("plugins:switch", kind, id, on),
    installedPackages: () => port.invoke("plugins:packages"),
    switchPackage: (id, on) => port.invoke("plugins:switch-package", id, on),
    rollbackPackage: (id) => port.invoke("plugins:rollback", id),
    reviewPackageFolder: local("plugins:review-folder", invoke("plugins:review-folder")),
    installPackageFolder: local("plugins:install-folder", invoke("plugins:install-folder")),
    startViewOffers: local("plugins:start-view-offers", invoke("plugins:start-view-offers")),
    onViewRunaway: (cb) => port.on("views:runaway", cb),
    checkForUpdate: local("checkForUpdate", invoke("checkForUpdate")),
    whatsNew: local("whatsNew", invoke("whatsNew")),
    releaseNotes: local("releaseNotes", invoke("releaseNotes")),
    runUpgrade: local("runUpgrade", invoke("runUpgrade")),
    onUpdateProgress: (cb) => port.on("update:progress", cb),
    onBrowserPopup: (cb) => port.on("browser:popup", cb),
    onBrowserPermission: (cb) => port.on("browser:permission", cb),

    // Main takes the app's keys before the page (a terminal would otherwise have them) and sends
    // each as the keymap action it is.
    onMenuShortcut: (cb) => port.on("menu:shortcut", cb),

    getLaunchTarget: local("getLaunchTarget", invoke("getLaunchTarget")),
    newWindow: local("window:new", invoke("window:new")),
    onOpenProject: (cb) => port.on("open-project", cb),

    // HCP control plane: main pushes a canvas verb, the window runs it and replies.
    hcpResult: local("hcp:result", invoke("hcp:result")),
    onHcpCommand: (cb) => port.on("hcp:command", cb),
    onAppError: (cb) => port.on("app:error", cb),
    daemonWaitingOn: local("daemon:waiting", invoke("daemon:waiting")),
    onDaemonWaiting: (cb) => port.on("daemon:waiting", cb),
    restartAgentsNow: local("daemon:restart-now", invoke("daemon:restart-now")),
    commandsRestartStops: local("daemon:commands", invoke("daemon:commands")),
    pickMedia: local("media:pick", invoke("media:pick")),
    themes: port.serves("themes:list") ? {
      list: () => port.invoke("themes:list"),
      apply: (id: string) => port.invoke("themes:apply", id),
      revert: () => port.invoke("themes:revert"),
    } : undefined,
  };
}
