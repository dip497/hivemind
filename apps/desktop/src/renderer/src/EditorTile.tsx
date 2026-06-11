/**
 * EditorTile — a SINGLE canvas tile with TABS, each tab an editable CodeMirror 6
 * buffer. Modeled on Nyx's one "editor" tile: clicking files in the tree opens
 * them as tabs here instead of spawning a node per file.
 *
 * Canvas owns the open-tab list (`tabs`) + persistence; this component owns
 * active-tab selection, per-tab content/dirty state, load, and save-to-disk
 * (⌘S / Ctrl+S → window.hive.fileWrite).
 *
 * CodeMirror (not Monaco) keeps the bundle light — the app prioritizes perf.
 * Languages lazy-load via @codemirror/language-data so only the extensions a
 * user actually opens get pulled in.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GripVertical } from "lucide-react";
import { useTileFont, FontStepper, handleFontKey } from "./tile-font";
import { EditorState, type Extension, Compartment } from "@codemirror/state";
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, rectangularSelection, crosshairCursor,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import {
  HighlightStyle,
  syntaxHighlighting,
  indentOnInput,
  bracketMatching,
  foldGutter,
  type LanguageSupport,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { tags as t } from "@lezer/highlight";
// @codemirror/merge: unifiedMergeView is an Extension[] (NOT a separate view
// class), so we toggle it on/off via a Compartment.reconfigure on the same
// EditorView — same tab, same buffer, no new tab. Strongest OSS precedent
// is marimo-team/codemirror-ai + aziis98's review-tool walkthrough. The
// standalone DiffTile stays for browsing branch/commit diffs (no editable
// buffer there).
import { unifiedMergeView } from "@codemirror/merge";
import { resolveActive } from "./editor-active";
// Lazy: marked + DOMPurify (and, on demand, mermaid) load only when the user
// actually opens Preview — opening an editor tile pulls in zero markdown code.
const MarkdownPreview = lazy(() =>
  import("./markdown-preview").then((m) => ({ default: m.MarkdownPreview })),
);

/** Files that get a Preview (rendered markdown) toggle. */
const isMarkdownPath = (p: string): boolean => /\.(md|markdown|mdown|mkd|mdx)$/i.test(p);

interface Props {
  repoPath: string;
  /** Repo-relative paths of every open tab (Canvas owns this list). */
  tabs: string[];
  /** Remove a tab from Canvas state. */
  onCloseTab: (path: string) => void;
  /** Activate-this-file request from the host (tree click). The `seq` makes
   *  re-selecting an already-open file a fresh request, so clicking a file that's
   *  already a tab switches back to it instead of being a no-op. */
  activeReq?: { path: string; seq: number } | null;
  /** Close the whole tile. Omitted when embedded (the host owns chrome). */
  onClose?: () => void;
  /** When true, render only the tab bar + editor body — no outer tile chrome
   *  (border/shadow/header). Used by WorkbenchTile, which supplies its own
   *  shell. Defaults to false so the standalone tile keeps working. */
  embedded?: boolean;
}

// ── theme ─────────────────────────────────────────────────────────────────
// CodeMirror theme bound to the app's --color-* tokens (see styles.css).
const cmTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "var(--color-bg2)",
      color: "var(--color-fg)",
      // Inherit from the tile root, which carries the per-tile font size (so
      // A−/A+ scales the editor). See useTileFont in EditorTile.
      fontSize: "inherit",
    },
    ".cm-scroller": {
      fontFamily:
        "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
      lineHeight: "1.55",
      overflow: "auto",
      // Mouse cursor: text I-beam over the editor body. react-flow nodes carry
      // a default arrow / grab cursor; without this it leaks onto the editable
      // surface and the editor doesn't feel like a text field.
      cursor: "text",
    },
    ".cm-content": { caretColor: "var(--color-brand)", cursor: "text" },
    "&.cm-focused": { outline: "none" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-brand)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      { backgroundColor: "rgba(91,108,255,0.30)" },
    ".cm-gutters": {
      backgroundColor: "var(--color-bg2)",
      color: "var(--color-fg3)",
      border: "none",
    },
    ".cm-activeLineGutter": { backgroundColor: "var(--color-bg3)" },
    ".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.025)" },
    ".cm-foldPlaceholder": {
      backgroundColor: "var(--color-bg4)",
      border: "none",
      color: "var(--color-fg3)",
    },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
      backgroundColor: "rgba(91,108,255,0.25)",
      outline: "none",
    },
    // Highlight of all matches of the current selection (highlightSelectionMatches).
    ".cm-selectionMatch": { backgroundColor: "rgba(56,189,248,0.20)" },
    // Find/replace panel (search({ top: true })) — themed to the app tokens so
    // it doesn't render as the default light-grey browser bar.
    ".cm-panels": {
      backgroundColor: "var(--color-bg3)",
      color: "var(--color-fg)",
      borderBottom: "1px solid var(--color-line2)",
    },
    ".cm-panel.cm-search": { padding: "5px 8px", fontFamily: "var(--font-sans)", fontSize: "11.5px" },
    ".cm-panel.cm-search label": { color: "var(--color-fg2)", fontSize: "11px" },
    ".cm-textfield": {
      backgroundColor: "var(--color-bg)",
      color: "var(--color-fg)",
      border: "1px solid var(--color-line2)",
      borderRadius: "4px",
      padding: "2px 6px",
    },
    ".cm-button": {
      backgroundColor: "var(--color-bg4)",
      color: "var(--color-fg)",
      border: "1px solid var(--color-line2)",
      borderRadius: "4px",
      backgroundImage: "none",
    },
    ".cm-button:hover": { backgroundColor: "var(--color-bg2)" },
    ".cm-search .cm-button:active": { backgroundColor: "var(--color-brand)" },
  },
  { dark: true },
);

const highlightStyle = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--color-fg3)", fontStyle: "italic" },
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], color: "#c084fc" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#22c55e" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#f59e0b" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#60a5fa" },
  { tag: [t.typeName, t.className, t.namespace], color: "#5eead4" },
  { tag: [t.propertyName, t.attributeName], color: "#93c5fd" },
  { tag: [t.tagName], color: "#f472b6" },
  { tag: [t.variableName, t.definition(t.variableName)], color: "var(--color-fg)" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "var(--color-fg2)" },
  { tag: [t.heading], color: "#60a5fa", fontWeight: "bold" },
  { tag: [t.link, t.url], color: "#60a5fa", textDecoration: "underline" },
  { tag: [t.invalid], color: "var(--color-err)" },
]);

const baseExtensions: Extension = [
  lineNumbers(),
  foldGutter(),
  highlightActiveLine(),
  highlightActiveLineGutter(),
  history(),
  indentOnInput(),
  bracketMatching(),
  syntaxHighlighting(highlightStyle),
  // Proper selection rendering + multi-cursor (Alt-drag) + a crosshair while
  // holding Alt, and live highlight of all matches of the current selection.
  drawSelection(),
  rectangularSelection(),
  crosshairCursor(),
  highlightSelectionMatches(),
  // Find/replace panel (Mod-f). `top: true` docks it above the editor body.
  search({ top: true }),
  cmTheme,
  EditorView.lineWrapping,
  // searchKeymap LAST so Mod-f / Mod-g / etc. win over any default binding.
  keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
];

/** Resolve a CodeMirror LanguageSupport for a path via @codemirror/language-data.
 *  Lazy — the matching language's grammar is dynamically imported only on open. */
async function languageFor(path: string): Promise<LanguageSupport | null> {
  const desc = languages.find((l) => l.extensions.some((e) => path.toLowerCase().endsWith(`.${e}`)))
    ?? languages.find((l) => l.filename?.test(path.split("/").pop() ?? ""));
  if (!desc) return null;
  try {
    return await desc.load();
  } catch {
    return null;
  }
}

interface TabState {
  /** Last-saved content (for dirty comparison + reset). */
  saved: string;
  loaded: boolean;
  error: string | null;
  dirty: boolean;
  /** The file changed on disk while this tab had UNSAVED edits — set by the fs
   *  watcher so the UI can offer Reload / Keep mine instead of clobbering. */
  diskChanged?: boolean;
}

export function EditorTile({ repoPath, tabs, onCloseTab, onClose, activeReq, embedded = false }: Props) {
  // Per-tile font size (A−/A+ + Ctrl/Cmd +/−/0). The CM theme uses fontSize:
  // "inherit", so the size set on the root below flows into the editor.
  const font = useTileFont(`editor:${repoPath}`, 13);
  const [active, setActive] = useState<string | null>(tabs[0] ?? null);
  // Per-tab metadata. Live document content lives in CodeMirror's state; we
  // keep saved snapshot + dirty/loaded flags here keyed by repo-relative path.
  const [meta, setMeta] = useState<Record<string, TabState>>({});
  const [saving, setSaving] = useState(false);
  // Per-tab diff mode (toggleable). When true the active EditorView wears the
  // `unifiedMergeView` extension comparing the buffer against `HEAD:<path>`.
  // Same tab, same buffer — no DiffTile spawned. Keyed by repo-relative path.
  const [diffMode, setDiffMode] = useState<Record<string, boolean>>({});
  // Per-tab markdown Preview mode (markdown files only). When on, the rendered
  // doc replaces the CodeMirror surface. `previewSource` is the text snapshot
  // shown — captured when preview turns on / the tab changes (you can't edit
  // while previewing, so it needn't track keystrokes live).
  const [previewMode, setPreviewMode] = useState<Record<string, boolean>>({});
  const [previewSource, setPreviewSource] = useState("");

  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langCompartment = useRef(new Compartment());
  // unifiedMergeView is reconfigured per tab — also a Compartment so we can
  // toggle without rebuilding state.
  const diffCompartment = useRef(new Compartment());
  // Cache live document text per tab so switching tabs doesn't re-read disk or
  // lose unsaved edits. Keyed by repo-relative path. Updated on every doc change.
  const buffers = useRef<Map<string, string>>(new Map());

  // Resolve which tab is active across all the things that can change it: tabs
  // opening/closing, a newly-opened file (focus it), the active tab being closed
  // elsewhere (repair), and an explicit tree-click request — including a re-click
  // of an ALREADY-OPEN file, which the deduped `tabs` list can't signal on its
  // own (that was the bug: re-clicking an open file did nothing). The decision is
  // a pure function (`resolveActive`) so it's unit-tested without a DOM.
  const prevTabsRef = useRef<string[]>(tabs);
  const lastReqSeqRef = useRef<number>(activeReq?.seq ?? -1);
  useEffect(() => {
    const prev = prevTabsRef.current;
    prevTabsRef.current = tabs;
    const next = resolveActive({ tabs, prevTabs: prev, active, req: activeReq ?? null, lastSeq: lastReqSeqRef.current });
    lastReqSeqRef.current = next.seq;
    if (next.active !== active) setActive(next.active);
  }, [tabs, active, activeReq]);

  // Drop cached buffers + meta + diffMode for closed tabs (avoid unbounded growth).
  useEffect(() => {
    const set = new Set(tabs);
    for (const k of buffers.current.keys()) if (!set.has(k)) buffers.current.delete(k);
    const prune = <T,>(m: Record<string, T>): Record<string, T> => {
      let changed = false;
      const next: Record<string, T> = {};
      for (const k of Object.keys(m)) {
        if (set.has(k)) next[k] = m[k]!;
        else changed = true;
      }
      return changed ? next : m;
    };
    setMeta(prune);
    setDiffMode(prune);
    setPreviewMode(prune);
  }, [tabs]);

  // Snapshot the doc text for the preview when preview turns on (or the active
  // tab changes while previewing). Read the live CodeMirror doc; fall back to the
  // cached buffer if the view hasn't mounted the tab yet.
  useEffect(() => {
    if (active && previewMode[active]) {
      const txt = viewRef.current?.state.doc.toString() ?? buffers.current.get(active) ?? "";
      setPreviewSource(txt);
    }
  }, [active, previewMode]);

  const markDirty = useCallback((path: string, dirty: boolean) => {
    setMeta((m) => {
      const cur = m[path];
      if (cur && cur.dirty === dirty) return m;
      return { ...m, [path]: { ...(cur ?? { saved: "", loaded: true, error: null, dirty }), dirty } };
    });
  }, []);

  const save = useCallback(async () => {
    const path = active;
    const view = viewRef.current;
    if (!path || !view) return;
    const contents = view.state.doc.toString();
    setSaving(true);
    try {
      await window.hive.fileWrite(repoPath, path, contents);
      buffers.current.set(path, contents);
      setMeta((m) => ({
        ...m,
        [path]: { ...(m[path] ?? { loaded: true, error: null }), saved: contents, dirty: false, loaded: true, error: null },
      }));
    } catch (e) {
      setMeta((m) => ({
        ...m,
        [path]: { ...(m[path] ?? { saved: "", dirty: true, loaded: true }), error: (e as Error).message, dirty: true, loaded: true },
      }));
    } finally {
      setSaving(false);
    }
  }, [active, repoPath]);

  // Stable ref so the CM save keymap always calls the latest `save`.
  const saveRef = useRef(save);
  useEffect(() => { saveRef.current = save; }, [save]);

  // Mirror meta to a ref so the (stable) updateListener reads the latest saved
  // snapshot without rebuilding the editor state on every meta change.
  const metaRef = useRef(meta);
  useEffect(() => { metaRef.current = meta; }, [meta]);
  // Live tabs/active for the fs watcher (so it subscribes once per repo, not on
  // every tab switch).
  const tabsRef = useRef(tabs); tabsRef.current = tabs;
  const activeRef = useRef(active); activeRef.current = active;

  /** Adopt on-disk content into a tab. For the ACTIVE tab, replace the live doc
   *  via a transaction (keeps the editor mounted + undoable); for a background
   *  tab, just refresh its cached buffer so it shows fresh when switched to. We
   *  update metaRef synchronously BEFORE dispatching so the dirty-listener sees
   *  the new `saved` and doesn't mark the reload as a local edit. */
  const adoptDiskContent = useCallback((path: string, disk: string) => {
    buffers.current.set(path, disk);
    const next: TabState = { saved: disk, loaded: true, error: null, dirty: false };
    metaRef.current = { ...metaRef.current, [path]: next };
    setMeta((m) => ({ ...m, [path]: next }));
    if (path === activeRef.current && viewRef.current) {
      const view = viewRef.current;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: disk } });
    }
  }, []);

  // Reload the active tab from disk, discarding local edits (the "Reload" action
  // on the changed-on-disk banner).
  const reloadFromDisk = useCallback(async () => {
    const path = activeRef.current;
    if (!path) return;
    try {
      const disk = await window.hive.fileRead(repoPath, path);
      adoptDiskContent(path, disk);
    } catch { /* unreadable (deleted?) — leave the buffer as-is */ }
  }, [repoPath, adoptDiskContent]);

  // Dismiss the changed-on-disk banner, keeping the local edits.
  const keepMine = useCallback(() => {
    const path = activeRef.current;
    if (!path) return;
    setMeta((m) => (m[path] ? { ...m, [path]: { ...m[path]!, diskChanged: false } } : m));
  }, []);

  // ── filesystem watcher ──────────────────────────────────────────────────
  // Mirror on-disk changes into open tabs (e.g. an agent edits the file, or a
  // git checkout). CLEAN tabs adopt the new content automatically — no more
  // close+reopen to see external edits. A tab with UNSAVED edits is never
  // clobbered: it gets a `diskChanged` flag and a Reload / Keep-mine banner.
  // Debounced against agent write-bursts; our own saves are no-ops (disk already
  // equals the live buffer).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Set<string>();
    const flush = async () => {
      timer = undefined;
      const abs = [...pending];
      pending.clear();
      for (const tab of tabsRef.current) {
        if (!abs.some((p) => p === `${repoPath}/${tab}` || p.endsWith(`/${tab}`))) continue;
        let disk: string;
        try {
          disk = await window.hive.fileRead(repoPath, tab);
        } catch {
          continue; // deleted / unreadable — leave as-is
        }
        const cur = metaRef.current[tab];
        const saved = cur?.saved ?? "";
        const live =
          (tab === activeRef.current ? viewRef.current?.state.doc.toString() : buffers.current.get(tab)) ??
          saved;
        if (disk === live) continue; // already in sync (incl. our own save)
        if (live !== saved) {
          // unsaved local edits + a different disk version → conflict, don't clobber
          setMeta((m) => (m[tab] ? { ...m, [tab]: { ...m[tab]!, diskChanged: true } } : m));
        } else {
          adoptDiskContent(tab, disk);
        }
      }
    };
    const unsub = window.hive.onFsChanged(repoPath, ({ paths }) => {
      for (const p of paths) pending.add(p);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void flush(), 200);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsub();
    };
  }, [repoPath, adoptDiskContent]);

  // Mount the EditorView once. Tab switches swap state via view.setState.
  useEffect(() => {
    if (!hostRef.current || viewRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: "",
        extensions: [
          baseExtensions,
          langCompartment.current.of([]),
          diffCompartment.current.of([]),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                void saveRef.current();
                return true;
              },
            },
          ]),
          EditorView.editable.of(false),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // Load + display the active tab's buffer.
  useEffect(() => {
    const view = viewRef.current;
    const path = active;
    if (!view || !path) return;
    let cancelled = false;

    const dirtyListener = EditorView.updateListener.of((u) => {
      if (!u.docChanged) return;
      const text = u.state.doc.toString();
      buffers.current.set(path, text);
      const savedDoc = metaRef.current[path]?.saved ?? "";
      markDirty(path, text !== savedDoc);
    });

    const mountState = (doc: string, lang: LanguageSupport | null) => {
      const state = EditorState.create({
        doc,
        extensions: [
          baseExtensions,
          langCompartment.current.of(lang ? lang : []),
          diffCompartment.current.of([]),
          keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => { void saveRef.current(); return true; } },
          ]),
          dirtyListener,
          EditorView.editable.of(true),
        ],
      });
      view.setState(state);
    };

    void (async () => {
      try {
        // Use the cached (possibly-edited) buffer when present; else read disk.
        const cached = buffers.current.get(path);
        const [doc, lang] = await Promise.all([
          cached != null ? Promise.resolve(cached) : window.hive.fileRead(repoPath, path),
          languageFor(path),
        ]);
        if (cancelled) return;
        mountState(doc, lang);
        setMeta((m) => {
          const cur = m[path];
          // Preserve the saved snapshot/dirty flag for a tab we've seen before.
          if (cur?.loaded) return m;
          return { ...m, [path]: { saved: doc, loaded: true, error: null, dirty: false } };
        });
      } catch (e) {
        if (cancelled) return;
        const msg = (e as Error).message;
        // A tab that can't be read (e.g. a directory slipped through → EISDIR,
        // or a deleted file) must NOT poison the editor: drop it instead of
        // leaving a stuck, selected "failed" tab that blocks focusing others.
        if (/EISDIR|illegal operation on a directory|ENOENT/i.test(msg)) {
          onCloseTab(path);
          return;
        }
        setMeta((m) => ({ ...m, [path]: { saved: "", loaded: true, error: msg, dirty: false } }));
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, repoPath]);

  // Apply / clear unifiedMergeView when diffMode flips for the active tab.
  // Fetches `HEAD:<path>` via the existing IPC (gitFileContents). Same buffer,
  // same EditorView — no new tab, no DiffTile spawned. Errors quietly drop
  // diff mode back off (e.g. file is untracked → no HEAD blob).
  useEffect(() => {
    const view = viewRef.current;
    const path = active;
    if (!view || !path) return;
    const on = !!diffMode[path];
    let cancelled = false;
    void (async () => {
      if (!on) {
        view.dispatch({ effects: diffCompartment.current.reconfigure([]) });
        return;
      }
      try {
        const original = await window.hive.gitFileContents(repoPath, path, "HEAD");
        if (cancelled || view !== viewRef.current) return;
        view.dispatch({
          effects: diffCompartment.current.reconfigure(
            unifiedMergeView({ original, mergeControls: true, gutter: true }),
          ),
        });
      } catch {
        if (cancelled) return;
        setDiffMode((m) => ({ ...m, [path]: false }));
      }
    })();
    return () => { cancelled = true; };
  }, [diffMode, active, repoPath]);

  const activeMeta = active ? meta[active] : undefined;
  const activeDiff = active ? !!diffMode[active] : false;
  const activeMarkdown = active ? isMarkdownPath(active) : false;
  const activePreview = active ? !!previewMode[active] : false;

  return (
    <div
      className={
        embedded
          ? "flex h-full flex-col bg-[var(--color-bg2)] overflow-hidden min-w-0"
          : "flex h-full flex-col rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] overflow-hidden shadow-[0_8px_22px_rgba(0,0,0,0.45)]"
      }
      style={{ fontSize: `${font.size}px` }}
      onKeyDownCapture={(e) => handleFontKey(e, font)}
    >
      {/* drag handle + tile chrome — only when standalone; embedded host owns chrome */}
      {!embedded && (
        <header className="tile-drag-handle h-8 flex items-center gap-2 px-2.5 bg-[var(--color-bg3)] border-b border-[var(--color-line)] text-[11px] font-mono text-[var(--color-fg2)] cursor-grab active:cursor-grabbing">
          <GripVertical aria-hidden size={13} className="text-[var(--color-fg3)] -ml-1 shrink-0" />
          <span className="font-semibold text-[var(--color-fg)]">Editor</span>
          {activeMeta?.dirty && (
            <span className="text-[10px] text-[var(--color-warn)]" title="unsaved changes">●</span>
          )}
          {saving && <span className="text-[10px] text-[var(--color-fg3)]">saving…</span>}
          <span className="ml-auto flex items-center gap-2">
            {active && (
              <button
                onClick={() => setDiffMode((m) => ({ ...m, [active]: !m[active] }))}
                className={`nodrag text-[9.5px] px-1.5 py-0.5 rounded border ${
                  activeDiff
                    ? "border-[var(--color-brand)] text-[var(--color-brand)]"
                    : "border-[var(--color-line2)] text-[var(--color-fg3)] hover:text-[var(--color-fg)]"
                }`}
                title="Toggle diff vs HEAD (⇄)"
                aria-label="toggle diff"
              >
                ⇄ {activeDiff ? "diff" : "edit"}
              </button>
            )}
            <span className="text-[9.5px] text-[var(--color-fg3)]">⌘S to save</span>
            <FontStepper {...font} />
          </span>
          <button
            onClick={onClose}
            className="nodrag size-4 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-line2)] hover:text-[var(--color-fg)]"
            aria-label="close tile"
            title="close"
          >×</button>
        </header>
      )}

      {/* tab bar */}
      <div className="nodrag flex items-stretch overflow-x-auto bg-[var(--color-bg2)] border-b border-[var(--color-line)] min-h-[28px]">
        {tabs.length === 0 ? (
          <span className="px-3 py-1.5 text-[11px] text-[var(--color-fg3)]">no files open</span>
        ) : (
          tabs.map((path) => {
            const isActive = path === active;
            const name = path.split("/").pop() ?? path;
            const dirty = meta[path]?.dirty;
            return (
              <div
                key={path}
                role="tab"
                aria-selected={isActive}
                title={path}
                onClick={() => setActive(path)}
                className={`group flex items-center gap-1.5 px-2.5 max-w-[200px] cursor-pointer border-r border-[var(--color-line)] text-[11px] ${
                  isActive
                    ? "bg-[var(--color-bg2)] text-[var(--color-fg)] border-b-2 border-b-[var(--color-brand)]"
                    : "bg-[var(--color-bg3)] text-[var(--color-fg2)] hover:text-[var(--color-fg)]"
                }`}
              >
                <span className="truncate font-mono">{name}</span>
                {isActive && isMarkdownPath(path) && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setPreviewMode((m) => ({ ...m, [path]: !m[path] }));
                    }}
                    className={`text-[9px] leading-none px-1 rounded ${
                      previewMode[path]
                        ? "bg-[var(--color-brand)] text-white"
                        : "text-[var(--color-fg3)] hover:text-[var(--color-fg)]"
                    }`}
                    title={previewMode[path] ? "edit (show source)" : "preview rendered markdown"}
                    aria-label="toggle markdown preview"
                  >◉</button>
                )}
                {isActive && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setDiffMode((m) => ({ ...m, [path]: !m[path] }));
                    }}
                    className={`text-[9px] leading-none px-1 rounded ${
                      diffMode[path]
                        ? "bg-[var(--color-brand)] text-white"
                        : "text-[var(--color-fg3)] hover:text-[var(--color-fg)]"
                    }`}
                    title={diffMode[path] ? "exit diff (show as editor)" : "show diff vs HEAD"}
                    aria-label="toggle diff"
                  >⇄</button>
                )}
                <span className="grid place-items-center w-3.5 h-3.5">
                  {dirty ? (
                    <span
                      aria-hidden
                      className="size-1.5 rounded-full bg-[var(--color-warn)] group-hover:hidden"
                      title="unsaved"
                    />
                  ) : null}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      buffers.current.delete(path);
                      onCloseTab(path);
                    }}
                    className={`text-[var(--color-fg3)] hover:text-[var(--color-fg)] leading-none ${dirty ? "hidden group-hover:block" : ""}`}
                    aria-label={`close ${name}`}
                    title="close tab"
                  >×</button>
                </span>
              </div>
            );
          })
        )}
      </div>

      {/* Changed-on-disk banner: the file was edited externally while this tab
          had unsaved changes. Non-destructive — the user picks Reload or Keep. */}
      {activeMeta?.diskChanged && (
        <div className="nodrag flex items-center gap-2 px-3 py-1.5 bg-[var(--color-bg4)] border-b border-[var(--color-warn)] text-[11px] text-[var(--color-fg)]">
          <span className="text-[var(--color-warn)]">●</span>
          <span>This file changed on disk and you have unsaved edits.</span>
          <button
            onClick={() => void reloadFromDisk()}
            className="ml-auto px-2 py-0.5 rounded border border-[var(--color-line2)] hover:bg-[var(--color-bg2)]"
            title="discard your edits and load the version on disk"
          >Reload</button>
          <button
            onClick={keepMine}
            className="px-2 py-0.5 rounded border border-[var(--color-line2)] hover:bg-[var(--color-bg2)]"
            title="keep your edits (saving will overwrite the disk version)"
          >Keep mine</button>
        </div>
      )}
      {/* editor body — nowheel so scrolling doesn't pan the canvas */}
      <div className="relative flex-1 min-h-0">
        {tabs.length === 0 ? (
          <div className="p-4 text-[11px] text-[var(--color-fg3)]">
            Open a file from the tree to start editing.
          </div>
        ) : activeMeta?.error ? (
          <div className="p-3 text-[11px] text-[var(--color-err)] font-mono">
            <div className="font-semibold mb-1">failed</div>
            <div className="text-[var(--color-fg3)]">{activeMeta.error}</div>
          </div>
        ) : null}
        <div
          ref={hostRef}
          className="absolute inset-0 h-full w-full"
          style={{
            visibility:
              tabs.length > 0 && !activeMeta?.error && !(activeMarkdown && activePreview)
                ? "visible"
                : "hidden",
          }}
        />
        {/* Markdown preview overlay — replaces the CodeMirror surface for a
            markdown tab in Preview mode. The editor stays mounted (hidden) so
            toggling back is instant and the doc/undo history is preserved. */}
        {activeMarkdown && activePreview && !activeMeta?.error && (
          <Suspense
            fallback={
              <div className="absolute inset-0 grid place-items-center text-[11px] text-[var(--color-fg3)]">
                rendering…
              </div>
            }
          >
            <MarkdownPreview source={previewSource} />
          </Suspense>
        )}
      </div>
    </div>
  );
}
