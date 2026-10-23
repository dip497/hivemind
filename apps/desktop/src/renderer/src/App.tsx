import * as SettingsDialog from "@radix-ui/react-dialog";
import { ThemePanel } from "./ThemePanel";
import { QuitDialog } from "./QuitDialog";
import { QuitSetting } from "./quit-setting";
import { RecentProjects } from "./RecentProjects";
import { WorkspaceActions } from "./multiplayer/workspace-actions";
import { AppControls } from "./workspace/app-controls";
import { useChromeState } from "./workspace/chrome-store";
import { SharedBanner } from "./multiplayer/shared-banner";
import { ShownWorkspaceProvider } from "./multiplayer/shown";
import { setWorkspaceOccluded } from "./workspace-occlusion";
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { UPDATE_START, UPDATE_STEPS, updateProgress, type UpdateProgress } from "../../shared/update-progress";
import { Bell, ExternalLink, Spinner, X, Palette, PanelsTopLeft, Bot, Keyboard, Info } from "./components/icons";
import { Button } from "./components/ui/button";
import { Loading } from "./components/ui/loading";
import { preloadable } from "./lib/preloadable";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Switch } from "./components/ui/switch";
import path from "path-browserify";
import type { UpdateStatus } from "../../shared/ipc";
import {
  inElectron,
  useFsChangedInvalidation,
  useProject,
} from "./queries";
import { Workspace } from "./Workspace";
import { resolveSettingsPage } from "./settings-registry";
import { TileErrorBoundary } from "./TileErrorBoundary";
import { flushSettings } from "./settings-store";
import { useSettingsNav } from "./settings-nav";
import { UpdateCheckSwitch } from "./update-check";
import { getNotificationSettings, setNotificationSettingsCache, subscribeNotificationSettings, saveNotificationSettings } from "./notification-settings";
import type { NotificationSettings } from "../../shared/ipc";
import { tellRecentFolders } from "./recent-folders";
import { chooseFolder, FolderPathDialog } from "./choose-folder";
import { runShortcut } from "./shortcut";
import { StatusAnnouncer } from "./workspace/StatusAnnouncer";
import { LOOKS } from "./workspace/status-look";
const SettingsPages = preloadable(() => import("./settings-panels").then((m) => m.default));
// Sharing's dialogs load when opened: they are nothing the first frame draws.
const MakePluginDialog = lazy(() => import("./plugins/MakePlugin").then((m) => ({ default: m.MakePluginDialog })));

// Last 8 opened folders, most recent first. Persisted via localStorage —
// mirrors VSCode's "Open Recent" (Ctrl+R) behavior at workspace granularity.
const RECENT_KEY = "hivemind:recent-projects";
const RECENT_MAX = 8;
function loadRecents(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}
function pushRecent(path: string): string[] {
  const cur = loadRecents().filter((p) => p !== path);
  const next = [path, ...cur].slice(0, RECENT_MAX);
  window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  tellRecentFolders();
  return next;
}

/** GitHub-release update check, owned at the App level so the Settings
 *  dialog (full status) and the canvas "Update available" pill share ONE check.
 *  The fetch runs in main (renderer CSP blocks api.github.com); the last result
 *  is cached in localStorage so the affordance survives a reload, then re-checked
 *  on mount + every few hours. A failed check (offline/rate-limit) → no update. */
function useUpdateCheck() {
  const [version, setVersion] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<UpdateStatus | null>(() => {
    try {
      const raw = localStorage.getItem("hivemind:update");
      return raw ? (JSON.parse(raw) as UpdateStatus) : null;
    } catch { return null; }
  });
  // Dedupe concurrent checks (opening Settings + mount + interval can overlap)
  // and throttle: unauthenticated GitHub API is 60 req/hr/IP, so hammering it
  // on every Settings open earns a 403 that used to masquerade as "up to date".
  const checkingRef = useRef(false);
  const lastOkCheckRef = useRef(0);
  const MIN_CHECK_INTERVAL = 60_000;
  const check = useCallback(async (opts?: { force?: boolean }) => {
    if (!window.hive?.checkForUpdate) return;
    if (checkingRef.current) return; // already in flight
    if (!opts?.force && Date.now() - lastOkCheckRef.current < MIN_CHECK_INTERVAL) return;
    checkingRef.current = true;
    setChecking(true);
    try {
      const s = await window.hive.checkForUpdate();
      // Only a COMPLETED check updates state/cache. A failed one (offline,
      // timeout, rate-limit) must NOT overwrite a known-good result or flip the
      // banner — we keep the last trustworthy status and just stop "Checking…".
      if (s.ok) {
        lastOkCheckRef.current = Date.now();
        setStatus(s);
        try { localStorage.setItem("hivemind:update", JSON.stringify(s)); } catch { /* quota */ }
      }
    } catch { /* main never rejects; ignore */ }
    finally { checkingRef.current = false; setChecking(false); }
  }, []);
  useEffect(() => {
    void window.hive?.getAppVersion?.().then(setVersion).catch(() => {});
    void check({ force: true });
    const id = window.setInterval(() => { void check({ force: true }); }, 4 * 60 * 60 * 1000);
    return () => window.clearInterval(id);
  }, [check]);
  // Upgrade flow with real feedback: a live progress toast (installer output),
  // then either a "restarting…" success that relaunches through the launcher
  // (applying the staged build → the NEW version actually loads), or an error
  // toast that keeps the app open. Guarded against double-clicks (the pill, the
  // Settings button, and the toast action all call this).
  const [upgrading, setUpgrading] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const upgradingRef = useRef(false);
  const restart = useCallback(() => {
    toast.loading("Restarting into the new version…");
    window.setTimeout(() => { void window.hive.relaunchApp?.(); }, 600);
  }, []);
  const upgrade = useCallback(() => {
    if (upgradingRef.current || !window.hive?.runUpgrade) return;
    upgradingRef.current = true;
    setUpgrading(true);
    setProgress(UPDATE_START);
    // The installer's own lines are written for a terminal; the app says which step they mean.
    const off = window.hive.onUpdateProgress?.((line) => setProgress((p) => updateProgress(line, p ?? UPDATE_START)));
    const done = () => { off?.(); upgradingRef.current = false; setUpgrading(false); };
    window.hive
      .runUpgrade()
      .then((r) => {
        off?.();
        if (!r.ok) {
          setProgress(null);
          toast.error(`Update failed (exit ${r.code ?? "?"}). Run \`hivemind upgrade\` in a terminal.`, { duration: 8000 });
          done();
          return;
        }
        // Downloaded beside a running app: it becomes this app at the next restart, and the
        // user decides when. Installed in place: restart now, into the version just installed.
        setProgress((p) => ({ ...(p ?? UPDATE_START), step: "done" }));
        upgradingRef.current = false;
        setUpgrading(false);
        void check({ force: true });
      })
      .catch(() => { toast.error("Update failed to start."); setProgress(null); done(); });
  }, [check]);
  return { version, status, checking, check, upgrade, upgrading, progress, restart };
}

export function App() {
  // "Open project" flow: rootHint flips when the user picks a folder; the
  // useProject query refetches because rootHint is part of its key. We
  // persist the last opened path in localStorage so the next launch reopens
  // the same workspace instead of falling back to process.cwd().
  const [rootHint, setRootHint] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem("hivemind:last-project") ?? null;
  });
  const [recents, setRecents] = useState<string[]>(() => loadRecents());
  const { data: project, isLoading } = useProject(rootHint);
  async function pickFolder() {
    const picked = await chooseFolder();
    if (!picked) return;
    window.localStorage.setItem("hivemind:last-project", picked);
    setRecents(pushRecent(picked));
    setRootHint(picked);
  }
  function openRecent(path: string) {
    window.localStorage.setItem("hivemind:last-project", path);
    setRecents(pushRecent(path));
    setRootHint(path);
  }

  // CLI launch target: `hivemind .` / `hivemind /repo` opens THAT repo, taking
  // precedence over the persisted last-project. Also listen for a second
  // `hivemind <path>` invocation switching the already-open window.
  useEffect(() => {
    let mounted = true;
    void window.hive.getLaunchTarget?.().then((target) => {
      if (mounted && target) openRecent(target);
    });
    const off = window.hive.onOpenProject?.((p) => openRecent(p));
    return () => {
      mounted = false;
      off?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Settings' code is fetched while nothing else is happening, so opening it never waits.
  useEffect(() => {
    // Safari has no requestIdleCallback.
    if (typeof requestIdleCallback !== "function") {
      const id = setTimeout(() => void SettingsPages.preload(), 1000);
      return () => clearTimeout(id);
    }
    const id = requestIdleCallback(() => void SettingsPages.preload());
    return () => cancelIdleCallback(id);
  }, []);
  const root = project?.root ?? null;
  const cwd = project?.cwd ?? "";
  // Prefer the explicit repoPath from main (handles the no-.hivemind case
  // where we still discovered a .git/ ancestor); fall back to deriving from
  // root for older builds.
  const repoPath = project?.repoPath ?? (root ? path.dirname(root) : null);
  useFsChangedInvalidation(repoPath, root);
  // Ctrl+O / Ctrl+R on the canvas (useCanvasShortcuts): VS Code's Open Folder and Open Recent.
  // Which page of the Recent dialog is open: its list, or joining a workspace shared with you.
  const [recentOpen, setRecentOpen] = useState<"recent" | "join" | null>(null);
  const { islandShown, layersShown } = useChromeState();
  // Make your own plugin (the Add menu, Settings ▸ Plugins): a prompt to copy or hand an agent here.
  const [making, setMaking] = useState<"widget" | "tool" | "view" | null>(null);
  useEffect(() => {
    const open = (e: Event) => { setSettingsOpen(false); setMaking((e as CustomEvent<{ kind?: "widget" | "tool" | "view" }>).detail?.kind ?? "widget"); };
    window.addEventListener("hivemind:make-plugin", open);
    return () => window.removeEventListener("hivemind:make-plugin", open);
  }, []);
  useEffect(() => {
    const onFolder = () => void pickFolder();
    // One dialog at a time: Join from Settings → Connect closes Settings.
    const onRecent = (e: Event) => { setSettingsOpen(false); setRecentOpen((e as CustomEvent<{ join?: boolean }>).detail?.join ? "join" : "recent"); };
    // The Layers panel's Projects: this window shows that workspace instead.
    const onWorkspace = (e: Event) => { const repo = (e as CustomEvent<{ repo?: string }>).detail?.repo; if (repo) openRecent(repo); };
    // An agent started from Settings (set it up with an agent): the agent is shown.
    const onAgent = () => setSettingsOpen(false);
    window.addEventListener("hivemind:spawn-agent", onAgent);
    window.addEventListener("hivemind:open-folder", onFolder);
    window.addEventListener("hivemind:open-recent", onRecent);
    window.addEventListener("hivemind:open-workspace", onWorkspace);
    return () => {
      window.removeEventListener("hivemind:spawn-agent", onAgent);
      window.removeEventListener("hivemind:open-folder", onFolder);
      window.removeEventListener("hivemind:open-recent", onRecent);
      window.removeEventListener("hivemind:open-workspace", onWorkspace);
    };
  });
  const [settingsOpen, setSettingsOpen] = useState(false);

  const update = useUpdateCheck();
  const qc = useQueryClient();
  /** Open `path` where it is now, after its hosting moved (M3): the same folder may open from
   *  elsewhere than it did a moment ago. */
  const openMoved = (path: string) => {
    openRecent(path);
    void qc.invalidateQueries({ queryKey: ["project", path] });
  };
  // Settings → Connect hands this on: Settings closes for the moved workspace.
  useEffect(() => {
    const moved = (event: Event) => { setSettingsOpen(false); openMoved((event as CustomEvent<{ uri: string }>).detail.uri); };
    window.addEventListener("hivemind:open-moved", moved);
    return () => window.removeEventListener("hivemind:open-moved", moved);
  });

  // A plugin set issues up in a folder: the workspace there now has a `.hivemind`, so read it again,
  // in place (a new project key would show the loading screen and remount the workspace).
  useEffect(() => {
    const onSetUp = (event: Event) => {
      const { dir } = (event as CustomEvent<{ dir: string }>).detail;
      if (dir === (repoPath ?? cwd)) { window.localStorage.setItem("hivemind:last-project", dir); setRecents(pushRecent(dir)); }
      void qc.invalidateQueries({ queryKey: ["project"] });
    };
    window.addEventListener("hivemind:issues-set-up", onSetUp);
    return () => window.removeEventListener("hivemind:issues-set-up", onSetUp);
  });

  // Load the persisted notification preferences into the renderer cache once on
  // mount, so useAgentAwareness's in-app-toast gate reads the real values
  // (defaults until this resolves). The SettingsModal refreshes the cache on
  // every write, so no relaunch is needed for a toggle to take effect.
  useEffect(() => {
    void window.hive.getNotificationSettings().then(setNotificationSettingsCache).catch(() => {});
  }, []);

  // Surface non-fatal background-subsystem errors (pushed by main over app:error)
  // as a sonner toast instead of letting them die in a console.error. These are
  // the "something is degraded but the app still runs" cases — e.g. a stale PTY
  // daemon that breaks agent hook injection. Distinct from agent-status toasts.
  useEffect(() => {
    if (!window.hive.onAppError) return;
    return window.hive.onAppError((e) => {
      toast.error(e.message, { description: e.source, duration: 9000 });
    });
  }, []);

  // A terminal daemon of another protocol waits for agents to finish their turns before it is replaced.
  useEffect(() => {
    const show = (ids: string[] | null) => {
      if (!ids) return void toast.dismiss("daemon-waiting");
      toast.loading("Updating how terminals run", {
        id: "daemon-waiting",
        description: `Waiting for ${ids.length === 1 ? "an agent to finish its turn" : `${ids.length} agents to finish their turns`}; each comes back in the same conversation.`,
        action: { label: "Restart them now", onClick: () => void window.hive.restartAgentsNow?.() },
        duration: Infinity,
      });
    };
    void window.hive.daemonWaitingOn?.().then(show).catch(() => {});
    return window.hive.onDaemonWaiting(show);
  }, []);

  // A new app version landed → ping once (not every 4h re-check). Only when the
  // master notification preference is on; the toolbar's update button always shows it
  // regardless. Uses the sonner action surface (an inline Update button) since
  // an update is an actionable confirmation, not an agent-status event.
  const announcedUpdateRef = useRef(false);
  useEffect(() => {
    if (!update.status?.updateAvailable || announcedUpdateRef.current) return;
    announcedUpdateRef.current = true;
    if (!getNotificationSettings().enabled) return;
    toast.success(`Update available${update.status.latest ? ` — v${update.status.latest}` : ""}`, {
      description: "Restart to install the new version.",
      action: { label: "Update & restart", onClick: update.upgrade },
      duration: 12000,
    });
  }, [update.status, update.upgrade]);

  // The keys main took before the page (they work from inside a terminal) run here as actions.
  useEffect(() => window.hive?.onMenuShortcut?.((action) => { runShortcut(action); }), []);

  if (isLoading) {
    return <Loading className="h-screen" label="Opening the workspace" />;
  }

  return (
    <ShownWorkspaceProvider repo={repoPath}>
      <div className="h-screen w-screen overflow-hidden bg-[var(--color-bg)]">
        {/* Canvas-only workspace. The canvas is full-bleed; floating chrome sits
            on top — frame = workspace, so the per-Frame "+ workspace" bind is the
            canonical add-a-workspace action; Open/Init/Recents live in the sidebar. */}
        <div className="fixed inset-0 z-(--layer-app) bg-[var(--color-bg)]">
          <Workspace
            cwd={cwd}
            repoPath={repoPath}
            root={root}
            updateAvailable={update.status?.updateAvailable === true}
            updateStaged={!!update.status?.staged}
            onUpgrade={update.upgrade}
            onRestart={update.restart}
            upgrading={update.upgrading}
          />
          <div className="absolute top-0 right-0 z-(--layer-workspace-actions) flex items-start gap-2 px-3 py-2.5 pointer-events-none">
            <SharedBanner onMoved={openMoved} />
            <WorkspaceActions onPeople={() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "connect" } }))} />
            {!islandShown && !layersShown && <AppControls corner />}
          </div>
        </div>

        <FolderPathDialog />
        <QuitDialog />
        <StatusAnnouncer />
        <RecentProjects
          open={!!recentOpen}
          joining={recentOpen === "join"}
          recents={recents}
          current={repoPath}
          onOpen={openRecent}
          onBrowse={() => void pickFolder()}
          onNewWindow={() => void (window.hive.newWindow ? window.hive.newWindow() : window.open(window.location.href, "_blank"))}
          onClose={() => setRecentOpen(null)}
        />
        <Suspense fallback={null}>
          {making && <MakePluginDialog kind={making} onClose={() => setMaking(null)}
            onStart={(prompt) => window.dispatchEvent(new CustomEvent("hivemind:deliver-to-agent", { detail: { text: prompt } }))} />}
        </Suspense>
        <ThemePanel />
        <SettingsModal
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          version={update.version}
          update={update.status}
          checking={update.checking}
          onCheck={(opts) => { void update.check(opts); }}
          onUpgrade={update.upgrade}
          upgrading={update.upgrading}
          progress={update.progress}
          onRestart={update.restart}
        />
      </div>
    </ShownWorkspaceProvider>
  );
}

const REPO_URL = "https://github.com/dip497/hivemind";

/** What the installer is doing, and the one thing left to do when it is finished: a bar that
 *  fills to the step it reached, so a download that stalls stops moving instead of pretending. */
function UpdateWork({ progress, busy, onRestart }: { progress: UpdateProgress | null; busy: boolean; onRestart: () => void }) {
  const p = progress ?? UPDATE_START;
  const filled = ((UPDATE_STEPS.indexOf(p.step) + 1) / UPDATE_STEPS.length) * 100;
  const ready = p.step === "done" && !busy && !p.blocked;
  return (
    <>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-label text-[var(--color-fg)]">
          {busy && <Spinner className="size-3 animate-spin text-[var(--color-fg2)]" />}
          <span className="truncate">{p.label}</span>
        </div>
        <div className="hm-update-bar mt-1.5" data-busy={busy ? "1" : "0"} role="progressbar"
          aria-valuemin={0} aria-valuemax={UPDATE_STEPS.length} aria-valuenow={UPDATE_STEPS.indexOf(p.step) + 1} aria-label={p.label}>
          <span style={{ transform: `scaleX(${filled / 100})` }} />
        </div>
      </div>
      {ready && <Button onClick={onRestart} size="xs" title="Restart into the new version">Restart</Button>}
    </>
  );
}

/** A status word as a label: "needs you" → "Needs you". */
const sentence = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

function NotificationPrefs() {
  const [s, setS] = useState<NotificationSettings>(() => getNotificationSettings());
  useEffect(() => subscribeNotificationSettings(setS), []);

  const update = (patch: Partial<NotificationSettings>): void => {
    const next = { ...s, ...patch };
    setS(next); // optimistic — the cache subscriber will re-sync on confirm
    void saveNotificationSettings(next);
  };
  const dim = !s.enabled;

  const kinds: { key: "needs" | "done" | "error"; label: string; hint: string }[] = [
    { key: "needs", label: sentence(LOOKS.needs.word), hint: "Permission prompts, questions, plans to review, blocked" },
    { key: "done", label: sentence(LOOKS.done.word), hint: "An agent completed its task" },
    { key: "error", label: sentence(LOOKS.failed.word), hint: "Agent crashed or exited non-zero" },
  ];

  return (
    <div className="settings-section">
      <div className="settings-row">
        <div className="flex items-center gap-2">
          <Bell size={14} className="text-[var(--color-fg2)]" />
          <span className="text-body font-medium text-[var(--color-fg)]">Notifications</span>
        </div>
        <Switch checked={s.enabled} onCheckedChange={(v) => update({ enabled: v })} aria-label="Enable notifications" />
      </div>

      {/* Per-kind mute — which agent transitions reach you. */}
      <div className="settings-section">
        <div className="settings-subheading">Notify me about</div>
        {kinds.map((k) => (
          <div key={k.key} className="settings-row">
            <div className="min-w-0">
              <div className="text-label text-[var(--color-fg)]">{k.label}</div>
              <div className="settings-note">{k.hint}</div>
            </div>
            <Switch
              disabled={dim}
              checked={s.kinds[k.key]}
              onCheckedChange={(v) => update({ kinds: { ...s.kinds, [k.key]: v } })}
              aria-label={`Notify on ${k.label}`}
            />
          </div>
        ))}
      </div>

      {/* Surface choice — in-app toast vs. native OS popup, independent. */}
      <div className="settings-section">
        <div className="settings-subheading">Delivery</div>
        <div className="settings-row">
          {/* The window's live region (workspace/announcer.ts) follows this switch as a toast does. */}
          <div className="min-w-0">
            <div className="text-label text-[var(--color-fg)]">In-app toasts</div>
            <div id="notify-in-app-note" className="settings-note">Also what a screen reader says</div>
          </div>
          <Switch disabled={dim} checked={s.inApp} onCheckedChange={(v) => update({ inApp: v })} aria-label="In-app toasts" aria-describedby="notify-in-app-note" />
        </div>
        <div className="settings-row">
          <div className="text-label text-[var(--color-fg)]">Native OS popups</div>
          <Switch disabled={dim} checked={s.osPopups} onCheckedChange={(v) => update({ osPopups: v })} aria-label="Native OS popups" />
        </div>
      </div>

      {/* Do-Not-Disturb — mutes finished/failed (NOT needs-you) during a window. */}
      <div className="settings-section">
        <div className="settings-row">
          <div className="min-w-0">
            <div className="text-label text-[var(--color-fg)]">Do Not Disturb</div>
            <div className="settings-note">Mutes finished/failed; needs-you still fires</div>
          </div>
          <Switch disabled={dim} checked={s.dnd.enabled} onCheckedChange={(v) => update({ dnd: { ...s.dnd, enabled: v } })} aria-label="Do Not Disturb" />
        </div>
        {s.dnd.enabled && (
          <div className="mt-2 flex items-center gap-2">
            <Input
              type="time"
              disabled={dim}
              value={s.dnd.start}
              onChange={(e) => update({ dnd: { ...s.dnd, start: e.target.value } })}
              className="w-auto"
              aria-label="DND start"
            />
            <span className="text-count text-[var(--color-fg2)]">to</span>
            <Input
              type="time"
              disabled={dim}
              value={s.dnd.end}
              onChange={(e) => update({ dnd: { ...s.dnd, end: e.target.value } })}
              className="w-auto"
              aria-label="DND end"
            />
            <span className="text-chip text-[var(--color-fg2)] ml-auto">local time</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** App settings dialog. Houses the About section (version, repo, license,
 *  update status) + the agent-browser CDP bridge toggle — opt-in because a
 *  debug port also exposes the app window. The bridge can only be (de)activated
 *  at launch, so the toggle persists the choice and offers a relaunch to apply. */
function SettingsModal({
  open,
  onOpenChange,
  version,
  update,
  checking,
  onCheck,
  onUpgrade,
  upgrading,
  progress,
  onRestart,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Running app version (null until main answers). */
  version: string | null;
  /** Latest update check result, or null if it hasn't run / failed silently. */
  update: UpdateStatus | null;
  /** A check is in flight. */
  checking: boolean;
  /** Re-run the update check. Pass `{force:true}` to bypass the throttle. */
  onCheck: (opts?: { force?: boolean }) => void;
  /** Run the installer, stream progress, then restart into the new version. */
  onUpgrade: () => void;
  /** An upgrade is in flight — disable the button + show a spinner. */
  upgrading: boolean;
  /** Which of the installer's steps is happening, or null when none is. */
  progress: UpdateProgress | null;
  /** Restart into a version that is downloaded and waiting. */
  onRestart: () => void;
}) {
  const [page, setPage] = useState("appearance");
  const nav = useSettingsNav();
  const go = useCallback((id: string) => setPage(resolveSettingsPage(id) ?? id), []);
  const settingsReturnFocus = useRef<HTMLElement | null>(null);
  const settingsNav = useRef<HTMLElement | null>(null);
  // Focus in the sidebar follows the page shown, however it changed, so its ring is never on another.
  useEffect(() => {
    const nav = settingsNav.current;
    if (nav?.contains(document.activeElement)) nav.querySelector<HTMLElement>('[aria-current="page"]')?.focus({ preventScroll: true });
  }, [page]);
  useEffect(() => {
    setWorkspaceOccluded(open);
    return () => setWorkspaceOccluded(false);
  }, [open]);
  // Closing Settings writes what was changed there now, so a later write can't be overtaken by it.
  useEffect(() => { if (!open) flushSettings(); }, [open]);
  useEffect(() => {
    const openPage = (event: Event) => {
      const target = resolveSettingsPage((event as CustomEvent<{ page?: string }>).detail?.page ?? "");
      if (target) setPage(target);
      onOpenChange(true);
    };
    window.addEventListener("hivemind:open-settings", openPage);
    return () => window.removeEventListener("hivemind:open-settings", openPage);
  }, [onOpenChange]);
  useEffect(() => {
    if (!open) return;
    // Every time Settings opens, re-check for updates so the panel reflects the
    // latest release — not a cached result from the last mount / 4h interval.
    onCheck();
  }, [open, onCheck]);

  return (
    <SettingsDialog.Root open={open} onOpenChange={onOpenChange}>
      <SettingsDialog.Portal>
        <SettingsDialog.Overlay className="settings-overlay" />
        <SettingsDialog.Content className="settings-dialog" aria-describedby="settings-description"
          onOpenAutoFocus={(event) => {
            settingsReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            // Start on the section it opened at, not the first one.
            const current = (event.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>('nav [aria-current="page"]');
            if (current) { event.preventDefault(); current.focus({ preventScroll: true }); }
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = settingsReturnFocus.current;
            // The toolbar's Settings, else the Layers rail's.
            (target?.isConnected ? target : document.querySelector<HTMLElement>('[aria-label="settings"]') ?? document.querySelector<HTMLElement>('[data-layers-rail="settings"]'))?.focus({ preventScroll: true });
          }}
        >
          <aside className="settings-sidebar">
            <SettingsDialog.Title className="settings-title">Settings</SettingsDialog.Title>
            <nav aria-label="Settings sections" ref={settingsNav}>
              {nav.groups.map(({ group, items }) => (
                <div key={group} className="settings-nav-group" role="group" aria-label={group}>
                  <h3 className="settings-nav-heading"><span className="settings-nav-heading-text">{group}</span></h3>
                  {items.map((item) => <button key={item.id} onClick={() => setPage(item.id)} aria-current={nav.selected(page) === item.id ? "page" : undefined}
                    title={item.label} data-settings-page={item.id}>
                    <span className="settings-nav-icon" aria-hidden="true">{item.icon}</span>
                    <span className="settings-nav-text"><span>{item.label}</span>{item.hint && <span className="settings-nav-hint" data-settings-hint>{item.hint}</span>}</span>
                  </button>)}
                </div>
              ))}
            </nav>
            <span className="settings-sidebar-foot">Hivemind {version ? `v${version}` : ""}</span>
          </aside>
          <div className="settings-main">
            <header className="settings-page-header">
              <div><h2>{nav.titleOf(page)}</h2>
                <SettingsDialog.Description className="sr-only" id="settings-description">{nav.describe(page)}</SettingsDialog.Description>
              </div>
              <SettingsDialog.Close className="settings-icon-button" aria-label="Close"><X size={18} /></SettingsDialog.Close>
            </header>
            <div key={page} className="settings-page-content" data-settings-body>
        {page === "about" && (<>
        {/* About + update status */}
        <div className="settings-section">
          <div className="flex items-baseline justify-between gap-2">
            <div className="flex items-baseline gap-2">
              <span className="text-row font-semibold text-[var(--color-fg)]">hivemind</span>
              <span className="text-count font-mono text-[var(--color-fg2)]">{version ? `v${version}` : "version…"}</span>
            </div>
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-count text-[var(--color-fg2)] hover:text-[var(--color-fg)]"
            >
              GitHub <ExternalLink className="size-3 text-[var(--color-fg2)]" />
            </a>
          </div>
          {window.hive.checkForUpdate ? <div className="settings-row">
            {upgrading || progress ? (
              <UpdateWork progress={progress} busy={upgrading} onRestart={onRestart} />
            ) : update?.staged ? (
              <>
                <span className="inline-flex items-center gap-1.5 text-label text-[var(--color-fg)]">
                  <span className="size-2 rounded-full bg-[var(--color-ok)]" aria-hidden />
                  v{update.staged} is downloaded — restart to finish
                </span>
                <Button onClick={onRestart} size="xs" title="Restart into the version already downloaded">Restart</Button>
              </>
            ) : update?.updateAvailable ? (
              <>
                <span className="inline-flex items-center gap-1.5 text-label text-[var(--color-fg)]">
                  <span className="size-2 rounded-full bg-[var(--color-warn)]" aria-hidden />
                  Update available{update.latest ? ` — v${update.latest}` : ""}
                </span>
                <Button onClick={onUpgrade} size="xs" title="Download the latest release">Update</Button>
              </>
            ) : update?.off ? (
              <>
                <span className="inline-flex items-center gap-1.5 text-label text-[var(--color-fg2)]" data-update-off>
                  <span className="size-2 rounded-full bg-[var(--color-fg3)]" aria-hidden />
                  The update check is off
                </span>
              </>
            ) : (
              <>
                <span className="inline-flex items-center gap-1.5 text-label text-[var(--color-fg2)]">
                  <span className="size-2 rounded-full" style={{ background: checking ? "var(--color-fg3)" : "var(--color-ok)" }} aria-hidden />
                  {checking ? "Checking…" : "Up to date"}
                </span>
                <Button
                  variant="outline"
                  onClick={() => onCheck({ force: true })}
                  disabled={checking}
                >
                  Check now
                </Button>
              </>
            )}
          </div> : <p className="settings-note" data-update-elsewhere>Updates are made in the app on the computer it runs on.</p>}
          <UpdateCheckSwitch onTurnedOn={() => onCheck({ force: true })} />
          <QuitSetting />
          <div className="settings-row">
            <span className="text-[var(--color-fg2)]">License</span>
            <span className="font-mono text-[var(--color-fg2)]">MIT</span>
          </div>
        </div>

        </>)}

        {page === "notifications" && <NotificationPrefs />}


        {/* A page that fails is that page's failure, not the app's: the rest of Settings stays. */}
        <TileErrorBoundary key={page} label="This settings page">
          <Suspense fallback={<Loading label="Loading Settings" />}><SettingsPages page={page} navigate={go} /></Suspense>
        </TileErrorBoundary>

          </div>
        </div>

      </SettingsDialog.Content>
    </SettingsDialog.Portal>
  </SettingsDialog.Root>
  );
}

