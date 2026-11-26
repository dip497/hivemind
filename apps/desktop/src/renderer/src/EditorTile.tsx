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
import { ExternalLink, GripVertical } from "./components/icons";
import { Button } from "./components/ui/button";
import { useTileFont, FontStepper, handleFontKey } from "./tile-font";
import { FullscreenShell, useReparentFullscreen } from "./tile-fullscreen";
import { EditorState, type Extension, Compartment } from "@codemirror/state";
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, rectangularSelection, crosshairCursor, highlightSpecialChars, dropCursor, hoverTooltip,
} from "@codemirror/view";
import { createRoot } from "react-dom/client";
import { autocompletion, closeBrackets, closeBracketsKeymap, completeAnyWord, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import {
  HighlightStyle,
  syntaxHighlighting,
  indentOnInput,
  bracketMatching,
  foldGutter,
  foldKeymap,
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
import { getTheme, useThemeField } from "./theme-store";
import { htmlFileUrl, isHtmlPath } from "./browser-open";
import { actionKey, keyLabel } from "./shortcut";
import { toast } from "sonner";
import { blameGutter, setBlame } from "./code/blame-gutter";
import { OpenFiles } from "./editor-files";
import { readCodeFile, writeCodeFile } from "./code-files";
import { codeComments } from "./code/code-comments";
import { CodeCommentLayer, CommentLayerBus, storeMoves } from "./code/CodeCommentLayer";
import { reportUnsaved } from "./tile-close-guard";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./components/ui/dialog";
import { codeIntel, type EditedFile } from "./code/code-intel";
import { AfterTyping, OneAtATime } from "./code/code-asks";
import { OutlinePanel } from "./code/OutlinePanel";
import { CodeHoverText, CodeResults } from "./code/CodeResults";
import type { Answer, CodeSymbol } from "@hivemind/code-intel/contract";
// Lazy: marked + DOMPurify (and, on demand, mermaid) load only when the user
// actually opens Preview — opening an editor tile pulls in zero markdown code.
const MarkdownPreview = lazy(() =>
  import("./markdown-preview").then((m) => ({ default: m.MarkdownPreview })),
);

/** Files that get a Preview (rendered markdown) toggle. */
const isMarkdownPath = (p: string): boolean => /\.(md|markdown|mdown|mkd|mdx)$/i.test(p);
const isImagePath = (p: string): boolean => /\.(png|jpe?g|gif|webp|bmp|ico|avif|tiff?)$/i.test(p);

interface Props {
  /** The tile it is in: closing it with unsaved files asks first, and questions about code are sent from it. */
  tileId?: string;
  repoPath: string;
  /** Repo-relative paths of every open tab (Canvas owns this list). */
  tabs: string[];
  /** Remove a tab from Canvas state. */
  onCloseTab: (path: string) => void;
  /** Activate-this-file request from the host (tree click). The `seq` makes
   *  re-selecting an already-open file a fresh request, so clicking a file that's
   *  already a tab switches back to it instead of being a no-op. */
  activeReq?: { path: string; seq: number; diff?: boolean; line?: number; col?: number } | null;
  /** Open a URL in the frame's browser tile. */
  onOpenInBrowser?: (url: string) => void;
  /** Close the whole tile. Omitted when embedded (the host owns chrome). */
  onClose?: () => void;
  /** When true, render only the tab bar + editor body — no outer tile chrome
   *  (border/shadow/header). Used by WorkbenchTile, which supplies its own
   *  shell. Defaults to false so the standalone tile keeps working. */
  embedded?: boolean;
  /** History in Changes: a file's history, or the commit a blame mark names. */
  onShowHistory?: (req: { file?: string; sha?: string }) => void;
  /** Show an image the editor cannot open as text in the image viewer. Omitted: no such action. */
  onOpenImage?: (path: string) => void;
  /** Open a file of the repo at a line (a definition in another file), as a find result opens. */
  onOpenAt?: (path: string, line: number, col: number) => void;
  /** The file shown now, each time it changes; null when none. */
  onShownFile?: (path: string | null) => void;
}

/** The name under column `col` of `line`, for the usages list's title. */
function wordAround(line: string, col: number): string {
  const isWord = (c: string | undefined) => !!c && /[\p{L}\p{N}_$]/u.test(c);
  let start = col;
  let end = col;
  while (isWord(line[start - 1])) start--;
  while (isWord(line[end])) end++;
  return line.slice(start, end);
}

/** Whether the Outline shows, remembered per tile. */
const OUTLINE_KEY = (id: string) => `hm:codeOutline:${id}`;
const readOutlineOn = (id: string): boolean => { try { return localStorage.getItem(OUTLINE_KEY(id)) === "1"; } catch { return false; } };
const writeOutlineOn = (id: string, on: boolean): void => { try { localStorage.setItem(OUTLINE_KEY(id), on ? "1" : "0"); } catch { /* storage blocked */ } };

// ── theme ─────────────────────────────────────────────────────────────────
// CodeMirror theme bound to the app's --color-* tokens (see styles.css).
const cmThemeSpec: Parameters<typeof EditorView.theme>[0] = {
    "&": {
      height: "100%",
      backgroundColor: "var(--color-bg2)",
      color: "var(--color-fg)",
      // Inherit from the tile root, which carries the per-tile font size (so
      // A−/A+ scales the editor). See useTileFont in EditorTile.
      fontSize: "inherit",
    },
    ".cm-scroller": {
      fontFamily: "var(--font-mono)",
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
      { backgroundColor: "var(--color-selection)" },
    ".cm-gutters": {
      backgroundColor: "var(--color-bg2)",
      color: "var(--color-fg3)",
      border: "none",
    },
    ".cm-activeLineGutter": { backgroundColor: "var(--color-bg3)" },
    ".cm-activeLine": { backgroundColor: "var(--color-current-line)" },
    ".cm-foldPlaceholder": {
      backgroundColor: "var(--color-bg4)",
      border: "none",
      color: "var(--color-fg3)",
    },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
      backgroundColor: "var(--color-bracket-match)",
      outline: "none",
    },
    // Highlight of all matches of the current selection (highlightSelectionMatches).
    ".cm-selectionMatch": { backgroundColor: "var(--color-match)" },
    // Find/replace panel (search({ top: true })) — themed to the app tokens so
    // it doesn't render as the default light-grey browser bar.
    ".cm-panels": {
      backgroundColor: "var(--color-bg3)",
      color: "var(--color-fg)",
      borderBottom: "1px solid var(--color-line2)",
    },
    ".cm-panel.cm-search": { padding: "5px 8px", fontFamily: "var(--font-sans)", fontSize: "var(--text-label)" },
    ".cm-panel.cm-search label": { color: "var(--color-fg2)", fontSize: "var(--text-count)" },
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
};
/** The colours are tokens either way; `dark` picks CodeMirror's own defaults (panels, tooltips). */
const cmThemes = { dark: EditorView.theme(cmThemeSpec, { dark: true }), light: EditorView.theme(cmThemeSpec, { dark: false }) };
/** One compartment for the editor theme, so a mode change swaps it in an open editor. */
const themeCompartment = new Compartment();
const themeFor = (mode: "dark" | "light") => themeCompartment.of(cmThemes[mode]);

const highlightStyle = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--color-syntax-comment)", fontStyle: "italic" },
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], color: "var(--color-syntax-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--color-syntax-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--color-syntax-number)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--color-syntax-function)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--color-syntax-type)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--color-syntax-property)" },
  { tag: [t.tagName], color: "var(--color-syntax-tag)" },
  { tag: [t.variableName, t.definition(t.variableName)], color: "var(--color-fg)" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "var(--color-fg2)" },
  { tag: [t.heading], color: "var(--color-syntax-function)", fontWeight: "bold" },
  { tag: [t.link, t.url], color: "var(--color-syntax-function)", textDecoration: "underline" },
  { tag: [t.invalid], color: "var(--color-err)" },
]);

// What CodeMirror's own basicSetup carries, from its official packages, not written here: the
// pieces below and closeBrackets, completion (each language's own source where it has one, else
// the words already in the file), special characters shown, the drop cursor, and the keys for
// brackets, completion and folding.
const baseExtensions: Extension = [
  lineNumbers(),
  highlightSpecialChars(),
  dropCursor(),
  closeBrackets(),
  autocompletion({ activateOnTyping: true, maxRenderedOptions: 50 }),
  EditorState.languageData.of(() => [{ autocomplete: completeAnyWord }]),
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
  EditorView.lineWrapping,
  // searchKeymap LAST so Mod-f / Mod-g / etc. win over any default binding.
  keymap.of([...closeBracketsKeymap, ...completionKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap, indentWithTab]),
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

/** A file with edits not yet saved: a 6px dot in the second text colour, never amber, since an
 *  unsaved file does not wait on the person (DESIGN.md, Modified marker). */
function UnsavedMark({ className = "" }: { className?: string }) {
  return <span role="img" aria-label="unsaved changes" title="unsaved changes" data-unsaved className={`size-1.5 shrink-0 rounded-full bg-[var(--color-fg2)] ${className}`} />;
}

interface TabState {
  loaded: boolean;
  error: string | null;
  dirty: boolean;
  /** The file changed on disk while this tab had UNSAVED edits — set by the fs
   *  watcher so the UI can offer Reload / Keep mine instead of clobbering. */
  diskChanged?: boolean;
  /** Why it is not shown as text: binary, or too large. Never saved. */
  notText?: string;
}

export function EditorTile({ tileId, repoPath, tabs, onCloseTab, onClose, activeReq, onOpenInBrowser, embedded = false, onShowHistory, onOpenImage, onOpenAt, onShownFile }: Props) {
  // Per-tile font size (A−/A+ + Ctrl/Cmd +/−/0). The CM theme uses fontSize:
  // "inherit", so the size set on the root below flows into the editor.
  const font = useTileFont(`editor:${repoPath}`, 13);
  const [active, setActive] = useState<string | null>(tabs[0] ?? null);
  // Per-tab flags for the UI, keyed by repo-relative path; the text, its editor state and what was
  // last saved live in `files`.
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
  // Fullscreen: move the live CodeMirror .cm-editor node into the shared shell's
  // glass panel and back (state + undo history preserved — we only reparent it).
  const [overlay, setOverlay] = useState(false);
  const overlayHostRef = useRef<HTMLDivElement | null>(null);
  useReparentFullscreen({
    open: overlay,
    node: () => viewRef.current?.dom,
    homeRef: hostRef,
    hostRef: overlayHostRef,
    afterMove: () => viewRef.current?.requestMeasure(),
  });
  const langCompartment = useRef(new Compartment());
  // unifiedMergeView is reconfigured per tab — also a Compartment so we can
  // toggle without rebuilding state.
  const diffCompartment = useRef(new Compartment());
  // Blame, per tab: the gutter, and a refresh 300 ms after the text stops changing while it shows.
  const blameCompartment = useRef(new Compartment());
  const [blameOn, setBlameOn] = useState<Record<string, boolean>>({});
  const blameEdited = useRef<(() => void) | null>(null);
  const showHistoryRef = useRef(onShowHistory);
  showHistoryRef.current = onShowHistory;
  // Bumped each time a tab's state is mounted, which drops what was configured on the one before.
  const [mounted, setMounted] = useState(0);
  // One editor state per open file, so a switch keeps its undo, cursor and scroll; another repo's are dropped.
  const files = useRef(new OpenFiles());
  const filesRepo = useRef(repoPath);
  if (filesRepo.current !== repoPath) { filesRepo.current = repoPath; files.current = new OpenFiles(); }
  // An unsaved tab whose close waits on Save / Don't save / Cancel.
  const [closing, setClosing] = useState<string | null>(null);
  // Comments on code: what the editor tells the layer drawn over it.
  const bus = useRef(new CommentLayerBus());
  const bodyRef = useRef<HTMLDivElement>(null);
  const getView = useCallback(() => viewRef.current, []);
  const getFiles = useCallback(() => files.current, []);

  // Code intelligence (code/code-intel.ts): a typed key only bumps the file's version; the outline is
  // read 300 ms after typing stops; one definition and one usages question open at a time.
  const versions = useRef(new Map<string, number>());
  const outlineKey = tileId ?? `editor:${repoPath}`;
  const [outlineOn, setOutlineOn] = useState(() => readOutlineOn(outlineKey));
  const [outline, setOutline] = useState<{ path: string; symbols: CodeSymbol[] | null; cursorLine: number } | null>(null);
  const [results, setResults] = useState<{ title: string; ask: object; answer: Answer<"references"> | null; loading: boolean; error?: string } | null>(null);
  const resultsOpen = useRef(false);
  resultsOpen.current = !!results;
  const definitionAsk = useRef(new OneAtATime());
  const usagesAsk = useRef(new OneAtATime());
  const hoverAsk = useRef<{ cancel(): void } | null>(null);
  const stopHover = () => { hoverAsk.current?.cancel(); hoverAsk.current = null; };
  const edited = (view: EditorView, path: string): EditedFile => {
    const unsaved = files.current.unsaved(path, view);
    return { repo: repoPath, file: path, version: versions.current.get(path) ?? 0, text: unsaved ? view.state.doc.toString() : "", unsaved };
  };
  const placeAt = (view: EditorView, pos: number) => {
    const line = view.state.doc.lineAt(pos);
    return { line: line.number, col: pos - line.from };
  };
  const goTo = (view: EditorView, path: string, line: number, col: number) => {
    if (path === activeRef.current) {
      const doc = view.state.doc;
      const l = doc.line(Math.min(Math.max(1, line), doc.lines));
      const at = Math.min(l.from + col, l.to);
      view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: "center" }) });
      view.focus();
    } else onOpenAtRef.current?.(path, line, col);
  };
  const onOpenAtRef = useRef(onOpenAt);
  onOpenAtRef.current = onOpenAt;
  const intel = useRef({
    definition: (_view: EditorView, _path: string, _pos: number) => {},
    usages: (_view: EditorView, _path: string, _pos: number) => {},
    hover: (_view: EditorView, _path: string, _pos: number): ReturnType<typeof codeIntel.hover> | null => null,
  });
  intel.current = {
    definition: (view, path, pos) => {
      if (!codeIntel.knows(path)) return;
      // Taken back when the cursor moves or another tab is shown, so an answer lands only where it was asked.
      definitionAsk.current.start(codeIntel.definition(edited(view, path), placeAt(view, pos)), (a) => {
        const first = a?.value[0];
        if (!first) { if (a) toast("No definition found"); return; }
        goTo(view, first.file, first.span.start.line, first.span.start.col);
      }, (e) => toast.error((e as Error).message));
    },
    usages: (view, path, pos) => {
      if (!codeIntel.knows(path)) return;
      const at = placeAt(view, pos);
      const word = wordAround(view.state.doc.line(at.line).text, at.col);
      const title = `Usages${word ? ` of ${word}` : ""}`;
      type Results = NonNullable<typeof results>;
      const ofThisAsk = (next: (r: Results) => Results) => setResults((r) => (r && r.ask === asked ? next(r) : r));
      const asked = codeIntel.usages(edited(view, path), at, (a) => ofThisAsk((r) => ({ ...r, answer: a })));
      setResults({ title, ask: asked, answer: null, loading: true });
      usagesAsk.current.start(asked,
        (a) => ofThisAsk((r) => ({ ...r, answer: a ?? r.answer, loading: false })),
        (e) => ofThisAsk((r) => ({ ...r, loading: false, error: (e as Error).message })));
    },
    hover: (view, path, pos) => {
      stopHover();
      if (!codeIntel.knows(path)) return null;
      const asked = codeIntel.hover(edited(view, path), placeAt(view, pos));
      hoverAsk.current = asked;
      const settled = () => { if (hoverAsk.current === asked) hoverAsk.current = null; };
      asked.answer.then(settled, settled);
      return asked;
    },
  };
  const outlineTimer = useRef<AfterTyping | null>(null);
  const repoRef = useRef(repoPath);
  repoRef.current = repoPath;
  const outlineOnRef = useRef(outlineOn);
  outlineOnRef.current = outlineOn;
  outlineTimer.current ??= new AfterTyping(300, () => {
    const view = viewRef.current;
    const path = activeRef.current;
    if (!view || !path || !outlineOnRef.current || files.current.shownPath() !== path) return;
    const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number;
    if (!codeIntel.knows(path)) { setOutline({ path, symbols: null, cursorLine }); return; }
    const version = versions.current.get(path) ?? 0;
    void codeIntel.outline({ repo: repoRef.current, file: path, text: view.state.doc.toString(), version }).then((a) => {
      if (a) setOutline({ path, symbols: a.value, cursorLine });
    }, () => setOutline({ path, symbols: null, cursorLine }));
  });
  useEffect(() => () => { outlineTimer.current?.stop(); definitionAsk.current.cancel(); usagesAsk.current.cancel(); stopHover(); }, []);

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
  const onShownFileRef = useRef(onShownFile);
  onShownFileRef.current = onShownFile;
  useEffect(() => { onShownFileRef.current?.(active); }, [active]);

  // A Changes-panel open requests diff mode for that file (editable inline merge
  // vs HEAD). Independent of activation so re-opening the same file re-arms it.
  useEffect(() => {
    if (activeReq?.diff) setDiffMode((m) => (m[activeReq.path] ? m : { ...m, [activeReq.path]: true }));
  }, [activeReq]);

  // A request at a line (a find result): the cursor there and the line in sight, once that tab's
  // text is in the editor; again for the same file at another line.
  const pendingLine = useRef<{ path: string; line: number; col: number } | null>(null);
  useEffect(() => {
    if (activeReq?.line) pendingLine.current = { path: activeReq.path, line: activeReq.line, col: activeReq.col ?? 0 };
  }, [activeReq]);
  useEffect(() => {
    const view = viewRef.current;
    const want = pendingLine.current;
    if (!view || !want || want.path !== active || files.current.shownPath() !== active) return;
    const doc = view.state.doc;
    if (doc.length === 0 && want.line > 1) return;
    pendingLine.current = null;
    const line = doc.line(Math.min(Math.max(1, want.line), doc.lines));
    const at = Math.min(line.from + want.col, line.to);
    view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: "center" }) });
    view.focus();
  });

  // Drop the editor states, meta and diffMode of closed tabs.
  useEffect(() => {
    const set = new Set(tabs);
    files.current.keepOnly(set, viewRef.current);
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
      setPreviewSource(files.current.stateOf(active, viewRef.current)?.doc.toString() ?? "");
    }
  }, [active, previewMode]);

  const markDirty = useCallback((path: string, dirty: boolean) => {
    setMeta((m) => {
      const cur = m[path];
      if (cur && cur.dirty === dirty) return m;
      return { ...m, [path]: { ...(cur ?? { loaded: true, error: null, dirty }), dirty } };
    });
  }, []);

  /** Save `path` with its own line ending; true once it is on disk. */
  const save = useCallback(async (path: string): Promise<boolean> => {
    const out = files.current.toSave(path, viewRef.current);
    if (!out) return false;
    setSaving(true);
    try {
      await writeCodeFile(repoPath, path, out.text);
      files.current.markSaved(path, out.doc);
      storeMoves(repoPath, files.current.stateOf(path, viewRef.current));
      const dirty = files.current.unsaved(path, viewRef.current);
      setMeta((m) => ({ ...m, [path]: { ...(m[path] ?? { loaded: true, error: null }), dirty, diskChanged: false } }));
      return true;
    } catch (e) {
      toast.error(`Could not save ${path.split("/").pop()}`, { description: (e as Error).message });
      return false;
    } finally {
      setSaving(false);
    }
  }, [repoPath]);

  // Stable ref so the CM save keymap always calls the latest `save`.
  const saveRef = useRef(save);
  useEffect(() => { saveRef.current = save; }, [save]);

  // Live tabs/active for the fs watcher (so it subscribes once per repo, not on
  // every tab switch).
  const tabsRef = useRef(tabs); tabsRef.current = tabs;
  const activeRef = useRef(active); activeRef.current = active;

  // Closing the whole tile with unsaved files asks first: the tile host reads them when it closes.
  useEffect(() => {
    if (!tileId) return;
    reportUnsaved(tileId, () => {
      const unsaved = tabsRef.current.filter((p) => files.current.unsaved(p, viewRef.current));
      return {
        files: unsaved,
        saveAll: async () => {
          for (const p of unsaved) if (!(await saveRef.current(p))) return false;
          return true;
        },
      };
    });
    return () => reportUnsaved(tileId, null);
  }, [tileId]);

  // Reload the active tab from disk over its unsaved edits (the changed-on-disk banner's Reload), as
  // one change that undo takes back.
  const reloadFromDisk = useCallback(async () => {
    const path = activeRef.current;
    if (!path) return;
    try {
      const disk = await readCodeFile(repoPath, path);
      if (files.current.fromDisk(path, disk, viewRef.current, true) === "applied") storeMoves(repoPath, files.current.stateOf(path, viewRef.current));
      setMeta((m) => ({ ...m, [path]: { loaded: true, error: null, dirty: files.current.unsaved(path, viewRef.current) } }));
    } catch { /* unreadable (deleted?) — leave the buffer as-is */ }
  }, [repoPath]);

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
        if (!files.current.has(tab) || !abs.some((p) => p === `${repoPath}/${tab}` || p.endsWith(`/${tab}`))) continue;
        let disk: string;
        try {
          disk = await readCodeFile(repoPath, tab);
        } catch {
          continue; // deleted / unreadable — leave as-is
        }
        const result = files.current.fromDisk(tab, disk, viewRef.current);
        if (result === "conflict") {
          setMeta((m) => (m[tab] ? { ...m, [tab]: { ...m[tab]!, diskChanged: true } } : m));
        } else {
          if (result === "applied") storeMoves(repoPath, files.current.stateOf(tab, viewRef.current));
          markDirty(tab, files.current.unsaved(tab, viewRef.current));
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
  }, [repoPath, markDirty]);

  // Mount the EditorView once. Tab switches swap state via view.setState.
  useEffect(() => {
    if (!hostRef.current || viewRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: "",
        extensions: [
          baseExtensions,
          themeFor(getTheme().mode),
          langCompartment.current.of([]),
          diffCompartment.current.of([]),
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

  // The theme's mode, applied to the open editor as it changes.
  const mode = useThemeField("mode");
  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeCompartment.reconfigure(cmThemes[mode]) });
  }, [mode]);

  // Show the active tab: its own editor state when it is open, else read from disk first.
  useEffect(() => {
    const view = viewRef.current;
    const path = active;
    if (!view || !path) return;
    // Another file takes the editor: a definition or hover asked about the one before is not wanted.
    definitionAsk.current.cancel();
    stopHover();
    const shown = () => {
      view.dispatch({ effects: themeCompartment.reconfigure(cmThemes[getTheme().mode]) });
      setMounted((n) => n + 1);
    };
    if (files.current.show(path, view)) return shown();
    let cancelled = false;

    const extensionsFor = (lang: LanguageSupport | null): Extension => [
      baseExtensions,
      themeFor(getTheme().mode),
      langCompartment.current.of(lang ? lang : []),
      diffCompartment.current.of([]),
      blameCompartment.current.of([]),
      codeComments((ids) => bus.current.openThread(ids)),
      EditorView.updateListener.of((u) => {
        bus.current.updated(u);
        if (u.selectionSet || u.docChanged) {
          // The cursor moved: a definition still being looked up is not wanted any more.
          definitionAsk.current.cancel();
          if (outlineOnRef.current) outlineTimer.current?.poke();
        }
        if (!u.docChanged) return;
        const version = (versions.current.get(path) ?? 0) + 1;
        versions.current.set(path, version);
        codeIntel.edited({ repo: repoPath, file: path, version });
        blameEdited.current?.();
        markDirty(path, files.current.unsaved(path, u.view));
      }),
      keymap.of([
        { key: "Mod-s", preventDefault: true, run: () => { void saveRef.current(path); return true; } },
        { key: "F12", preventDefault: true, run: (v) => { intel.current.definition(v, path, v.state.selection.main.head); return true; } },
        { key: "Shift-F12", preventDefault: true, run: (v) => { intel.current.usages(v, path, v.state.selection.main.head); return true; } },
        { key: "Escape", run: () => { if (!resultsOpen.current) return false; usagesAsk.current.cancel(); setResults(null); return true; } },
      ]),
      EditorView.domEventHandlers({
        mousedown: (e, v) => {
          if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return false;
          const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
          if (pos === null) return false;
          e.preventDefault();
          intel.current.definition(v, path, pos);
          return true;
        },
        mouseleave: () => { stopHover(); return false; },
      }),
      hoverTooltip((v, pos) => {
        const asked = intel.current.hover(v, path, pos);
        if (!asked) return null;
        return asked.answer.then((a) => (a?.value ? {
          pos,
          above: true,
          create: () => {
            const dom = document.createElement("div");
            const root = createRoot(dom);
            root.render(<CodeHoverText answer={a} />);
            return { dom, destroy: () => root.unmount() };
          },
        } : null), () => null);
      }, { hoverTime: 300 }),
      EditorView.editable.of(true),
    ];

    void (async () => {
      try {
        const [disk, lang] = await Promise.all([readCodeFile(repoPath, path), languageFor(path)]);
        if (cancelled) return;
        if (!files.current.has(path)) files.current.open(path, disk, extensionsFor(lang));
        files.current.show(path, view);
        shown();
        setMeta((m) => ({ ...m, [path]: { loaded: true, error: null, dirty: files.current.unsaved(path, view) } }));
      } catch (e) {
        if (cancelled) return;
        const msg = (e as Error).message;
        // Binary or too large: said plainly, never shown as text, so never saved over.
        const code = (e as { code?: string }).code;
        if (code === "UNSUPPORTED" || code === "FILE_TOO_BIG") {
          setMeta((m) => ({ ...m, [path]: { loaded: true, error: null, dirty: false, notText: msg } }));
          return;
        }
        // A tab that can't be read (e.g. a directory slipped through → EISDIR,
        // or a deleted file) must NOT poison the editor: drop it instead of
        // leaving a stuck, selected "failed" tab that blocks focusing others.
        if (/EISDIR|illegal operation on a directory|ENOENT/i.test(msg)) {
          onCloseTab(path);
          return;
        }
        setMeta((m) => ({ ...m, [path]: { loaded: true, error: msg, dirty: false } }));
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

  // Blame of the text on screen (git.blame with it), so an edited line reads as not committed yet
  // instead of naming the wrong commit; again 300 ms after the text stops changing, never while it
  // does. The host stops the one before when the next of the same file starts.
  useEffect(() => {
    const view = viewRef.current;
    const path = active;
    blameEdited.current = null;
    if (!view || !path) return;
    if (!blameOn[path]) {
      view.dispatch({ effects: blameCompartment.current.reconfigure([]) });
      return;
    }
    view.dispatch({ effects: blameCompartment.current.reconfigure(blameGutter((sha) => showHistoryRef.current?.({ sha }))) });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let gone = false;
    const ask = () => {
      void window.hive.gitBlame(repoPath, path, { contents: view.state.doc.toString() }).then((b) => {
        if (!gone && view === viewRef.current) view.dispatch({ effects: setBlame.of(b.hunks) });
      }).catch((e: Error) => {
        // Superseded by the next blame of this file: that one answers.
        if (gone || /superseded/i.test(e.message)) return;
        toast.error("blame failed", { description: e.message });
        setBlameOn((m) => ({ ...m, [path]: false }));
      });
    };
    ask();
    blameEdited.current = () => { clearTimeout(timer); timer = setTimeout(ask, 300); };
    return () => { gone = true; clearTimeout(timer); blameEdited.current = null; };
  }, [blameOn, active, repoPath, mounted]);

  // The outline of the file in view: read now when it opens or the tab changes, then after typing.
  useEffect(() => {
    if (outlineOn) outlineTimer.current?.now();
    else outlineTimer.current?.stop();
  }, [outlineOn, active, mounted]);
  const toggleOutline = () => setOutlineOn((on) => { writeOutlineOn(outlineKey, !on); return !on; });

  const activeMeta = active ? meta[active] : undefined;
  const activeShown = !!active && files.current.shownPath() === active;
  /** Close a tab; one with unsaved edits asks first. */
  const askClose = (path: string) => {
    if (files.current.unsaved(path, viewRef.current)) setClosing(path);
    else onCloseTab(path);
  };
  const closeAfterSave = async (path: string) => {
    setClosing(null);
    if (await save(path)) onCloseTab(path);
  };
  const openInSystemApp = async (path: string) => {
    const r = await window.hive.openPathInApp?.(repoPath, path);
    if (r && !r.ok) toast.error("Could not open it with your system app", { description: r.error });
  };
  const activeDiff = active ? !!diffMode[active] : false;
  const activeMarkdown = active ? isMarkdownPath(active) : false;
  const activeHtml = active ? isHtmlPath(active) : false;
  const activeHtmlUrl = active ? htmlFileUrl(repoPath, active) : null;
  const activePreview = active ? !!previewMode[active] : false;

  return (
    <div
      className={
        embedded
          ? "hm-glass-embed flex h-full flex-col bg-[var(--color-bg2)] overflow-hidden min-w-0"
          : "hm-glass-surface flex h-full flex-col rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] overflow-hidden shadow-[var(--hm-shadow-float)]"
      }
      style={{ fontSize: `${font.size}px` }}
      onKeyDownCapture={(e) => handleFontKey(e, font)}
    >
      {/* drag handle + tile chrome — only when standalone; embedded host owns chrome */}
      {!embedded && (
        <header className="tile-drag-handle h-8 flex items-center gap-2 px-2.5 bg-[var(--color-bg3)] border-b border-[var(--color-line)] text-count font-mono text-[var(--color-fg2)] cursor-grab active:cursor-grabbing">
          <GripVertical size={13} className="text-[var(--color-fg3)] -ml-1 shrink-0" />
          <span className="font-semibold text-[var(--color-fg)]">Editor</span>
          {activeMeta?.dirty && <UnsavedMark />}
          {saving && <span className="text-chip text-[var(--color-fg3)]">saving…</span>}
          <span className="ml-auto flex items-center gap-2">
            {active && (
              <>
              {activeHtml && activeHtmlUrl && onOpenInBrowser && (
                <Button
                  variant="ghost"
                  size="icon-2xs"
                  onClick={() => onOpenInBrowser(activeHtmlUrl)}
                  className="nodrag"
                  title="Open HTML in browser tile"
                  aria-label="open HTML in browser"
                >
                  <ExternalLink />
                </Button>
              )}
              <Button
                variant={activeDiff ? "secondary" : "outline"}
                size="2xs"
                onClick={() => setDiffMode((m) => ({ ...m, [active]: !m[active] }))}
                className="nodrag"
                title="Toggle diff vs HEAD (⇄)"
                aria-label="toggle diff"
              >
                ⇄ {activeDiff ? "diff" : "edit"}
              </Button>
              </>
            )}
            <span className="text-chip text-[var(--color-fg3)]">{keyLabel("mod+s")} to save</span>
            <FontStepper {...font} />
          </span>
          <Button
            variant="ghost"
            size="icon-micro"
            onClick={onClose}
            className="nodrag"
            aria-label="close tile"
            title="close"
          >×</Button>
        </header>
      )}

      {/* tab bar */}
      <div className="nodrag flex items-stretch overflow-x-auto bg-[var(--color-bg2)] border-b border-[var(--color-line)] min-h-[28px]">
        {tabs.length === 0 ? (
          <span className="px-3 py-1.5 text-count text-[var(--color-fg3)]">no files open</span>
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
                className={`group flex items-center gap-1.5 px-2.5 max-w-[200px] cursor-pointer border-r border-[var(--color-line)] text-count ${
                  isActive
                    ? "bg-[var(--color-bg2)] text-[var(--color-fg)] border-b-2 border-b-[var(--color-brand)]"
                    : "bg-[var(--color-bg3)] text-[var(--color-fg2)] hover:text-[var(--color-fg)]"
                }`}
              >
                <span className="truncate font-mono">{name}</span>
                {isActive && isMarkdownPath(path) && (
                  <Button
                    variant={previewMode[path] ? "default" : "ghost"}
                    size="micro"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPreviewMode((m) => ({ ...m, [path]: !m[path] }));
                    }}
                    title={previewMode[path] ? "edit (show source)" : "preview rendered markdown"}
                    aria-label="toggle markdown preview"
                  >◉</Button>
                )}
                {isActive && isHtmlPath(path) && htmlFileUrl(repoPath, path) && onOpenInBrowser && (
                  <Button
                    variant="ghost"
                    size="icon-micro"
                    onClick={(e) => {
                      e.stopPropagation();
                      const url = htmlFileUrl(repoPath, path);
                      if (url) onOpenInBrowser(url);
                    }}
                    title="open HTML in browser tile"
                    aria-label="open HTML in browser"
                  >
                    <ExternalLink />
                  </Button>
                )}
                {isActive && (
                  <Button
                    variant={blameOn[path] ? "default" : "ghost"}
                    size="micro"
                    onClick={(e) => { e.stopPropagation(); setBlameOn((m) => ({ ...m, [path]: !m[path] })); }}
                    title={blameOn[path] ? "hide blame" : "blame: who last changed each line"}
                    aria-label="toggle blame"
                    aria-pressed={!!blameOn[path]}
                  >blame</Button>
                )}
                {isActive && onShowHistory && (
                  <Button
                    variant="ghost"
                    size="micro"
                    onClick={(e) => { e.stopPropagation(); onShowHistory({ file: path }); }}
                    title="this file's history"
                    aria-label="show this file's history"
                  >history</Button>
                )}
                {isActive && (
                  <Button
                    variant={diffMode[path] ? "default" : "ghost"}
                    size="micro"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDiffMode((m) => ({ ...m, [path]: !m[path] }));
                    }}
                    title={diffMode[path] ? "exit diff (show as editor)" : "show diff vs HEAD"}
                    aria-label="toggle diff"
                  >⇄</Button>
                )}
                <span className="grid place-items-center w-3.5 h-3.5">
                  {dirty ? <UnsavedMark className="group-hover:hidden" /> : null}
                  <Button
                    variant="ghost"
                    size="icon-micro"
                    onClick={(e) => {
                      e.stopPropagation();
                      askClose(path);
                    }}
                    className={dirty ? "hidden group-hover:block" : undefined}
                    aria-label={`close ${name}`}
                    title="close tab"
                  >×</Button>
                </span>
              </div>
            );
          })
        )}
        {/* Fullscreen — in the tab bar so it shows even when the editor is
            embedded in the Workbench (which strips the standalone header).
            Sticky so it stays put when the tabs overflow-scroll. Its tooltip names the
            fit-to-screen key, which leaves from anywhere: Esc is the editor's while you type. */}
        <button
          onClick={toggleOutline}
          className={`nodrag ml-auto sticky right-[34px] shrink-0 px-2 grid place-items-center border-l border-[var(--color-line)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg3)] transition-colors text-count leading-none ${outlineOn ? "bg-[var(--color-bg3)] text-[var(--color-fg)]" : "bg-[var(--color-bg2)] text-[var(--color-fg3)]"}`}
          aria-label="outline"
          aria-pressed={outlineOn}
          title="Outline: the file's classes and functions"
          data-outline-toggle
        >
          outline
        </button>
        <button
          onClick={() => setOverlay((v) => !v)}
          className="nodrag sticky right-0 shrink-0 px-2 grid place-items-center bg-[var(--color-bg2)] border-l border-[var(--color-line)] text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg3)] transition-colors text-label leading-none"
          aria-label="fullscreen editor"
          title={`Fullscreen (${actionKey("fit-to-screen")} to leave)`}
        >
          ⤢
        </button>
      </div>

      {/* Changed-on-disk banner: the file was edited externally while this tab
          had unsaved changes. Non-destructive — the user picks Reload or Keep. */}
      {activeMeta?.diskChanged && (
        <div className="nodrag flex items-center gap-2 px-3 py-1.5 bg-[var(--color-bg4)] border-b border-[var(--color-warn)] text-count text-[var(--color-fg)]">
          <span className="text-[var(--color-warn)]">●</span>
          <span>This file changed on disk and you have unsaved edits.</span>
          <Button
            variant="outline"
            size="xs"
            onClick={() => void reloadFromDisk()}
            className="ml-auto"
            title="discard your edits and load the version on disk"
          >Reload</Button>
          <Button
            variant="outline"
            size="xs"
            onClick={keepMine}
            title="keep your edits (saving will overwrite the disk version)"
          >Keep mine</Button>
        </div>
      )}
      {/* editor body — nowheel so scrolling doesn't pan the canvas */}
      <div ref={bodyRef} className="relative flex-1 min-h-0" style={{ "--code-outline-w": "224px", "--code-results-h": "40%" } as React.CSSProperties}>
        {tabs.length === 0 ? (
          <div className="p-4 text-count text-[var(--color-fg3)]">
            Open a file from the tree to start editing.
          </div>
        ) : activeMeta?.error ? (
          <div className="p-3 text-count text-[var(--color-err)] font-mono">
            <div className="font-semibold mb-1">failed</div>
            <div className="text-[var(--color-fg3)]">{activeMeta.error}</div>
          </div>
        ) : active && activeMeta?.notText ? (
          <div className="p-4 flex flex-col items-start gap-2 text-count text-[var(--color-fg2)]" data-not-text>
            <div>{activeMeta.notText}</div>
            <div className="flex gap-2">
              {onOpenImage && isImagePath(active) && (
                <Button variant="outline" size="xs" onClick={() => onOpenImage(active)}>Open in image viewer</Button>
              )}
              {window.hive.openPathInApp && (
                <Button variant="outline" size="xs" onClick={() => void openInSystemApp(active)}>Open with your system app</Button>
              )}
            </div>
          </div>
        ) : null}
        <div
          ref={hostRef}
          className="absolute inset-y-0 left-0 h-full"
          style={{
            right: outlineOn ? "var(--code-outline-w)" : 0,
            bottom: results ? "var(--code-results-h)" : 0,
            height: "auto",
            visibility:
              activeShown && !activeMeta?.error && !activeMeta?.notText && !(activeMarkdown && activePreview)
                // inherit, not visible: an explicit `visible` shows through a hidden
                // ancestor (an inactive window tab, a parked surface).
                ? "inherit"
                : "hidden",
          }}
        />
        {outlineOn && tabs.length > 0 && (
          <div className="absolute inset-y-0 right-0 w-[var(--code-outline-w)] border-l border-[var(--color-line)]" data-code-outline>
            <OutlinePanel
              symbols={outline && outline.path === active ? outline.symbols : null}
              loading={!outline || outline.path !== active}
              {...(outline && outline.path === active ? { cursorLine: outline.cursorLine } : {})}
              onPick={(at) => { const view = viewRef.current; if (view && active) goTo(view, active, at.line, at.col); }}
            />
          </div>
        )}
        {results && (
          <div className="absolute left-0 bottom-0 h-[var(--code-results-h)] border-t border-[var(--color-line)]" style={{ right: outlineOn ? "var(--code-outline-w)" : 0 }}
            onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); usagesAsk.current.cancel(); setResults(null); viewRef.current?.focus(); } }}>
            <CodeResults title={results.title} answer={results.answer} loading={results.loading} error={results.error}
              onOpen={(file, line, col) => { const view = viewRef.current; if (view) goTo(view, file, line, col); }} />
          </div>
        )}
        {tabs.length > 0 && (
          <CodeCommentLayer repoPath={repoPath} tileId={tileId} tabs={tabs} mounted={mounted} view={getView} files={getFiles} bus={bus.current} box={bodyRef}
            shown={activeShown && !activeMeta?.notText && !activeMeta?.error && !(activeMarkdown && activePreview) ? active : null} />
        )}
        {/* Markdown preview overlay — replaces the CodeMirror surface for a
            markdown tab in Preview mode. The editor stays mounted (hidden) so
            toggling back is instant and the doc/undo history is preserved. */}
        {activeMarkdown && activePreview && activeShown && (
          <Suspense
            fallback={
              <div className="absolute inset-0 grid place-items-center text-count text-[var(--color-fg3)]">
                rendering…
              </div>
            }
          >
            <MarkdownPreview source={previewSource} onOpenLink={onOpenInBrowser && active ? (href) => onOpenInBrowser(/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("/") ? href : `${(active.startsWith("/") ? active : `${repoPath}/${active}`).replace(/[^/]*$/, "")}${href}`) : undefined} />
          </Suspense>
        )}
      </div>
      <Dialog open={!!closing} onOpenChange={(open) => { if (!open) setClosing(null); }}>
        <DialogContent className="sm:max-w-[440px]" data-unsaved-close>
          <DialogTitle>Save changes to {closing?.split("/").pop()}?</DialogTitle>
          <DialogDescription>Your changes are lost if you close it without saving.</DialogDescription>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setClosing(null)}>Cancel</Button>
            <Button variant="outline" onClick={() => { const p = closing; setClosing(null); if (p) onCloseTab(p); }}>Don't save</Button>
            <Button autoFocus onClick={() => { if (closing) void closeAfterSave(closing); }}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {overlay && (
        <FullscreenShell
          title={active ? (active.split("/").pop() ?? "Editor") : "Editor"}
          font={font}
          hostRef={overlayHostRef}
          onClose={() => setOverlay(false)}
        />
      )}
    </div>
  );
}
