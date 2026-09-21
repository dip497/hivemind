import * as SettingsDialog from "@radix-ui/react-dialog";
import { setWorkspaceOccluded } from "./workspace-occlusion";
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Bell, ChevronRight, ExternalLink, Loader2, Plus, Settings, X, Palette, PanelsTopLeft, Puzzle, Bot, Keyboard, Info } from "lucide-react";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Switch } from "./components/ui/switch";
import path from "path-browserify";
import type { UpdateStatus } from "../../shared/ipc";
import {
  inElectron,
  useFsChangedInvalidation,
  useIssues,
  useProject,
} from "./queries";
import { Workspace } from "./Workspace";
import { IssuePeek } from "./components/IssuePeek";
import { NewIssueModal } from "./components/NewIssueModal";
import { resolveSettingsPage } from "./settings-registry";
import { useExpandedGroups, useSettingsNav } from "./settings-nav";
import { getNotificationSettings, setNotificationSettingsCache, subscribeNotificationSettings, saveNotificationSettings } from "./notification-settings";
import type { NotificationSettings } from "../../shared/ipc";
const SettingsPages = lazy(() => import("./settings-panels"));

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
  return next;
}

/** GitHub-release update check, owned at the App level so the top-right Settings
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
  const upgradingRef = useRef(false);
  const upgrade = useCallback(() => {
    if (upgradingRef.current || !window.hive?.runUpgrade) return;
    upgradingRef.current = true;
    setUpgrading(true);
    const id = toast.loading("Downloading update… (this can take ~30s)");
    const off = window.hive.onUpdateProgress?.((line) => { toast.loading(line, { id }); });
    const done = () => { off?.(); upgradingRef.current = false; setUpgrading(false); };
    window.hive
      .runUpgrade()
      .then((r) => {
        if (r.ok) {
          off?.();
          toast.success("Update installed — restarting…", { id, duration: 4000 });
          window.setTimeout(() => { void window.hive.relaunchApp(); }, 1200);
        } else {
          toast.error(`Update failed (exit ${r.code ?? "?"}). Run \`hivemind upgrade\` in a terminal.`, { id, duration: 8000 });
          done();
        }
      })
      .catch(() => { toast.error("Update failed to start.", { id }); done(); });
  }, []);
  return { version, status, checking, check, upgrade, upgrading };
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
    const picked = await window.hive.pickProjectFolder();
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
  const root = project?.root ?? null;
  const cwd = project?.cwd ?? "";
  // Prefer the explicit repoPath from main (handles the no-.hivemind case
  // where we still discovered a .git/ ancestor); fall back to deriving from
  // root for older builds.
  const repoPath = project?.repoPath ?? (root ? path.dirname(root) : null);
  useFsChangedInvalidation(repoPath, root);
  const { data: issues = [] } = useIssues(root);

  // Canvas-only: the Board/List views + their sidebar/filter chrome were
  // removed — the canvas IS the workspace (issues live as the IssuesTile, the
  // ⌘K palette, and IssuePeek). No view switcher.
  const [peekId, setPeekId] = useState<string | null>(null);
  // The workspace root the peek reads from. Defaults to the app's base root,
  // but a cross-repo link (an id whose prefix belongs to another registered
  // workspace) resolves to that repo's root so the peek shows the right issue.
  const [peekRoot, setPeekRoot] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [initing, setIniting] = useState(false);
  const [initOpen, setInitOpen] = useState(false);
  const openInit = useCallback(() => setInitOpen(true), []);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const update = useUpdateCheck();
  const qc = useQueryClient();

  // Initialize a .hivemind/ workspace in the current folder (no terminal).
  // NOTE: Electron disables window.prompt() (returns null), so the prefix is
  // collected via an inline input (InitWorkspacePrompt) instead.
  async function doInitWorkspace(prefix: string) {
    const dir = repoPath ?? cwd;
    if (!dir || !prefix.trim()) return;
    setIniting(true);
    try {
      await window.hive.initWorkspace(dir, prefix.trim());
      // Point the project query at `dir` explicitly. Changing the query key
      // (["project", dir]) forces useProject to refetch with the new hint;
      // resolveProject now finds the freshly-written .hivemind/ → root set →
      // New button + board appear.
      window.localStorage.setItem("hivemind:last-project", dir);
      setRecents(pushRecent(dir));
      setRootHint(dir);
      setInitOpen(false);
      await qc.invalidateQueries({ queryKey: ["project"] });
    } catch (e) {
      window.alert(`Could not initialize workspace: ${(e as Error).message}`);
    } finally {
      setIniting(false);
    }
  }
  const suggestedPrefix = (() => {
    const base = (repoPath ?? cwd).split("/").filter(Boolean).slice(-1)[0] ?? "HIVE";
    const p = base.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 6);
    return p.length >= 2 ? p : "HIVE";
  })();

  // ⌘K palette → open peek via CustomEvent (decouples palette from App state)
  useEffect(() => {
    const onOpen = (e: Event) => {
      // Detail is either a bare id (⌘K palette, peek links) or {id, root} when
      // the opener knows its root (Issues tile). An explicit root is
      // authoritative — use it and skip the registry guess entirely.
      const detail = (e as CustomEvent<string | { id: string; root?: string | null }>).detail;
      const id = typeof detail === "string" ? detail : detail?.id;
      if (typeof id !== "string") return;
      const explicitRoot = typeof detail === "object" && detail ? detail.root ?? null : null;
      setPeekId(id);
      if (explicitRoot) {
        setPeekRoot(explicitRoot);
        return;
      }
      // No root supplied: optimistically read from the base root; if the id
      // belongs to another registered workspace, repoint once resolved.
      setPeekRoot(root);
      void window.hive
        .resolveIssueRoot(id)
        .then((r) => { if (r.root) setPeekRoot(r.root); })
        .catch(() => { /* fall back to base root */ });
    };
    const onNew = () => setNewOpen(true);
    // Canvas is always mounted now (canvas-only), so spawn-claude is handled
    // directly by Canvas's own listener — no view-switch bridge needed.
    window.addEventListener("hivemind:open-issue", onOpen as EventListener);
    window.addEventListener("hivemind:new-issue", onNew);
    return () => {
      window.removeEventListener("hivemind:open-issue", onOpen as EventListener);
      window.removeEventListener("hivemind:new-issue", onNew);
    };
  }, [root]);

  // ⌘N global shortcut to open the new-issue modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "n" || e.key === "N") && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
        // Don't hijack ⌘N inside input/textarea/contenteditable.
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
        e.preventDefault();
        setNewOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  // A new app version landed → ping once (not every 4h re-check). Only when the
  // master notification preference is on; the Settings gear dot always shows it
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

  // Main-process accelerator bridge: xterm swallows Ctrl+N to send it as a
  // control code to the PTY (^N = SO), so window keydown never fires when a
  // terminal has focus. Main intercepts ⌘N / ⌘B (and the VS Code keys) via before-input-event and
  // forwards over IPC — we re-emit as the same CustomEvents the handlers use.
  useEffect(() => {
    const w = window as unknown as {
      hive?: {
        onMenuNewIssue?: (cb: () => void) => () => void;
        onMenuToggleLayers?: (cb: () => void) => () => void;
        onMenuFitOverlay?: (cb: () => void) => () => void;
        onMenuResetScale?: (cb: () => void) => () => void;
        onMenuFocusTile?: (cb: () => void) => () => void;
        onMenuShortcut?: (cb: (action: string) => void) => () => void;
      };
    };
    if (!w.hive?.onMenuNewIssue) return;
    const offNew = w.hive.onMenuNewIssue(() => setNewOpen(true));
    // ⌘/Ctrl+B toggles the Layers panel (LayersPanel listens for the event).
    const offLayers = w.hive.onMenuToggleLayers?.(() =>
      window.dispatchEvent(new CustomEvent("hivemind:toggle-layers")),
    );
    // Tile scaling: re-dispatch the forwarded accelerators as CustomEvents that
    // TerminalTile (fit/reset, selected-only) and useCanvasShortcuts (focus) hear.
    const offFit = w.hive.onMenuFitOverlay?.(() =>
      window.dispatchEvent(new CustomEvent("hivemind:fit-overlay")),
    );
    const offResetScale = w.hive.onMenuResetScale?.(() =>
      window.dispatchEvent(new CustomEvent("hivemind:reset-scale")),
    );
    const offFocusSel = w.hive.onMenuFocusTile?.(() =>
      window.dispatchEvent(new CustomEvent("hivemind:focus-selected")),
    );
    const offShortcut = w.hive.onMenuShortcut?.((action) =>
      window.dispatchEvent(new CustomEvent("hivemind:shortcut", { detail: action })),
    );
    return () => {
      offNew?.();
      offLayers?.();
      offFit?.();
      offResetScale?.();
      offFocusSel?.();
      offShortcut?.();
    };
  }, []);

  if (isLoading) {
    return <div className="grid place-items-center h-screen text-[var(--color-fg3)]">loading…</div>;
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-[var(--color-bg)]">
      {/* Canvas-only workspace. The canvas is full-bleed; floating chrome sits
          on top — frame = workspace, so the per-Frame "+ workspace" bind is the
          canonical add-a-workspace action; Open/Init/Recents live in the sidebar. */}
      <div className="fixed inset-0 z-30 bg-[var(--color-bg)]">
        <Workspace
          cwd={cwd}
          repoPath={repoPath}
          root={root}
          onInitWorkspace={!root ? openInit : undefined}
          updateAvailable={update.status?.updateAvailable === true}
          onUpgrade={update.upgrade}
          upgrading={update.upgrading}
        />
        <div className="absolute top-0 right-0 z-40 flex items-start gap-2 px-3 py-2.5 pointer-events-none">
          {root && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setNewOpen(true)}
              className="pointer-events-auto"
              title="New issue (⌘N)"
            >
              <Plus aria-hidden />
              <span>New issue</span>
              <kbd className="font-mono text-[9.5px] ml-0.5">⌘N</kbd>
            </Button>
          )}
          <Button
            variant="secondary"
            size="icon"
            onClick={() => setSettingsOpen(true)}
            className="pointer-events-auto relative"
            title={update.status?.updateAvailable ? "Settings — update available" : "Settings"}
            aria-label="settings"
          >
            <Settings aria-hidden />
            {update.status?.updateAvailable && (
              <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-[var(--color-warn)] ring-2 ring-[var(--color-bg2)]" aria-hidden />
            )}
          </Button>
        </div>
      </div>

      <IssuePeek root={peekRoot ?? root} id={peekId} onClose={() => setPeekId(null)} />
      <NewIssueModal
        root={root}
        open={newOpen}
        onOpenChange={setNewOpen}
        onCreated={setPeekId}
      />
      <InitWorkspacePrompt
        open={initOpen}
        onOpenChange={setInitOpen}
        dir={repoPath ?? cwd}
        suggested={suggestedPrefix}
        pending={initing}
        onConfirm={doInitWorkspace}
      />
      <SettingsModal
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        version={update.version}
        update={update.status}
        checking={update.checking}
        onCheck={() => { void update.check(); }}
        onUpgrade={update.upgrade}
        upgrading={update.upgrading}
      />
    </div>
  );
}

const REPO_URL = "https://github.com/dip497/hivemind";


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
    { key: "needs", label: "Needs you", hint: "Permission prompts, questions, blocked" },
    { key: "done", label: "Finished", hint: "An agent completed its task" },
    { key: "error", label: "Failed", hint: "Agent crashed or exited non-zero" },
  ];

  return (
    <div className="settings-section">
      <div className="settings-row">
        <div className="flex items-center gap-2">
          <Bell size={14} className="text-[var(--color-fg2)]" />
          <span className="text-[13px] font-medium text-[var(--color-fg)]">Notifications</span>
        </div>
        <Switch checked={s.enabled} onCheckedChange={(v) => update({ enabled: v })} aria-label="Enable notifications" />
      </div>

      {/* Per-kind mute — which agent transitions reach you. */}
      <div className="settings-section">
        <div className="settings-subheading">Notify me about</div>
        {kinds.map((k) => (
          <div key={k.key} className="settings-row">
            <div className="min-w-0">
              <div className="text-[12px] text-[var(--color-fg)]">{k.label}</div>
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
          <div className="text-[12px] text-[var(--color-fg)]">In-app toasts</div>
          <Switch disabled={dim} checked={s.inApp} onCheckedChange={(v) => update({ inApp: v })} aria-label="In-app toasts" />
        </div>
        <div className="settings-row">
          <div className="text-[12px] text-[var(--color-fg)]">Native OS popups</div>
          <Switch disabled={dim} checked={s.osPopups} onCheckedChange={(v) => update({ osPopups: v })} aria-label="Native OS popups" />
        </div>
      </div>

      {/* Do-Not-Disturb — mutes finished/failed (NOT needs-you) during a window. */}
      <div className="settings-section">
        <div className="settings-row">
          <div className="min-w-0">
            <div className="text-[12px] text-[var(--color-fg)]">Do Not Disturb</div>
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
            <span className="text-[11px] text-[var(--color-fg2)]">to</span>
            <Input
              type="time"
              disabled={dim}
              value={s.dnd.end}
              onChange={(e) => update({ dnd: { ...s.dnd, end: e.target.value } })}
              className="w-auto"
              aria-label="DND end"
            />
            <span className="text-[10px] text-[var(--color-fg2)] ml-auto">local time</span>
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
}) {
  const [page, setPage] = useState("appearance");
  const nav = useSettingsNav(page);
  const [expanded, toggleGroup] = useExpandedGroups();
  const settingsReturnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    setWorkspaceOccluded(open);
    return () => setWorkspaceOccluded(false);
  }, [open]);
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
          onOpenAutoFocus={() => { settingsReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = settingsReturnFocus.current;
            (target?.isConnected ? target : document.querySelector<HTMLElement>('[aria-label="settings"]'))?.focus({ preventScroll: true });
          }}
        >
          <aside className="settings-sidebar">
            <SettingsDialog.Title className="settings-title">Settings</SettingsDialog.Title>
            <nav aria-label="Settings sections">
              {nav.groups.map(({ group, items }) => {
                const foldable = items.some((item) => item.plugin);
                const open = expanded.has(group);
                // Folded shows the overview only; the page you are on always stays in view.
                const shown = items.filter((item) => !item.plugin || open || item.id === page);
                return <div key={group} className="settings-nav-group" role="group" aria-label={group}>
                <h3 className="settings-nav-heading">{foldable
                  ? <button aria-expanded={open} onClick={() => toggleGroup(group)}><ChevronRight size={12} aria-hidden="true" /><span>{group}</span></button>
                  : <span className="settings-nav-heading-text">{group}</span>}</h3>
                {shown.map((item) => <button key={item.id} onClick={() => setPage(item.id)} aria-current={page === item.id ? "page" : undefined}
                  title={item.label} data-settings-page={item.id} data-plugin={item.plugin ? "" : undefined}>
                  <span className="settings-nav-icon" aria-hidden="true">{item.icon}</span><span>{item.label}</span>
                </button>)}
              </div>;
              })}
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
              <span className="text-[14px] font-semibold text-[var(--color-fg)]">hivemind</span>
              <span className="text-[11px] font-mono text-[var(--color-fg2)]">{version ? `v${version}` : "version…"}</span>
            </div>
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-[var(--color-fg2)] hover:text-[var(--color-fg)]"
            >
              GitHub <ExternalLink className="size-3 text-[var(--color-fg2)]" />
            </a>
          </div>
          <div className="settings-row">
            {update?.updateAvailable ? (
              <>
                <span className="inline-flex items-center gap-1.5 text-[12px] text-[var(--color-fg)]">
                  <span className="size-2 rounded-full bg-[var(--color-warn)]" aria-hidden />
                  Update available{update.latest ? ` — v${update.latest}` : ""}
                </span>
                <Button
                  onClick={onUpgrade}
                  disabled={upgrading}
                  aria-busy={upgrading}
                  size="xs"
                  title={upgrading ? "Downloading and installing the update…" : "Download the latest release and restart"}
                >
                  {upgrading ? (
                    <>
                      <Loader2 className="animate-spin" aria-hidden />
                      Updating…
                    </>
                  ) : (
                    "Update & restart"
                  )}
                </Button>
              </>
            ) : (
              <>
                <span className="inline-flex items-center gap-1.5 text-[12px] text-[var(--color-fg2)]">
                  <span className="size-2 rounded-full" style={{ background: checking ? "var(--color-fg3)" : "var(--color-ok)" }} aria-hidden />
                  {checking ? "Checking…" : "Up to date"}
                </span>
                <Button
                  variant="outline"
                  onClick={() => onCheck({ force: true })}
                  disabled={checking}
                >
                  {checking ? "Checking…" : "Check now"}
                </Button>
              </>
            )}
          </div>
          <div className="settings-row">
            <span className="text-[var(--color-fg2)]">License</span>
            <span className="font-mono text-[var(--color-fg2)]">MIT</span>
          </div>
        </div>

        </>)}

        {page === "notifications" && <NotificationPrefs />}


        <Suspense fallback={<p role="status" className="settings-note">Loading preferences…</p>}><SettingsPages page={page} navigate={setPage} /></Suspense>

          </div>
        </div>

      </SettingsDialog.Content>
    </SettingsDialog.Portal>
  </SettingsDialog.Root>
  );
}

/** Inline prefix prompt for "Initialize workspace" — window.prompt is
 *  disabled in Electron, so we collect the prefix in a small dialog. */
function InitWorkspacePrompt({
  open,
  onOpenChange,
  dir,
  suggested,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  dir: string;
  suggested: string;
  pending: boolean;
  onConfirm: (prefix: string) => void;
}) {
  const [prefix, setPrefix] = useState(suggested);
  useEffect(() => {
    if (open) setPrefix(suggested);
  }, [open, suggested]);
  if (!open) return null;
  const valid = /^[A-Z][A-Z0-9]{1,9}$/.test(prefix);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50" onClick={() => onOpenChange(false)}>
      <div
        className="w-[420px] bg-[var(--color-bg2)] border border-[var(--color-line2)] rounded-lg shadow-2xl p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-[15px] font-semibold text-[var(--color-fg)]">Initialize workspace</h2>
        <p className="mt-1 text-[12px] text-[var(--color-fg2)] leading-relaxed">
          Creates <code className="font-mono text-[11px] bg-[var(--color-bg3)] px-1 rounded">.hivemind/</code> in
          <span className="font-mono text-[11px] text-[var(--color-fg3)]"> {dir.split("/").slice(-2).join("/")}</span>.
          Issues will be numbered <span className="font-mono">{valid ? prefix : "PREFIX"}-1</span>, -2, …
        </p>
        <form
          className="mt-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && !pending) onConfirm(prefix);
          }}
        >
          <div className="grid gap-1">
            <Label htmlFor="init-prefix">Issue prefix</Label>
            <Input font="mono"
              id="init-prefix"
              autoFocus
              value={prefix}
              onChange={(e) => setPrefix(e.target.value.toUpperCase())}
              placeholder="e.g. PAY"
            />
            {!valid && prefix.length > 0 && (
              <span className="text-[10.5px] text-[var(--color-err)]">UPPERCASE, 2–10 chars, starts with a letter</span>
            )}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || pending}>
              {pending ? "Initializing…" : "Initialize"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

