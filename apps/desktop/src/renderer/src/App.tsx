import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import path from "path-browserify";
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
      const id = (e as CustomEvent<string>).detail;
      if (typeof id !== "string") return;
      setPeekId(id);
      // Optimistically read from the base root; if the id belongs to another
      // registered workspace, repoint at its root once resolved.
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
      };
    };
    if (!w.hive?.onMenuNewIssue) return;
    const offNew = w.hive.onMenuNewIssue(() => setNewOpen(true));
    // ⌘/Ctrl+L toggles the Layers panel (LayersPanel listens for the event).
    const offLayers = w.hive.onMenuToggleLayers?.(() =>
      window.dispatchEvent(new CustomEvent("hivemind:toggle-layers")),
    );
    return () => {
      offNew?.();
      offLayers?.();
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
        />
        <div className="absolute top-0 right-0 z-40 flex items-start px-3 py-2.5 pointer-events-none">
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

