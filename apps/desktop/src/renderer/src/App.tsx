import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Plus, Settings } from "lucide-react";
import path from "path-browserify";
import type { UpdateStatus } from "../../shared/ipc";
import {
  inElectron,
  useFsChangedInvalidation,
  useIssues,
  useProject,
} from "./queries";
import { Canvas } from "./Canvas";
import { IssuePeek } from "./components/IssuePeek";
import { NewIssueModal } from "./components/NewIssueModal";

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
  const check = useCallback(async () => {
    if (!window.hive?.checkForUpdate) return;
    setChecking(true);
    try {
      const s = await window.hive.checkForUpdate();
      setStatus(s);
      try { localStorage.setItem("hivemind:update", JSON.stringify(s)); } catch { /* quota */ }
    } catch { /* main never rejects; ignore */ }
    finally { setChecking(false); }
  }, []);
  useEffect(() => {
    void window.hive?.getAppVersion?.().then(setVersion).catch(() => {});
    void check();
    const id = window.setInterval(() => { void check(); }, 4 * 60 * 60 * 1000);
    return () => window.clearInterval(id);
  }, [check]);
  const upgrade = useCallback(() => { void window.hive?.runUpgrade?.(); }, []);
  return { version, status, checking, check, upgrade };
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

  // Main-process accelerator bridge: xterm swallows Ctrl+N to send it as a
  // control code to the PTY (^N = SO), so window keydown never fires when a
  // terminal has focus. Main intercepts ⌘N / ⌘L via before-input-event and
  // forwards over IPC — we re-emit as the same CustomEvents the handlers use.
  useEffect(() => {
    const w = window as unknown as {
      hive?: {
        onMenuNewIssue?: (cb: () => void) => () => void;
        onMenuToggleLayers?: (cb: () => void) => () => void;
        onMenuFitOverlay?: (cb: () => void) => () => void;
        onMenuResetScale?: (cb: () => void) => () => void;
        onMenuFocusTile?: (cb: () => void) => () => void;
      };
    };
    if (!w.hive?.onMenuNewIssue) return;
    const offNew = w.hive.onMenuNewIssue(() => setNewOpen(true));
    // ⌘/Ctrl+L toggles the Layers panel (LayersPanel listens for the event).
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
    return () => {
      offNew?.();
      offLayers?.();
      offFit?.();
      offResetScale?.();
      offFocusSel?.();
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
        <Canvas
          cwd={cwd}
          repoPath={repoPath}
          root={root}
          onInitWorkspace={!root ? () => setInitOpen(true) : undefined}
          updateAvailable={update.status?.updateAvailable === true}
          onUpgrade={update.upgrade}
        />
        <div className="absolute top-0 right-0 z-40 flex items-start gap-2 px-3 py-2.5 pointer-events-none">
          {root && (
            <button
              onClick={() => setNewOpen(true)}
              className="pointer-events-auto inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg hm-island text-[12px] font-medium text-[var(--color-fg)] hover:bg-[var(--color-bg3)] transition-colors"
              title="New issue (⌘N)"
            >
              <Plus aria-hidden className="size-3.5 text-[var(--color-fg2)]" />
              <span>New issue</span>
              <kbd className="font-mono text-[9.5px] text-[var(--color-fg3)] ml-0.5">⌘N</kbd>
            </button>
          )}
          <button
            onClick={() => setSettingsOpen(true)}
            className="pointer-events-auto relative inline-flex items-center justify-center size-8 rounded-lg hm-island text-[var(--color-fg2)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)] transition-colors"
            title={update.status?.updateAvailable ? "Settings — update available" : "Settings"}
            aria-label="settings"
          >
            <Settings aria-hidden className="size-4" />
            {update.status?.updateAvailable && (
              <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-[var(--color-warn)] ring-2 ring-[var(--color-bg2)]" aria-hidden />
            )}
          </button>
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
      />
    </div>
  );
}

const REPO_URL = "https://github.com/dip497/hivemind";

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
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Running app version (null until main answers). */
  version: string | null;
  /** Latest update check result, or null if it hasn't run / failed silently. */
  update: UpdateStatus | null;
  /** A check is in flight. */
  checking: boolean;
  /** Re-run the update check now. */
  onCheck: () => void;
  /** Run the installer + quit so the new binary takes over. */
  onUpgrade: () => void;
}) {
  const [active, setActive] = useState(false);   // live this session
  const [enabled, setEnabled] = useState(false); // persisted choice
  const [port, setPort] = useState("9333");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    void window.hive.getBrowserSettings().then((s) => {
      setActive(s.active);
      setEnabled(s.enabled);
      setPort(s.port);
    }).catch(() => {});
  }, [open]);

  if (!open) return null;
  // The toggle is "dirty" when the persisted choice no longer matches what's
  // actually running — that's exactly when a relaunch is needed.
  const needsRelaunch = enabled !== active;

  const onToggle = async () => {
    const next = !enabled;
    setBusy(true);
    try { await window.hive.setBrowserCdpEnabled(next); setEnabled(next); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50" onClick={() => onOpenChange(false)}>
      <div
        className="w-[480px] bg-[var(--color-bg2)] border border-[var(--color-line2)] rounded-lg shadow-2xl p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-[15px] font-semibold text-[var(--color-fg)]">Settings</h2>

        {/* About + update status */}
        <div className="mt-4 rounded-lg border border-[var(--color-line2)] bg-[var(--color-bg3)] p-3">
          <div className="flex items-baseline justify-between gap-2">
            <div className="flex items-baseline gap-2">
              <span className="text-[14px] font-semibold text-[var(--color-fg)]">hivemind</span>
              <span className="text-[11px] font-mono text-[var(--color-fg3)]">{version ? `v${version}` : "version…"}</span>
            </div>
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-[var(--color-fg2)] hover:text-[var(--color-fg)]"
            >
              GitHub <ExternalLink className="size-3 text-[var(--color-fg3)]" />
            </a>
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            {update?.updateAvailable ? (
              <>
                <span className="inline-flex items-center gap-1.5 text-[12px] text-[var(--color-fg)]">
                  <span className="size-2 rounded-full bg-[var(--color-warn)]" aria-hidden />
                  Update available{update.latest ? ` — v${update.latest}` : ""}
                </span>
                <button
                  onClick={onUpgrade}
                  className="px-2.5 py-1.5 text-[11px] font-medium text-white bg-[var(--color-brand)] rounded hover:opacity-90"
                  title="Download the latest release and restart"
                >
                  Update &amp; restart
                </button>
              </>
            ) : (
              <>
                <span className="inline-flex items-center gap-1.5 text-[12px] text-[var(--color-fg2)]">
                  <span className="size-2 rounded-full" style={{ background: checking ? "var(--color-fg3)" : "var(--color-ok)" }} aria-hidden />
                  {checking ? "Checking…" : "Up to date"}
                </span>
                <button
                  onClick={onCheck}
                  disabled={checking}
                  className="px-2 py-1 text-[11px] border border-[var(--color-line2)] text-[var(--color-fg2)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg4)] rounded disabled:opacity-40"
                >
                  Check now
                </button>
              </>
            )}
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px]">
            <span className="text-[var(--color-fg3)]">License</span>
            <span className="font-mono text-[var(--color-fg2)]">MIT</span>
          </div>
        </div>

        <div className="mt-4 flex items-start gap-3">
          <button
            role="switch"
            aria-checked={enabled}
            disabled={busy}
            onClick={onToggle}
            className={`mt-0.5 shrink-0 relative w-9 h-5 rounded-full transition-colors disabled:opacity-50 ${
              enabled ? "bg-[var(--color-brand)]" : "bg-[var(--color-line2)]"
            }`}
            title="Enable agent browser control"
          >
            <span className={`absolute top-0.5 size-4 rounded-full bg-white transition-all ${enabled ? "left-[18px]" : "left-0.5"}`} />
          </button>
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-[var(--color-fg)]">Enable agent browser control</div>
            <p className="mt-1 text-[11.5px] text-[var(--color-fg2)] leading-relaxed">
              Lets a spawned agent drive a Browser tile (navigate, click, read, screenshot)
              over the Chrome DevTools Protocol via the <code className="font-mono text-[10.5px] bg-[var(--color-bg3)] px-1 rounded">hive-browser</code> skill.
            </p>
            <p className="mt-1.5 text-[11px] text-[var(--color-warn)] leading-relaxed">
              ⚠ Opens a loopback debug port (127.0.0.1:{port}) that also exposes this app's
              window to local processes. Only enable it for agents you trust.
            </p>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between gap-2">
          <span className="text-[11px] text-[var(--color-fg3)]">
            {active ? <>Bridge is <b className="text-[var(--color-fg2)]">active</b> this session.</>
                    : <>Bridge is <b className="text-[var(--color-fg2)]">off</b> this session.</>}
          </span>
          <div className="flex gap-2">
            {needsRelaunch && (
              <button
                onClick={() => void window.hive.relaunchApp()}
                className="px-3 py-1.5 text-[12px] font-medium text-white bg-[var(--color-brand)] rounded hover:opacity-90"
                title="Restart hivemind to apply"
              >
                Relaunch to apply
              </button>
            )}
            <button
              onClick={() => onOpenChange(false)}
              className="px-3 py-1.5 text-[12px] text-[var(--color-fg2)] hover:text-[var(--color-fg)] rounded"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
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
          <label className="grid gap-1">
            <span className="text-[11px] text-[var(--color-fg3)] uppercase tracking-wider">Issue prefix</span>
            <input
              autoFocus
              value={prefix}
              onChange={(e) => setPrefix(e.target.value.toUpperCase())}
              placeholder="e.g. PAY"
              className="w-full bg-[var(--color-bg)] border border-[var(--color-line2)] rounded-md px-2.5 py-1.5 text-[13px] font-mono text-[var(--color-fg)] focus:outline-none focus:border-[var(--color-brand)]"
            />
            {!valid && prefix.length > 0 && (
              <span className="text-[10.5px] text-[var(--color-err)]">UPPERCASE, 2–10 chars, starts with a letter</span>
            )}
          </label>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="px-3 py-1.5 text-[12px] text-[var(--color-fg2)] hover:text-[var(--color-fg)] rounded"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!valid || pending}
              className="px-3 py-1.5 text-[12px] font-medium text-white bg-[var(--color-brand)] rounded hover:opacity-90 disabled:opacity-40"
            >
              {pending ? "Initializing…" : "Initialize"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

