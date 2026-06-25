/**
 * DiffTile — @pierre/diffs **CodeView** (1.2.0) feature surface over a real
 * git backend. One virtualized list, worker-pool syntax highlighting, sticky
 * per-file headers, per-file collapse + GitHub-style "viewed" review state.
 *
 * Modes:
 *   - working : per-file diff HEAD↔WORKING (or HEAD↔INDEX when `staged`),
 *               built with parseDiffFromFile so unchanged-context expansion works.
 *   - branch  : `git diff <base>...HEAD` parsed via parsePatchFiles (partial).
 *   - conflict: UnresolvedFile per conflicted file (separate from CodeView).
 *
 * Header slot (renderCustomHeader) wires: collapse chevron · stage/unstage ·
 * path · +adds/−dels · viewed · open · discard.
 *
 * Line comments: gutter "+" (onGutterUtilityClick) opens a composer; comments
 * persist to localStorage and pipe to a live claude PTY via the cross-tile
 * event bus, mirroring GitHub review-comment format.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { GripVertical, Play, RefreshCw, Search, SlidersHorizontal } from "lucide-react";
import { ReviewPopover, CommentBox, ActionToolbar } from "./review-ui";
import { useTileFont, FontStepper, handleFontKey } from "./tile-font";
import {
  CodeView,
  UnresolvedFile,
  WorkerPoolContextProvider,
  type CodeViewHandle,
} from "@pierre/diffs/react";
import {
  parseDiffFromFile,
  parsePatchFiles,
  type AnnotationSide,
  type CodeViewDiffItem,
  type CodeViewItem,
  type CodeViewOptions,
  type DiffLineAnnotation,
  type FileContents,
} from "@pierre/diffs";
import {
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { DiffScope, GitBranchList, GitFileEntry, GitStatusSnapshot } from "../../shared/ipc";
import {
  useDiscardFiles,
  useGitCommit,
  useGitDiff,
  useGitPush,
  useGitStatus,
  useStageFiles,
  useUnstageFiles,
} from "./queries";
import {
  PIERRE_CSS_VARS,
  workerHighlighterOptions,
  workerPoolOptions,
} from "./pierre-codeview";
import { FileTree as PierreFileTree, useFileTree } from "@pierre/trees/react";
import type {
  ContextMenuItem,
  ContextMenuOpenContext,
  FileTreeRowDecoration,
} from "@pierre/trees";
import { DiffReviewPanel } from "./DiffReviewPanel";
import { normalizeComments, newCid, type ReviewComment } from "./diff-comments";

interface Props {
  repoPath: string;
  initialMode?: Mode;
  initialBase?: string;
  onClose?: () => void;
}

type Mode = "working" | "branch" | "unpushed";
type Layout = "split" | "unified";
type Overflow = "scroll" | "wrap";

const COMMENTS_KEY_PREFIX = "hivemind:comments:";
const VIEWED_KEY_PREFIX = "hivemind:viewed:";


function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Which file does a hovered line belong to? Pierre stacks file diffs and gives
 *  the gutter "+" only a line range — not the file. We resolve it by finding the
 *  nearest `data-diff-file` header (on our DiffHeader) that PRECEDES the line in
 *  document order (the hovered line's sticky header is always rendered above it).
 *  Robust to Pierre's gutter API + to view/setting toggles clearing the selection. */
function fileForLineEl(lineEl: HTMLElement | null, container: HTMLElement | null): string | null {
  if (!lineEl || !container) return null;
  let file: string | null = null;
  for (const h of Array.from(container.querySelectorAll<HTMLElement>("[data-diff-file]"))) {
    // header precedes line ⇒ line FOLLOWS header in document order.
    if (h.compareDocumentPosition(lineEl) & Node.DOCUMENT_POSITION_FOLLOWING) {
      file = h.getAttribute("data-diff-file");
    } else break;
  }
  return file;
}

export function DiffTile({ repoPath, initialMode = "working", initialBase = "origin/main", onClose }: Props) {
  // Per-tile font size (A−/A+ + Ctrl/Cmd +/−/0) — overrides --diffs-font-size.
  const font = useTileFont(`diff:${repoPath}`, 13);
  // Chrome (per-file headers + changed-files tree) scales WITH the code font so
  // the whole diff grows together — A+/A− was only sizing the code glyphs, which
  // left the headers/tree looking tiny next to large code. Kept ~15% smaller
  // than the code (mirrors the stock 11px-chrome / 13px-code ratio).
  const chromePx = Math.max(9, Math.round(font.size * 0.85));
  const headerH = Math.round(chromePx * 3.1);
  const [mode, setMode] = useState<Mode>(initialMode);
  // Branch-compare refs (branch mode). `undefined` ⇒ auto: base resolves to
  // origin/HEAD, head defaults to the working checkout (HEAD). Set either to
  // review any two arbitrary branches — no remote PR needed.
  const [branchBase, setBranchBase] = useState<string | undefined>(undefined);
  const [branchHead, setBranchHead] = useState<string | undefined>(undefined);
  const [staged, setStaged] = useState(false);
  const [layout, setLayout] = useState<Layout>("split");
  const [overflow, setOverflow] = useState<Overflow>("scroll");
  // false (default) ⇒ collapse unchanged runs, show only changed hunks + context;
  // true ⇒ expand the whole file. Toggled from the header ("diff"/"full").
  const [expandUnchanged, setExpandUnchanged] = useState(false);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  // Secondary chrome — collapsed by default to de-clutter the header. The
  // "view⋯" popover holds layout/wrap/full/font/refresh; the 🔍 button reveals
  // the in-diff search input on demand.
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // Close the view⋯ popover on outside-click or Escape. Document-level listeners
  // (not a fixed overlay): the tile lives inside a react-flow `.tile-drag-handle`,
  // whose drag/pan system swallows a non-`nodrag` overlay and can pointer-capture
  // `pointerdown`. `mousedown` (capture) is delivered before react-flow reacts and
  // is not retargeted by setPointerCapture; Escape is the keyboard escape hatch.
  const viewMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!viewMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!viewMenuRef.current?.contains(e.target as Node)) setViewMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setViewMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [viewMenuOpen]);

  const [comments, setComments] = useState<ReviewComment[]>(() =>
    normalizeComments(loadJson<unknown>(COMMENTS_KEY_PREFIX + repoPath, [])),
  );
  // Review panel (Figma/GitHub-style) open state — persisted.
  const [reviewOpen, setReviewOpen] = useState<boolean>(
    () => localStorage.getItem("hivemind:review-open") === "1",
  );
  useEffect(() => { localStorage.setItem("hivemind:review-open", reviewOpen ? "1" : "0"); }, [reviewOpen]);
  // File-list sidebar (GitHub-style changed-files tree) open state — persisted.
  const [filesOpen, setFilesOpen] = useState<boolean>(
    () => localStorage.getItem("hivemind:diff-files-open") !== "0",
  );
  useEffect(() => { localStorage.setItem("hivemind:diff-files-open", filesOpen ? "1" : "0"); }, [filesOpen]);
  // Changed-files sidebar width — user-resizable (deep paths need room), persisted.
  const [filesW, setFilesW] = useState<number>(() => {
    const v = Number(localStorage.getItem("hivemind:diff-files-w"));
    return Number.isFinite(v) && v > 0 ? clampFilesW(v) : 280;
  });
  useEffect(() => { localStorage.setItem("hivemind:diff-files-w", String(filesW)); }, [filesW]);
  const filesDragRef = useRef<{ startX: number; startW: number } | null>(null);
  const [viewed, setViewed] = useState<Set<string>>(
    () => new Set(loadJson<string[]>(VIEWED_KEY_PREFIX + repoPath, [])),
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [composer, setComposer] = useState<
    { file: string; startLine: number; endLine: number; side: AnnotationSide; anchor: { x: number; y: number }; stage: "choose" | "comment" } | null
  >(null);
  const [composerDraft, setComposerDraft] = useState("");
  // Clear the draft whenever the composer closes, so a fresh "+" starts empty.
  useEffect(() => { if (!composer) setComposerDraft(""); }, [composer]);

  const codeViewRef = useRef<CodeViewHandle<ReviewComment>>(null);
  // The CodeView wrapper — for popover anchor coords + scoping the file lookup.
  const cvHostRef = useRef<HTMLDivElement>(null);
  // The line element the pointer is currently over (from onLineEnter). The gutter
  // "+" callback gets only a line RANGE — not the file — so we resolve the file
  // from the hovered line's position via the nearest preceding `data-diff-file`
  // header (robust to view/setting changes that clear the selection).
  const hoveredLineRef = useRef<HTMLElement | null>(null);
  // Last line-selection from CodeView (`onSelectedLinesChange`) — fallback file
  // source (its id is `diff:<path>`) when there's no hovered line.
  const selectedRef = useRef<{ id: string; range: { start: number; end: number; side?: AnnotationSide; endSide?: AnnotationSide } } | null>(null);

  const { data: status, isLoading: statusLoading, error: statusError } = useGitStatus(repoPath);
  const stageMut = useStageFiles();
  const unstageMut = useUnstageFiles();
  const discardMut = useDiscardFiles();

  const conflicted = status?.conflictedFiles ?? [];
  const hasConflicts = conflicted.length > 0;

  // ── persistence helpers ────────────────────────────────────────────────
  const persistComments = useCallback(
    (next: ReviewComment[]) => {
      setComments(next);
      localStorage.setItem(COMMENTS_KEY_PREFIX + repoPath, JSON.stringify(next));
    },
    [repoPath],
  );
  const toggleViewed = useCallback(
    (file: string) => {
      setViewed((prev) => {
        const next = new Set(prev);
        if (next.has(file)) next.delete(file);
        else next.add(file);
        localStorage.setItem(VIEWED_KEY_PREFIX + repoPath, JSON.stringify([...next]));
        return next;
      });
      // viewing a file auto-collapses it (GitHub behaviour); un-viewing leaves it.
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (!viewed.has(file)) next.add(file);
        else next.delete(file);
        return next;
      });
    },
    [repoPath, viewed],
  );
  const toggleCollapsed = useCallback((file: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  }, []);

  function commentsForFile(file: string): DiffLineAnnotation<ReviewComment>[] {
    // Anchor the annotation at the range's END line (where the comment "lands");
    // the annotation body shows the full L{start}–{end} range.
    return comments
      .filter((c) => c.file === file)
      .map((c) => ({ side: c.side, lineNumber: c.endLine, metadata: c }));
  }

  // ── git invalidation on fs change (owned here, scoped to THIS tile's repo) ──
  // App's central useFsChangedInvalidation only covers the top-level repoPath. A
  // worktree/scoped DiffTile has a DIFFERENT repoPath, so its `git:status` list
  // was never refreshed — edits didn't show until reopen. Watch + invalidate
  // BOTH the changed-file LIST (git:status / git:diff / git:list-files) and the
  // per-file CONTENTS (git:file) for this repoPath, debounced against the
  // agent-write storm.
  const qc = useQueryClient();
  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["git:status", repoPath] });
    qc.invalidateQueries({ queryKey: ["git:diff", repoPath] });
    qc.invalidateQueries({ queryKey: ["git:list-files", repoPath] });
    qc.invalidateQueries({ queryKey: ["git:branches", repoPath] });
    qc.invalidateQueries({
      predicate: (q) => q.queryKey[0] === "git:file" && q.queryKey[1] === repoPath,
    });
  }, [qc, repoPath]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: string[] = [];
    const flush = () => {
      timer = undefined;
      const paths = pending;
      pending = [];
      qc.invalidateQueries({ queryKey: ["git:status", repoPath] });
      qc.invalidateQueries({ queryKey: ["git:diff", repoPath] });
      qc.invalidateQueries({ queryKey: ["git:list-files", repoPath] });
      qc.invalidateQueries({ queryKey: ["git:branches", repoPath] });
      qc.invalidateQueries({
        predicate: (q) =>
          q.queryKey[0] === "git:file" &&
          q.queryKey[1] === repoPath &&
          paths.some(
            (p) => p === `${repoPath}/${q.queryKey[2]}` || p.endsWith(`/${q.queryKey[2]}`),
          ),
      });
    };
    const unsub = window.hive.onFsChanged(repoPath, ({ paths }) => {
      pending.push(...paths);
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 150);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsub();
    };
  }, [qc, repoPath]);

  // ── build CodeView items per mode ───────────────────────────────────────
  const workingItems = useWorkingItems(repoPath, mode === "working" ? status?.files ?? [] : [], staged);
  const branchScope: DiffScope = useMemo(
    () => ({ kind: "branch", base: branchBase ?? initialBase, head: branchHead }),
    [branchBase, branchHead, initialBase],
  );
  const branch = useBranchItems(repoPath, branchScope, mode === "branch");
  // Branch inventory for the base/head pickers — only fetched in branch mode.
  const branchesQ = useQuery<GitBranchList>({
    queryKey: ["git:branches", repoPath],
    queryFn: () => window.hive.gitListBranches(repoPath),
    enabled: mode === "branch",
  });
  // Committed-but-not-pushed: net diff of local commits ahead of @{upstream}.
  const unpushedScope: DiffScope = useMemo(() => ({ kind: "unpushed" }), []);
  const unpushed = useBranchItems(repoPath, unpushedScope, mode === "unpushed");

  const revItems = mode === "unpushed" ? unpushed : branch;
  const rawBaseItems = mode === "working" ? workingItems.items : revItems.items;

  // De-dupe by item id (`diff:<path>`). CodeView.addItem THROWS on a duplicate
  // id ("CodeView.addItem: duplicate id …") and that crashes the whole tile —
  // seen on remote (ssh) frames where a malformed git path can collide. A
  // duplicate must degrade (drop the repeat), never take down the diff. Keep
  // first occurrence; warn in dev so the upstream parse bug stays visible.
  const baseItems = useMemo(() => {
    const seen = new Set<string>();
    const out: typeof rawBaseItems = [];
    for (const it of rawBaseItems) {
      if (seen.has(it.id)) {
        if (import.meta.env.DEV) console.warn(`DiffTile: dropping duplicate diff id ${JSON.stringify(it.id)}`);
        continue;
      }
      seen.add(it.id);
      out.push(it);
    }
    return out;
  }, [rawBaseItems]);

  // Decorate base items with collapse/viewed/annotations.
  //
  // CodeView reconciles by id + `version`: `syncItemRecord` re-applies an
  // item's options (collapsed state, etc.) ONLY when `version` changes
  // (verified in CodeView.js — it early-returns on `item.version === next`).
  // So the final version MUST fold in collapsed + the annotations digest, or
  // toggling collapse/viewed and adding comments would not re-render.
  const items: CodeViewItem<ReviewComment>[] = useMemo(() => {
    return baseItems.map((it) => {
      const file = it.fileDiff.name;
      const isCollapsed = collapsed.has(file) || viewed.has(file);
      const anns = commentsForFile(file);
      const annsDigest = anns?.map((a) => `${a.lineNumber}.${a.side}.${a.metadata?.at}`).join(",") ?? "";
      return {
        ...it,
        collapsed: isCollapsed,
        annotations: anns,
        version: hashNum(`${it.version ?? 0}:${isCollapsed ? 1 : 0}:${annsDigest}`),
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseItems, collapsed, viewed, comments, mode]);

  // Changed-files list for the sidebar tree — path + add/del counts per file.
  const fileRows = useMemo(
    () =>
      baseItems.map((it) => ({
        id: it.id,
        file: it.fileDiff.name,
        adds: it.fileDiff.hunks.reduce((n, h) => n + h.additionLines, 0),
        dels: it.fileDiff.hunks.reduce((n, h) => n + h.deletionLines, 0),
      })),
    [baseItems],
  );
  // Jump the CodeView to a file by its item id (`diff:<path>`).
  const jumpToFile = useCallback((id: string) => {
    codeViewRef.current?.scrollTo({ type: "item", id, align: "start" });
  }, []);

  // Open the comment composer popover anchored just under a line. Shared by the
  // gutter "+" and the line-number click. Stable (refs + setters only).
  const openComposerAt = useCallback(
    (file: string, startLine: number, endLine: number, side: AnnotationSide, lineEl: HTMLElement | null) => {
      const hostRect = cvHostRef.current?.getBoundingClientRect();
      const lineRect = lineEl?.getBoundingClientRect();
      let anchor = { x: 44, y: 44 };
      if (hostRect && lineRect) {
        const yBelow = lineRect.bottom - hostRect.top;
        // Flip the popover ABOVE the line when it would render off the tile's
        // bottom edge (clicking a low line otherwise pushed the composer off-screen).
        const flip = yBelow > hostRect.height - 150;
        anchor = { x: lineRect.left - hostRect.left + 44, y: flip ? Math.max(4, lineRect.top - hostRect.top - 140) : yBelow };
      }
      setComposer({ file, startLine, endLine, side, anchor, stage: "choose" });
    },
    [],
  );

  // ── in-diff search (codiff's hunk-walk algorithm) ──────────────────────
  // Walks each fileDiff's hunks → hunkContent blocks, mapping array indices
  // back to real line numbers + side, so we can scrollTo + highlight each hit.
  const matches = useMemo(() => collectMatches(baseItems, search), [baseItems, search]);
  const [matchIdx, setMatchIdx] = useState(0);

  const gotoMatch = useCallback(
    (idx: number) => {
      if (matches.length === 0) return;
      const i = ((idx % matches.length) + matches.length) % matches.length;
      const m = matches[i];
      if (!m) return;
      setMatchIdx(i);
      // Expanding a collapsed/viewed file so the line is reachable.
      setCollapsed((prev) => {
        if (!prev.has(m.file)) return prev;
        const next = new Set(prev);
        next.delete(m.file);
        return next;
      });
      const cv = codeViewRef.current;
      if (!cv) return;
      cv.scrollTo({ type: "line", id: m.id, lineNumber: m.line, side: m.side, align: "center" });
      cv.setSelectedLines({ id: m.id, range: { start: m.line, end: m.line, side: m.side } });
    },
    [matches],
  );

  // Reset to the first hit whenever the query / result set changes.
  useEffect(() => {
    if (matches.length > 0) gotoMatch(0);
    else codeViewRef.current?.clearSelectedLines();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, matches.length]);

  // ── CodeView options ────────────────────────────────────────────────────
  const options: CodeViewOptions<ReviewComment> = useMemo(
    () => ({
      theme: { dark: "pierre-dark", light: "pierre-light" },
      themeType: "dark",
      diffStyle: layout,
      overflow,
      diffIndicators: "bars",
      stickyHeaders: true,
      // false ⇒ collapse runs of unchanged lines into expandable regions, so the
      // diff shows ONLY changed hunks + a few lines of context (GitHub-style).
      // true ⇒ whole file with every unchanged line. Header toggle drives it.
      // collapsedContextThreshold keeps N context lines per hunk;
      // expansionLineCount is how many lines a click-to-expand reveals.
      expandUnchanged,
      collapsedContextThreshold: 3,
      expansionLineCount: 60,
      lineDiffType: "char",
      maxLineDiffLength: 2000,
      hunkSeparators: "line-info-basic",
      enableLineSelection: true,
      // Comments work in EVERY diff mode (working / branch / unpushed) — a review
      // comment is just file+line+side. (Was gated to `mode === "working"`, which
      // is why the "+" vanished when you switched the mode tab.)
      enableGutterUtility: true,
      // Track the hovered line so the gutter "+" can resolve its file (the click
      // callback gets only a range). Robust to view/setting toggles clearing the
      // selection — the old code resolved the file from a stale selection.
      onLineEnter: (p: { lineElement?: HTMLElement }) => { hoveredLineRef.current = p.lineElement ?? null; },
      // Highlight the hovered line + number so it reads as interactive (click the
      // number to comment) — without this the gutter looked inert.
      lineHoverHighlight: "both",
      tokenizeMaxLength: 100_000,
      // MUST match DiffHeader's rendered height — CodeView reserves this many
      // px for the header slot and uses it for sticky-header positioning
      // (CodeView.js getStickyHeaderOffset). Mismatch ⇒ clipped / overlapping
      // rows, which is why the diff looked "incomplete" before.
      itemMetrics: { diffHeaderHeight: headerH },
      layout: { gap: 10, paddingTop: 8, paddingBottom: 8 },
      onGutterUtilityClick: (range) => {
        // The library hands us only the line RANGE, not the file. Resolve the file
        // from the HOVERED line (nearest preceding `data-diff-file` header), with
        // the last selection as a fallback. This no longer silently no-ops after a
        // view/setting change cleared the selection ("comments not working").
        const sel = selectedRef.current;
        const lineEl = hoveredLineRef.current;
        const file =
          fileForLineEl(lineEl, cvHostRef.current) ?? sel?.id.replace(/^diff:/, "") ?? null;
        if (!file) return;
        const side: AnnotationSide = range.side ?? range.endSide ?? sel?.range.side ?? "additions";
        openComposerAt(file, Math.min(range.start, range.end), Math.max(range.start, range.end), side, lineEl);
      },
      // Click a line NUMBER → comment on THAT line — works on ANY line, including
      // unmodified/context lines (the hover "+" only invited modified lines). More
      // discoverable than hunting the gutter "+", and the GitHub model.
      onLineNumberClick: (p: { lineNumber?: number; annotationSide?: AnnotationSide; lineElement?: HTMLElement }) => {
        const lineEl = p.lineElement ?? hoveredLineRef.current;
        const file = fileForLineEl(lineEl, cvHostRef.current);
        if (!file || p.lineNumber == null) return;
        openComposerAt(file, p.lineNumber, p.lineNumber, p.annotationSide ?? "additions", lineEl);
      },
    }),
    [layout, overflow, expandUnchanged, headerH, openComposerAt],
  );

  // ── header slot ───────────────────────────────────────────────────────
  const renderCustomHeader = useCallback(
    (item: CodeViewItem<ReviewComment>) => {
      if (item.type !== "diff") return null;
      const fd = item.fileDiff;
      const file = fd.name;
      const adds = fd.hunks.reduce((n, h) => n + h.additionLines, 0);
      const dels = fd.hunks.reduce((n, h) => n + h.deletionLines, 0);
      const entry = status?.files.find((f) => f.path === file);
      const isCollapsed = collapsed.has(file) || viewed.has(file);
      const isViewed = viewed.has(file);
      return (
        <DiffHeader
          h={headerH}
          fontPx={chromePx}
          file={file}
          adds={adds}
          dels={dels}
          staged={!!entry?.staged}
          collapsed={isCollapsed}
          viewed={isViewed}
          showStage={mode === "working"}
          onToggleCollapsed={() => toggleCollapsed(file)}
          onToggleViewed={() => toggleViewed(file)}
          onToggleStage={() => {
            if (entry?.staged) unstageMut.mutate({ repoPath, files: [file] });
            else stageMut.mutate({ repoPath, files: [file] });
          }}
          onOpen={() => setActiveFile(file)}
          onDiscard={() => {
            if (mode === "working" && confirm(`discard changes to ${file}?`))
              discardMut.mutate({ repoPath, files: [file] });
          }}
        />
      );
    },
    [status, collapsed, viewed, mode, repoPath, toggleCollapsed, toggleViewed, stageMut, unstageMut, discardMut, headerH, chromePx],
  );

  const renderAnnotation = useCallback(
    (annotation: DiffLineAnnotation<ReviewComment>) => {
      const c = annotation.metadata;
      if (!c) return null;
      return (
        <div
          style={{
            background: "rgba(245,159,0,0.08)",
            borderLeft: "3px solid var(--color-warn)",
            padding: "5px 12px 5px 56px",
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            color: "var(--color-warn)",
          }}
        >
          <span style={{ color: "var(--color-fg)", fontWeight: 600 }}>{c.author}</span>
          {c.startLine !== c.endLine && (
            <span style={{ marginLeft: 6, color: "var(--color-fg3)", fontSize: 10 }}>
              L{c.startLine}–{c.endLine}
            </span>
          )}
          {c.resolved && (
            <span style={{ marginLeft: 6, color: "var(--color-ok)", fontSize: 10 }}>✓ resolved</span>
          )}
          <span style={{ marginLeft: 8, color: c.resolved ? "var(--color-fg3)" : undefined }}>{c.body}</span>
          {!!c.replies?.length && (
            <span style={{ marginLeft: 6, color: "var(--color-fg3)", fontSize: 10 }}>💬 {c.replies.length}</span>
          )}
          <span style={{ color: "var(--color-fg3)", float: "right", fontSize: 10 }}>{c.at}</span>
        </div>
      );
    },
    [],
  );

  function submitComposer(body: string) {
    if (!composer || !body.trim()) return setComposer(null);
    // Add to the review batch (GitHub model). Sending to claude is explicit
    // (review panel / ReviewBar) — not a silent per-comment dispatch that drops
    // when no claude tile is listening.
    const next: ReviewComment[] = [
      ...comments,
      {
        id: newCid(),
        file: composer.file,
        startLine: composer.startLine,
        endLine: composer.endLine,
        side: composer.side,
        body,
        author: "you",
        at: new Date().toISOString().slice(0, 16).replace("T", " "),
        resolved: false,
        replies: [],
      },
    ];
    persistComments(next);
    setComposer(null);
    // Reveal the review panel on the FIRST comment so it isn't invisible (you'd
    // otherwise have to know to toggle "Review" to see what you left).
    if (comments.length === 0) setReviewOpen(true);
  }

  // ── review-comment mutations (used by the review panel) ──────────────────
  const replyToComment = useCallback((id: string, body: string) => {
    if (!body.trim()) return;
    persistComments(comments.map((c) =>
      c.id === id
        ? { ...c, replies: [...(c.replies ?? []), { author: "you", body, at: new Date().toISOString().slice(0, 16).replace("T", " ") }] }
        : c,
    ));
  }, [comments, persistComments]);
  const toggleResolved = useCallback((id: string) => {
    persistComments(comments.map((c) => (c.id === id ? { ...c, resolved: !c.resolved } : c)));
  }, [comments, persistComments]);
  const deleteComment = useCallback((id: string) => {
    persistComments(comments.filter((c) => c.id !== id));
  }, [comments, persistComments]);

  // Jump the diff to a comment's range (scroll + select its lines).
  const jumpToComment = useCallback((c: ReviewComment) => {
    const cv = codeViewRef.current;
    if (!cv) return;
    const id = `diff:${c.file}`;
    cv.scrollTo({ type: "line", id, lineNumber: c.startLine, side: c.side, align: "center" });
    cv.setSelectedLines({ id, range: { start: c.startLine, end: c.endLine, side: c.side } });
  }, []);

  // Send review text to claude via the target picker (Canvas routes it: pick
  // among existing claude tiles, or spawn a new one carrying the text — no more
  // blind latest-or-spawn-with-a-2.5s-timeout).
  const sendToClaude = useCallback((msg: string) => {
    window.dispatchEvent(new CustomEvent("hivemind:deliver-to-claude", { detail: { text: msg } }));
  }, []);
  const sendComment = useCallback((c: ReviewComment) => {
    const range = c.startLine === c.endLine ? `${c.startLine}` : `${c.startLine}-${c.endLine}`;
    const thread = [c.body, ...(c.replies ?? []).map((r) => `  ↳ ${r.author}: ${r.body}`)].join("\n");
    sendToClaude(`Address this review comment — ${c.file}:${range}:\n${thread}`);
  }, [sendToClaude]);

  // Send the whole review to claude as ONE message. If no claude tile is alive
  // (latestClaude() === undefined → the send would vanish), spawn one first,
  // then send after it boots. This is the answer to "how do my diff comments
  // reach claude?": leave comments, click Send review.
  const sendReview = useCallback(() => {
    const open = comments.filter((c) => !c.resolved);
    if (open.length === 0) return;
    const lines = open
      .map((c) => {
        const side = c.side === "deletions" ? "old/left" : "new/right";
        const range = c.startLine === c.endLine ? `${c.startLine}` : `${c.startLine}-${c.endLine}`;
        const thread = (c.replies ?? []).map((r) => ` ↳ ${r.author}: ${r.body}`).join("\n");
        return `- ${c.file}:${range} (${side}): ${c.body}${thread ? "\n" + thread : ""}`;
      })
      .join("\n");
    sendToClaude(`Code review — ${open.length} unresolved comment${open.length > 1 ? "s" : ""} to address:\n${lines}`);
  }, [comments, sendToClaude]);

  const loading = mode === "working" ? workingItems.isLoading : revItems.isLoading;
  const modeError = mode === "working" ? workingItems.error : revItems.error;

  // Data-driven mode tabs — add a future diff source (a commit, a range, a
  // "since tag") by appending one entry here + (if it needs new git) one
  // DiffScope variant. The render below just maps this list.
  const ahead = status?.ahead ?? 0;
  const modeTabs: {
    id: Mode;
    label: string;
    title: string;
    badge?: number;
    disabled?: boolean;
  }[] = [
    { id: "working", label: "working", title: "uncommitted working-tree changes" },
    { id: "branch", label: "branch", title: `compare ${branchBase ?? initialBase} … ${branchHead ?? "HEAD"}` },
    {
      id: "unpushed",
      label: "unpushed",
      title: status?.upstream
        ? `commits ahead of ${status.upstream} (committed, not pushed)`
        : "local commits not yet pushed",
      badge: ahead > 0 ? ahead : undefined,
      // Only disable when we KNOW there's nothing ahead (upstream tracked, ahead 0).
      // No upstream ⇒ leave enabled (every local commit counts as unpushed).
      disabled: !!status?.upstream && ahead === 0,
    },
  ];

  return (
    <div
      className="hm-glass-surface flex flex-col h-full bg-[var(--color-bg2)] border border-[var(--color-line)] rounded-xl overflow-hidden"
      style={{ ...PIERRE_CSS_VARS, "--diffs-font-size": `${font.size}px` } as React.CSSProperties}
      onKeyDownCapture={(e) => handleFontKey(e, font)}
    >
      {/* tile chrome */}
      <div className="tile-drag-handle h-8 flex items-center gap-2 px-2.5 bg-[var(--color-bg3)] border-b border-[var(--color-line)] text-[11px] font-mono text-[var(--color-fg2)] cursor-grab active:cursor-grabbing">
        <GripVertical aria-hidden size={13} className="text-[var(--color-fg3)] -ml-1 shrink-0" />
        <span className="font-semibold text-[var(--color-fg)]">Diff</span>
        <span aria-hidden className="text-[var(--color-line2)]">·</span>
        <span className="text-[var(--color-fg2)]">{repoPath.split("/").slice(-1)[0]}</span>

        <div className="nodrag ml-2.5 inline-flex rounded-md overflow-hidden bg-[var(--color-bg)] border border-[var(--color-line2)]">
          {modeTabs.map((t) => (
            <button
              key={t.id}
              className={`px-2.5 py-0.5 text-[10.5px] font-mono transition-colors inline-flex items-center gap-1 ${
                mode === t.id
                  ? "bg-[var(--color-bg4)] text-[var(--color-accent)] font-semibold"
                  : "text-[var(--color-fg3)] hover:text-[var(--color-fg2)]"
              } ${t.disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
              onClick={() => { if (!t.disabled) setMode(t.id); }}
              disabled={t.disabled}
              title={t.title}
            >
              {t.label}
              {t.badge != null && (
                <span className="px-1 rounded-full bg-[var(--color-brand)] text-white text-[8.5px] leading-none py-0.5 tabular-nums">
                  {t.badge}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* branch-compare pickers — base…head. Review any two branches with no
            remote PR. Empty = auto (base→origin/HEAD, head→working checkout). */}
        {mode === "branch" && (
          <div className="nodrag ml-1.5 inline-flex items-center gap-1">
            <BranchPicker
              label="base"
              value={branchBase}
              onChange={setBranchBase}
              branches={branchesQ.data}
              autoLabel={`auto (${initialBase})`}
            />
            <span aria-hidden className="text-[var(--color-fg3)]">…</span>
            <BranchPicker
              label="head"
              value={branchHead}
              onChange={setBranchHead}
              branches={branchesQ.data}
              autoLabel="HEAD (checkout)"
            />
          </div>
        )}

        {mode === "working" && (
          <button
            className={`nodrag inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-mono transition-colors ${
              staged
                ? "border-[var(--color-ok)] text-[var(--color-ok)] bg-[color-mix(in_srgb,var(--color-ok)_10%,transparent)]"
                : "border-[var(--color-line2)] text-[var(--color-fg3)] hover:text-[var(--color-fg2)]"
            }`}
            onClick={() => setStaged((s) => !s)}
            title="compare against the index (staged)"
          >
            <span aria-hidden className="size-1.5 rounded-full" style={{ background: staged ? "var(--color-ok)" : "var(--color-fg3)" }} />
            staged
          </button>
        )}

        {/* in-diff search — collapsed to an icon; click reveals the input.
            Line-level matches, scroll + highlight, ↑/↓ nav. */}
        {searchOpen || search.trim() ? (
          <div className="nodrag ml-1.5 inline-flex items-center gap-1 bg-[var(--color-bg)] border border-[var(--color-line2)] rounded px-1.5 py-0.5">
            <Search size={11} aria-hidden className="text-[var(--color-fg3)] shrink-0" />
            <input
              autoFocus
              className="w-28 bg-transparent text-[10px] font-mono text-[var(--color-fg)] outline-none placeholder:text-[var(--color-fg3)]"
              placeholder="search diff…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  gotoMatch(matchIdx + (e.shiftKey ? -1 : 1));
                }
                if (e.key === "Escape") { setSearch(""); setSearchOpen(false); }
              }}
            />
            {search.trim() && (
              <span className="text-[9.5px] font-mono tabular-nums text-[var(--color-fg3)] min-w-[34px] text-center">
                {matches.length ? `${matchIdx + 1}/${matches.length}` : "0/0"}
              </span>
            )}
            <button
              className="text-[var(--color-fg3)] hover:text-[var(--color-fg)] disabled:opacity-30 text-[10px] leading-none"
              disabled={matches.length === 0}
              onClick={() => gotoMatch(matchIdx - 1)}
              title="previous match (shift+enter)"
            >
              ↑
            </button>
            <button
              className="text-[var(--color-fg3)] hover:text-[var(--color-fg)] disabled:opacity-30 text-[10px] leading-none"
              disabled={matches.length === 0}
              onClick={() => gotoMatch(matchIdx + 1)}
              title="next match (enter)"
            >
              ↓
            </button>
            <button
              className="cursor-pointer text-[var(--color-fg3)] hover:text-[var(--color-fg)] text-[11px] leading-none ml-0.5"
              onClick={() => { setSearch(""); setSearchOpen(false); }}
              title="close search"
            >
              ×
            </button>
          </div>
        ) : (
          <button
            className="nodrag cursor-pointer ml-1.5 size-6 grid place-items-center rounded text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg4)] transition-colors"
            onClick={() => setSearchOpen(true)}
            aria-label="search diff"
            title="Search diff"
          >
            <Search size={12} aria-hidden />
          </button>
        )}

        {/* view⋯ — secondary view options (layout / wrap / full / font /
            refresh) collapsed into one popover so the header stays uncluttered. */}
        <div className="relative" ref={viewMenuRef}>
          <button
            className={`nodrag cursor-pointer ml-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-mono transition-colors ${
              viewMenuOpen
                ? "border-[var(--color-line2)] bg-[var(--color-bg4)] text-[var(--color-fg)]"
                : "border-[var(--color-line2)] text-[var(--color-fg3)] hover:text-[var(--color-fg2)]"
            }`}
            onClick={() => setViewMenuOpen((o) => !o)}
            title="View options"
          >
            <SlidersHorizontal size={11} aria-hidden />
            view
          </button>
          {viewMenuOpen && (
            <div className="nodrag absolute z-50 right-0 top-full mt-1 w-44 flex flex-col gap-2 bg-[var(--color-bg3)] border border-[var(--color-line2)] rounded-lg shadow-xl p-2 text-[10px] font-mono">
              {/* header — label + explicit close (outside-click & Esc also close) */}
              <div className="flex items-center justify-between -mb-0.5">
                <span className="uppercase tracking-wider text-[9px] font-semibold text-[var(--color-fg3)]">View</span>
                <button
                  className="cursor-pointer size-4 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-line2)] hover:text-[var(--color-fg)] transition-colors"
                  onClick={() => setViewMenuOpen(false)}
                  aria-label="close view options"
                  title="close"
                >
                  ×
                </button>
              </div>
              {/* layout */}
              <div className="inline-flex rounded overflow-hidden border border-[var(--color-line2)]">
                <button
                  className={`flex-1 cursor-pointer px-2 py-1 transition-colors ${layout === "split" ? "bg-[var(--color-bg4)] text-[var(--color-accent)]" : "text-[var(--color-fg3)] hover:text-[var(--color-fg2)]"}`}
                  onClick={() => setLayout("split")}
                >
                  split
                </button>
                <button
                  className={`flex-1 cursor-pointer px-2 py-1 transition-colors ${layout === "unified" ? "bg-[var(--color-bg4)] text-[var(--color-accent)]" : "text-[var(--color-fg3)] hover:text-[var(--color-fg2)]"}`}
                  onClick={() => setLayout("unified")}
                >
                  unified
                </button>
              </div>
              {/* toggles */}
              <div className="flex items-center gap-1.5">
                <button
                  className={`flex-1 cursor-pointer px-2 py-1 rounded border transition-colors ${overflow === "wrap" ? "border-[var(--color-accent)] text-[var(--color-accent)] bg-[var(--color-bg4)]" : "border-[var(--color-line2)] text-[var(--color-fg3)] hover:text-[var(--color-fg2)]"}`}
                  onClick={() => setOverflow((o) => (o === "scroll" ? "wrap" : "scroll"))}
                  title="toggle long-line wrap"
                >
                  wrap
                </button>
                <button
                  className={`flex-1 cursor-pointer px-2 py-1 rounded border transition-colors ${expandUnchanged ? "border-[var(--color-accent)] text-[var(--color-accent)] bg-[var(--color-bg4)]" : "border-[var(--color-line2)] text-[var(--color-fg3)] hover:text-[var(--color-fg2)]"}`}
                  onClick={() => setExpandUnchanged((v) => !v)}
                  title={expandUnchanged ? "showing full file — click for changes only" : "showing changes only — click for full file"}
                >
                  {expandUnchanged ? "full" : "diff"}
                </button>
              </div>
              {/* font + refresh */}
              <div className="flex items-center justify-between gap-1.5 pt-1 border-t border-[var(--color-line2)]">
                <FontStepper {...font} />
                <button
                  className="size-6 cursor-pointer grid place-items-center rounded text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg4)] transition-colors"
                  onClick={refresh}
                  aria-label="refresh diff"
                  title="Refresh diff (re-read files + diffs)"
                >
                  <RefreshCw size={12} aria-hidden />
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2.5 text-[var(--color-fg3)]">
          {status && (
            <span className="tabular-nums" title={`${items.length} shown · ${viewed.size} viewed · ${status.ahead}/${status.behind}`}>
              {items.length}f · {viewed.size}✓
            </span>
          )}
          <button
            className={`nodrag inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] transition-colors ${
              filesOpen
                ? "border-[var(--color-line2)] bg-[var(--color-bg4)] text-[var(--color-fg)]"
                : "border-[var(--color-line2)] text-[var(--color-fg3)] hover:text-[var(--color-fg2)]"
            }`}
            onClick={() => setFilesOpen((o) => !o)}
            title="Toggle the changed-files list"
          >
            files
          </button>
          <button
            className={`nodrag inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] transition-colors ${
              reviewOpen
                ? "border-[var(--color-line2)] bg-[var(--color-bg4)] text-[var(--color-fg)]"
                : "border-[var(--color-line2)] text-[var(--color-fg3)] hover:text-[var(--color-fg2)]"
            }`}
            onClick={() => setReviewOpen((o) => !o)}
            title="Toggle the review panel"
          >
            review
            {comments.some((c) => !c.resolved) && (
              <span className="px-1 rounded-full bg-[var(--color-warn)] text-[9px] text-black font-semibold leading-none py-0.5">
                {comments.filter((c) => !c.resolved).length}
              </span>
            )}
          </button>
          <button
            className="nodrag size-4 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-line2)] hover:text-[var(--color-fg)] transition-colors cursor-pointer"
            aria-label="close tile"
            title="close"
            onClick={onClose}
          >
            ×
          </button>
        </div>
      </div>

      {/* body — one worker pool shared by main diff + the open-file popup.
          flex-col so conflicts (flex-none) stack above the CodeView (flex-1
          min-h-0) without clipping it. */}
      <WorkerPoolContextProvider poolOptions={workerPoolOptions} highlighterOptions={workerHighlighterOptions}>
       <div className="flex-1 min-h-0 flex overflow-hidden">
        {filesOpen && fileRows.length > 0 && !activeFile && (
          <aside
            className="nodrag shrink-0 flex flex-col border-r border-[var(--color-line)] bg-[var(--color-bg2)] overflow-hidden"
            style={{
              width: filesW,
              // Theme @pierre/trees via its CSS vars (same mapping as FileTreeTile).
              // Tie the tree's type + row height to the code font so the file
              // list scales with A+/A− instead of staying tiny next to big code.
              "--trees-font-size": `${chromePx}px`,
              "--trees-item-height": `${Math.round(chromePx * 2)}px`,
              "--trees-bg": "var(--color-bg2)",
              "--trees-bg-muted": "var(--color-bg3)",
              "--trees-fg": "var(--color-fg)",
              "--trees-fg-muted": "var(--color-fg3)",
              "--trees-accent": "var(--color-brand)",
              "--trees-border-color": "var(--color-line)",
              "--trees-theme-sidebar-bg": "var(--color-bg2)",
              "--trees-theme-sidebar-fg": "var(--color-fg)",
              "--trees-theme-list-hover-bg": "var(--color-bg3)",
              "--trees-theme-list-active-selection-bg": "var(--color-bg4)",
              "--trees-theme-list-active-selection-fg": "var(--color-fg)",
              "--trees-theme-input-bg": "var(--color-bg3)",
              "--trees-theme-input-border": "var(--color-line2)",
              "--trees-theme-input-fg": "var(--color-fg)",
              "--trees-theme-focus-ring": "var(--color-brand)",
              "--trees-theme-scrollbar-thumb": "var(--color-line2)",
              "--trees-theme-row-decoration-fg": "var(--color-fg3)",
              "--trees-theme-row-decoration-bg": "transparent",
            } as React.CSSProperties}
          >
            <div className="h-7 shrink-0 flex items-center gap-1.5 px-2.5 border-b border-[var(--color-line2)] text-[10px] uppercase tracking-wider font-semibold text-[var(--color-fg3)]">
              Files
              <span className="ml-auto font-mono tabular-nums text-[var(--color-fg3)]">{viewed.size}/{fileRows.length}</span>
            </div>
            <div className="flex-1 min-h-0">
              <FileTree rows={fileRows} viewed={viewed} onJump={jumpToFile} onToggleViewed={toggleViewed} />
            </div>
          </aside>
        )}
        {filesOpen && fileRows.length > 0 && !activeFile && (
          // Wide grab zone + thin centered line (mirrors the Workbench explorer
          // divider) so deep paths can be widened instead of truncating.
          <div
            className="nodrag group shrink-0 w-2 -ml-1 cursor-col-resize relative z-10 flex justify-center"
            role="separator"
            aria-orientation="vertical"
            title="Drag to resize the files panel"
            onPointerDown={(e) => {
              filesDragRef.current = { startX: e.clientX, startW: filesW };
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              e.preventDefault();
            }}
            onPointerMove={(e) => {
              const d = filesDragRef.current;
              if (!d) return;
              setFilesW(clampFilesW(d.startW + (e.clientX - d.startX)));
            }}
            onPointerUp={(e) => {
              filesDragRef.current = null;
              (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
            }}
          >
            <span className="w-px h-full bg-[var(--color-line)] group-hover:bg-[var(--color-brand)] group-active:bg-[var(--color-brand)] transition-colors" />
          </div>
        )}
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden" data-pierre-tile>
          {statusLoading && <div className="p-3 text-[11px] text-[var(--color-fg3)]">loading git status…</div>}
          {statusError && (
            <div className="p-3 text-[11px] font-mono text-[var(--color-err)]">
              <div className="font-semibold mb-1">git status failed</div>
              <div className="text-[var(--color-fg3)]">{(statusError as Error).message}</div>
              <div className="text-[var(--color-fg3)] mt-1">repo: {repoPath}</div>
            </div>
          )}

          {hasConflicts && (
            <div className="shrink-0 border-b border-[var(--color-line)] overflow-auto max-h-[50%]">
              <div
                className="px-3 py-2 text-[var(--color-fg)] text-[11px] font-mono flex items-center gap-2"
                style={{ background: "color-mix(in srgb, var(--color-err) 12%, transparent)" }}
              >
                <span className="text-[var(--color-err)]">⚠ {conflicted.length} conflict{conflicted.length > 1 ? "s" : ""}</span>
                <span className="text-[var(--color-fg3)]">· resolve below, then commit via terminal</span>
              </div>
              {conflicted.map((file) => (
                <ConflictView key={file} repoPath={repoPath} file={file} />
              ))}
            </div>
          )}

          {activeFile && (
            <div className="flex-1 min-h-0">
              <FileView repoPath={repoPath} file={activeFile} onClose={() => setActiveFile(null)} />
            </div>
          )}

          {!activeFile && modeError && (
            <div className="p-3 text-[11px] font-mono text-[var(--color-err)]">
              <div className="font-semibold mb-1">diff failed</div>
              <div className="text-[var(--color-fg3)]">{(modeError as Error).message}</div>
            </div>
          )}

          {!activeFile && !modeError && loading && (
            <div className="p-3 text-[11px] text-[var(--color-fg3)]">loading diff…</div>
          )}

          {!activeFile && !modeError && !loading && items.length === 0 && (
            <div className="p-4 text-[11px] text-[var(--color-fg3)] text-center font-mono">
              {mode === "working"
                ? "✓ working tree clean"
                : mode === "unpushed"
                  ? "✓ everything committed is pushed"
                  : "✓ no commits on this branch beyond base"}
            </div>
          )}

          {!activeFile && !modeError && !loading && items.length > 0 && (
            <div ref={cvHostRef} className="relative flex-1 min-h-0">
              <CodeView<ReviewComment>
                ref={codeViewRef}
                className="h-full w-full overflow-y-auto"
                items={items}
                options={options}
                renderCustomHeader={renderCustomHeader}
                renderAnnotation={renderAnnotation}
                onSelectedLinesChange={(sel) => { selectedRef.current = sel; }}
              />
              {/* Comment composer — a popover anchored just under the clicked line
                  (same UX as plan-review). Stage 1 = Comment + quick-labels; stage
                  2 = the multi-line comment box. Shared review-ui components. */}
              {composer && (
                <ReviewPopover anchor={composer.anchor} onClose={() => setComposer(null)}>
                  {composer.stage === "choose" ? (
                    <ActionToolbar
                      onComment={() => setComposer({ ...composer, stage: "comment" })}
                      onQuickLabel={(label, tip) => submitComposer(tip ? `**${label}** — ${tip}` : label)}
                    />
                  ) : (
                    <CommentBox
                      value={composerDraft}
                      onChange={setComposerDraft}
                      onCancel={() => setComposer({ ...composer, stage: "choose" })}
                      onSubmit={() => submitComposer(composerDraft)}
                    />
                  )}
                </ReviewPopover>
              )}
            </div>
          )}
        </div>
        {reviewOpen && !activeFile && (
          <DiffReviewPanel
            comments={comments}
            onJump={jumpToComment}
            onReply={replyToComment}
            onResolve={toggleResolved}
            onDelete={deleteComment}
            onSend={sendComment}
            onSendAll={sendReview}
            onClose={() => setReviewOpen(false)}
          />
        )}
       </div>
      </WorkerPoolContextProvider>

      {/* Review batch — leave comments via the gutter "+", then send them all
          to claude as one message. Spawns a claude tile if none is alive. */}
      {!activeFile && comments.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-t border-[var(--color-line)] bg-[var(--color-bg3)] text-[11px]">
          <span className="text-[var(--color-warn)] font-medium">
            {comments.length} review comment{comments.length > 1 ? "s" : ""}
          </span>
          <button
            onClick={sendReview}
            className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-white bg-[var(--color-brand)] hover:opacity-90 text-[11.5px] font-medium"
            title="Send all review comments to claude (spawns one if none is running)"
          >
            <Play size={12} fill="currentColor" strokeWidth={0} aria-hidden />
            Send review to Claude
          </button>
          <button
            onClick={() => persistComments([])}
            className="text-[var(--color-fg3)] hover:text-[var(--color-err)] text-[10px]"
            title="discard all review comments"
          >
            clear
          </button>
        </div>
      )}

      {mode === "working" && !activeFile && status && ((status.files?.length ?? 0) > 0 || status.ahead > 0) && (
        <CommitBar repoPath={repoPath} status={status} />
      )}
    </div>
  );
}

// ── commit + push bar (working mode) ──────────────────────────────────────
// Adopts Nyx's ZoneToolbar model: stage-all · editable message · Commit · Push.
// AI-generated messages are intentionally deferred (no AI backend yet) — the
// research flagged silent auto-messages as a known annoyance, so manual first.
function CommitBar({ repoPath, status }: { repoPath: string; status: GitStatusSnapshot }) {
  const [message, setMessage] = useState("");
  const commitMut = useGitCommit();
  const pushMut = useGitPush();
  const stageMut = useStageFiles();

  const staged = status.files.filter((f) => f.staged);
  const unstaged = status.files.filter((f) => !f.staged && f.status !== "ignored");
  const canCommit = staged.length > 0 && message.trim().length > 0 && !commitMut.isPending;

  const doCommit = () => {
    if (!canCommit) return;
    commitMut.mutate({ repoPath, message: message.trim() }, { onSuccess: () => setMessage("") });
  };

  return (
    <div className="border-t border-[var(--color-line)] bg-[var(--color-bg3)] px-2.5 py-1.5 flex items-center gap-2 text-[11px] font-mono">
      {status.files.length > 0 && (
        <span className="text-[var(--color-fg3)] tabular-nums shrink-0" title={`${staged.length} staged · ${unstaged.length} unstaged`}>
          <span className="text-[var(--color-ok)]">{staged.length}</span>/{status.files.length}
        </span>
      )}
      {unstaged.length > 0 && (
        <button
          className="shrink-0 px-1.5 py-0.5 rounded border border-[var(--color-line2)] text-[var(--color-fg3)] hover:text-[var(--color-fg)] text-[10px]"
          title="stage all changes"
          onClick={() => stageMut.mutate({ repoPath, files: unstaged.map((f) => f.path) })}
        >
          stage all
        </button>
      )}
      {status.files.length === 0 ? (
        <span className="flex-1 text-[var(--color-fg3)]">
          {status.ahead > 0 ? `✓ clean · ${status.ahead} commit${status.ahead > 1 ? "s" : ""} to push` : "✓ working tree clean"}
        </span>
      ) : (
        <input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) doCommit(); }}
          placeholder={staged.length ? "commit message · ⌘↵" : "stage files to commit"}
          disabled={staged.length === 0}
          className="flex-1 bg-[var(--color-bg)] border border-[var(--color-line2)] rounded px-2 py-0.5 text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)] disabled:opacity-50"
        />
      )}
      {status.files.length > 0 && (
        <button
          className="shrink-0 px-2 py-0.5 rounded text-[10px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ background: canCommit ? "var(--color-accent)" : "var(--color-bg4)", color: canCommit ? "var(--color-bg)" : "var(--color-fg3)" }}
          disabled={!canCommit}
          onClick={doCommit}
        >
          {commitMut.isPending ? "…" : "commit"}
        </button>
      )}
      <button
        className="shrink-0 px-2 py-0.5 rounded border border-[var(--color-line2)] text-[var(--color-fg2)] hover:text-[var(--color-fg)] text-[10px] disabled:opacity-40 inline-flex items-center gap-1"
        title={`push${status.ahead ? ` (${status.ahead} ahead)` : ""}`}
        disabled={pushMut.isPending}
        onClick={() => pushMut.mutate({ repoPath, setUpstream: !status.upstream })}
      >
        push{status.ahead ? ` ↑${status.ahead}` : ""}
      </button>
    </div>
  );
}

// ── items: working tree (HEAD ↔ WORKING|INDEX, full-content diff) ─────────

interface ItemsResult {
  items: CodeViewDiffItem<ReviewComment>[];
  isLoading: boolean;
  error: Error | null;
}

// ── changed-files TREE ──────────────────────────────────────────────────
// @pierre/diffs ships no file-navigation component, but @pierre/trees DOES —
// the same <FileTree> the editor's FileTreeTile uses. We reuse it here (fed the
// changed-file paths) so the diff sidebar gets compact folders, file icons,
// virtualization, and ⌘P search for free instead of a bespoke tree. `viewed` is
// surfaced via the main pane (reviewed files collapse) + the sidebar header
// count; the per-file toggle lives in the row context menu (Pierre owns row
// rendering, so we can't inject a checkbox — its decoration slot is text-only).
const clampFilesW = (w: number) => Math.max(180, Math.min(560, Math.round(w)));

interface FileRow { id: string; file: string; adds: number; dels: number }

function FileTree({
  rows, onJump, onToggleViewed,
}: {
  rows: FileRow[];
  viewed: Set<string>;
  onJump: (id: string) => void;
  onToggleViewed: (file: string) => void;
}) {
  const norm = (p: string) => p.replace(/\/+$/, "");
  const paths = useMemo(() => rows.map((r) => norm(r.file)), [rows]);
  // path → row, for jump-on-select + the +adds/−dels decoration.
  const byPath = useMemo(() => {
    const m = new Map<string, FileRow>();
    for (const r of rows) m.set(norm(r.file), r);
    return m;
  }, [rows]);
  // The model is built once; its callbacks must read the latest maps/handlers.
  const byPathRef = useRef(byPath); byPathRef.current = byPath;
  const onJumpRef = useRef(onJump); onJumpRef.current = onJump;
  const onToggleRef = useRef(onToggleViewed); onToggleRef.current = onToggleViewed;

  const { model } = useFileTree({
    paths,
    flattenEmptyDirectories: true,   // VS Code-style compact folders
    initialExpansion: "open",        // only the changed files — show them all
    search: true,
    fileTreeSearchMode: "expand-matches",
    density: "compact",              // tighter rows + indent for deep change-sets
    itemHeight: 22,
    onSelectionChange: (sel) => {
      const p = sel[0];
      const r = p ? byPathRef.current.get(p.replace(/\/+$/, "")) : undefined;
      if (r) onJumpRef.current(r.id); // directory selections resolve to no row
    },
    renderRowDecoration: ({ item }): FileTreeRowDecoration | null => {
      if (item.kind === "directory") return null;
      const r = byPathRef.current.get(item.path.replace(/\/+$/, ""));
      return r ? { text: `+${r.adds} −${r.dels}`, title: `+${r.adds} −${r.dels}` } : null;
    },
  });

  useEffect(() => { model.resetPaths(paths); }, [model, paths]);

  return (
    <PierreFileTree
      model={model}
      className="h-full w-full nowheel"
      renderContextMenu={(item: ContextMenuItem, ctx: ContextMenuOpenContext) => {
        const r = byPathRef.current.get(item.path.replace(/\/+$/, ""));
        if (!r) return <></>;
        const btn = "w-full text-left px-2 py-1 rounded text-[var(--color-fg)] hover:bg-[var(--color-bg4)]";
        return (
          <div className="min-w-[180px] bg-[var(--color-bg3)] border border-[var(--color-line2)] rounded-md shadow-2xl p-1 text-[12px]">
            <button className={btn} onClick={() => { onJumpRef.current(r.id); ctx.close(); }}>Jump to file</button>
            <button className={btn} onClick={() => { onToggleRef.current(r.file); ctx.close(); }}>Toggle reviewed</button>
          </div>
        );
      }}
    />
  );
}

function useWorkingItems(repoPath: string, files: GitFileEntry[], staged: boolean): ItemsResult {
  const newRev: "WORKING" | "INDEX" = staged ? "INDEX" : "WORKING";
  const changed = useMemo(
    () => files.filter((f) => f.status !== "ignored" && f.status !== "conflicted"),
    [files],
  );

  const results = useQueries({
    queries: changed.flatMap((f) => {
      // Added/untracked files have no HEAD blob — fetching it throws. Treat
      // the old side as empty so the file renders as all-additions.
      const noHead = f.status === "added" || f.status === "untracked";
      // Deleted files have no working/index blob — old side only.
      const noNew = f.status === "deleted";
      return [
        {
          queryKey: ["git:file", repoPath, f.path, noHead ? "EMPTY" : "HEAD"],
          queryFn: () =>
            noHead ? Promise.resolve("") : window.hive.gitFileContents(repoPath, f.path, "HEAD"),
          retry: false,
        },
        {
          queryKey: ["git:file", repoPath, f.path, noNew ? "EMPTY" : newRev],
          queryFn: () =>
            noNew ? Promise.resolve("") : window.hive.gitFileContents(repoPath, f.path, newRev),
          retry: false,
        },
      ];
    }),
  });

  // Signature gates the parse: only re-parse when a file's content actually
  // refetched (dataUpdatedAt bumps) or the file set changed.
  const sig = changed
    .map((f, i) => `${f.path}:${results[i * 2]?.dataUpdatedAt ?? 0}:${results[i * 2 + 1]?.dataUpdatedAt ?? 0}`)
    .join("|");

  const items = useMemo(() => {
    const out: CodeViewDiffItem<ReviewComment>[] = [];
    changed.forEach((f, i) => {
      const oldR = results[i * 2];
      const newR = results[i * 2 + 1];
      if (oldR?.isLoading || newR?.isLoading) return;
      const oldUpdated = oldR?.dataUpdatedAt ?? 0;
      const newUpdated = newR?.dataUpdatedAt ?? 0;
      const oldFile: FileContents = {
        name: f.path,
        contents: oldR?.data ?? "",
        cacheKey: `${repoPath}:HEAD:${f.path}:${oldUpdated}`,
      };
      const newFile: FileContents = {
        name: f.path,
        contents: newR?.data ?? "",
        cacheKey: `${repoPath}:${newRev}:${f.path}:${newUpdated}`,
      };
      const fileDiff = parseDiffFromFile(oldFile, newFile);
      out.push({ id: `diff:${f.path}`, type: "diff", fileDiff, version: oldUpdated + newUpdated });
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, repoPath, newRev]);

  const isLoading = results.some((r) => r.isLoading) && items.length === 0;
  // Per-file content errors degrade gracefully (file renders with empty side),
  // so they're NOT fatal — only report an error when nothing rendered at all.
  const error =
    items.length === 0 && !isLoading ? ((results.find((r) => r.error)?.error as Error) ?? null) : null;
  return { items, isLoading, error };
}

// ── items: branch (`git diff base...HEAD`, partial patch) ─────────────────

/** A base/head ref dropdown for branch-compare. Native <select> so the menu is
 *  immune to the tile drag-handle and z-stacking. Empty value ⇒ auto (caller's
 *  default). Local + remote branches in separate optgroups. */
/** Searchable branch combobox — a trigger button + a filterable popover list.
 *  A plain <select> is unusable on repos with hundreds of branches; this filters
 *  local + remote refs as you type. Closes on pick / outside-click / Escape. */
function BranchPicker({
  label,
  value,
  onChange,
  branches,
  autoLabel,
}: {
  label: string;
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  branches: GitBranchList | undefined;
  autoLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const local = (branches?.local ?? []).filter((b) => b.toLowerCase().includes(q));
  const remote = (branches?.remote ?? []).filter((b) => b.toLowerCase().includes(q));

  const pick = (v: string | undefined) => { onChange(v); setOpen(false); setQuery(""); };

  return (
    <div className="nodrag relative inline-flex items-center gap-1 text-[10px] font-mono" ref={ref}>
      <span className="text-[var(--color-fg3)]">{label}</span>
      <button
        className="nodrag cursor-pointer max-w-[150px] inline-flex items-center gap-1 bg-[var(--color-bg)] border border-[var(--color-line2)] rounded px-1.5 py-0.5 text-[var(--color-fg)] outline-none hover:border-[var(--color-fg3)] transition-colors"
        onClick={() => setOpen((o) => !o)}
        title={value ?? autoLabel}
      >
        <span className="truncate">{value ?? autoLabel}</span>
        <span aria-hidden className="text-[var(--color-fg3)] shrink-0">▾</span>
      </button>
      {open && (
        <div className="nodrag absolute z-50 left-0 top-full mt-1 w-60 flex flex-col bg-[var(--color-bg3)] border border-[var(--color-line2)] rounded-lg shadow-xl overflow-hidden">
          <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[var(--color-line2)]">
            <Search size={11} aria-hidden className="text-[var(--color-fg3)] shrink-0" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="filter branches…"
              className="w-full bg-transparent text-[10px] font-mono text-[var(--color-fg)] outline-none placeholder:text-[var(--color-fg3)]"
            />
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            <button
              className={`w-full cursor-pointer text-left px-2 py-1 transition-colors ${value == null ? "text-[var(--color-accent)] bg-[var(--color-bg4)]" : "text-[var(--color-fg2)] hover:bg-[var(--color-bg4)]"}`}
              onClick={() => pick(undefined)}
            >
              {autoLabel}
            </button>
            {local.length > 0 && (
              <div className="px-2 pt-1.5 pb-0.5 text-[8.5px] uppercase tracking-wider text-[var(--color-fg3)]">local</div>
            )}
            {local.map((b) => (
              <button
                key={`l:${b}`}
                className={`w-full cursor-pointer text-left truncate px-2 py-1 transition-colors ${value === b ? "text-[var(--color-accent)] bg-[var(--color-bg4)]" : "text-[var(--color-fg)] hover:bg-[var(--color-bg4)]"}`}
                onClick={() => pick(b)}
                title={b}
              >
                {b}
              </button>
            ))}
            {remote.length > 0 && (
              <div className="px-2 pt-1.5 pb-0.5 text-[8.5px] uppercase tracking-wider text-[var(--color-fg3)]">remote</div>
            )}
            {remote.map((b) => (
              <button
                key={`r:${b}`}
                className={`w-full cursor-pointer text-left truncate px-2 py-1 transition-colors ${value === b ? "text-[var(--color-accent)] bg-[var(--color-bg4)]" : "text-[var(--color-fg)] hover:bg-[var(--color-bg4)]"}`}
                onClick={() => pick(b)}
                title={b}
              >
                {b}
              </button>
            ))}
            {local.length === 0 && remote.length === 0 && (
              <div className="px-2 py-2 text-[var(--color-fg3)]">{branches ? "no match" : "loading…"}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function useBranchItems(repoPath: string, scope: DiffScope, enabled: boolean): ItemsResult {
  const q = useGitDiff(enabled ? repoPath : null, scope);
  const items = useMemo(() => {
    const patch = q.data?.patch;
    if (!patch || !patch.trim()) return [];
    const out: CodeViewDiffItem<ReviewComment>[] = [];
    const base = q.dataUpdatedAt;
    for (const parsed of parsePatchFiles(patch, q.data?.cacheKey)) {
      for (const fileDiff of parsed.files) {
        out.push({ id: `diff:${fileDiff.name}`, type: "diff", fileDiff, version: base });
      }
    }
    return out;
  }, [q.data, q.dataUpdatedAt]);
  return { items, isLoading: q.isLoading, error: (q.error as Error) ?? null };
}

/** Cheap stable 32-bit hash → numeric `version` for CodeView reconciliation. */
function hashNum(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

interface SearchMatch {
  id: string;
  file: string;
  line: number;
  side: AnnotationSide;
}

/** Collect every line-level match across all diff items, mapping hunkContent
 *  block indices back to real line numbers + side (port of codiff's
 *  getDiffSearchResult). Lets us scrollTo + highlight each hit precisely. */
function collectMatches(items: CodeViewDiffItem<ReviewComment>[], query: string): SearchMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: SearchMatch[] = [];
  for (const it of items) {
    const fd = it.fileDiff;
    for (const hunk of fd.hunks) {
      let del = hunk.deletionStart;
      let add = hunk.additionStart;
      for (const c of hunk.hunkContent) {
        if (c.type === "context") {
          for (let i = 0; i < c.lines; i++) {
            if ((fd.additionLines[c.additionLineIndex + i] ?? "").toLowerCase().includes(q))
              out.push({ id: it.id, file: fd.name, line: add + i, side: "additions" });
          }
          del += c.lines;
          add += c.lines;
        } else {
          for (let i = 0; i < c.deletions; i++) {
            if ((fd.deletionLines[c.deletionLineIndex + i] ?? "").toLowerCase().includes(q))
              out.push({ id: it.id, file: fd.name, line: del + i, side: "deletions" });
          }
          for (let i = 0; i < c.additions; i++) {
            if ((fd.additionLines[c.additionLineIndex + i] ?? "").toLowerCase().includes(q))
              out.push({ id: it.id, file: fd.name, line: add + i, side: "additions" });
          }
          del += c.deletions;
          add += c.additions;
        }
      }
    }
  }
  return out;
}

// ── per-file header ───────────────────────────────────────────────────────

function DiffHeader(props: {
  h: number;
  fontPx: number;
  file: string;
  adds: number;
  dels: number;
  staged: boolean;
  collapsed: boolean;
  viewed: boolean;
  showStage: boolean;
  onToggleCollapsed: () => void;
  onToggleViewed: () => void;
  onToggleStage: () => void;
  onOpen: () => void;
  onDiscard: () => void;
}) {
  return (
    <div
      // The comment gutter resolves which file a clicked line belongs to by
      // finding the nearest preceding header in document order — this attribute is
      // that anchor (robust to Pierre's gutter API not carrying the file id).
      data-diff-file={props.file}
      className={`flex items-center gap-2 px-2.5 w-full font-mono bg-[var(--color-bg3)] border-b border-[var(--color-line)] ${
        props.viewed ? "opacity-55" : ""
      }`}
      style={{ height: props.h, fontSize: props.fontPx }}
    >
      <button
        title={props.collapsed ? "expand" : "collapse"}
        onClick={(e) => {
          e.stopPropagation();
          props.onToggleCollapsed();
        }}
        className="text-[var(--color-fg3)] hover:text-[var(--color-fg)] w-3 text-[0.82em]"
      >
        {props.collapsed ? "▸" : "▾"}
      </button>

      {props.showStage && (
        <button
          title={props.staged ? "unstage" : "stage"}
          onClick={(e) => {
            e.stopPropagation();
            props.onToggleStage();
          }}
          style={{
            width: 14,
            height: 14,
            borderRadius: 3,
            border: props.staged ? "1px solid var(--color-ok)" : "1px solid var(--color-line2)",
            background: props.staged ? "var(--color-ok)" : "transparent",
            color: props.staged ? "var(--color-bg)" : "transparent",
            fontSize: "0.82em",
            lineHeight: "12px",
          }}
        >
          ✓
        </button>
      )}

      <span className="text-[var(--color-fg)] truncate" title={props.file}>{props.file}</span>
      <span style={{ color: "var(--color-ok)" }}>+{props.adds}</span>
      <span style={{ color: "var(--color-err)" }}>−{props.dels}</span>

      <span className="ml-auto inline-flex items-center gap-2">
        <button
          title="mark viewed"
          onClick={(e) => {
            e.stopPropagation();
            props.onToggleViewed();
          }}
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[0.92em] transition-colors ${
            props.viewed
              ? "border-[var(--color-ok)] text-[var(--color-ok)]"
              : "border-[var(--color-line2)] text-[var(--color-fg3)] hover:text-[var(--color-fg2)]"
          }`}
        >
          {props.viewed ? "✓ viewed" : "viewed"}
        </button>
        <button
          title="open file in viewer"
          onClick={(e) => {
            e.stopPropagation();
            props.onOpen();
          }}
          className="px-1.5 py-0.5 rounded border border-[var(--color-line2)] text-[var(--color-fg2)] text-[0.92em]"
        >
          ↗ open
        </button>
        {props.showStage && (
          <button
            title="discard changes"
            onClick={(e) => {
              e.stopPropagation();
              props.onDiscard();
            }}
            className="px-1.5 py-0.5 rounded border border-[var(--color-line2)] text-[var(--color-err)] text-[0.92em]"
          >
            ⌫
          </button>
        )}
      </span>
    </div>
  );
}

// ── single-file CodeView popup (header "↗ open") ──────────────────────────

function FileView(props: { repoPath: string; file: string; onClose: () => void }) {
  const q = useQuery<string>({
    queryKey: ["git:file", props.repoPath, props.file, "WORKING"],
    queryFn: () => window.hive.gitFileContents(props.repoPath, props.file, "WORKING"),
  });
  const data = q.data;
  const oversized = data != null && new Blob([data]).size > 10 * 1024 * 1024;
  const binary = data != null && data.slice(0, 8192).indexOf("\0") !== -1;
  const item: CodeViewItem | null =
    data != null && !oversized && !binary
      ? {
          id: `file:${props.file}`,
          type: "file",
          file: {
            name: props.file,
            contents: data,
            cacheKey: `${props.repoPath}:WORKING:${props.file}:${q.dataUpdatedAt}`,
          },
        }
      : null;
  return (
    <div className="h-full flex flex-col border-b border-[var(--color-line)]">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-[var(--color-bg3)] text-[11px] font-mono shrink-0">
        <span className="text-[var(--color-fg)] truncate" title={props.file}>{props.file}</span>
        <span className="text-[var(--color-fg3)]">· working copy</span>
        <button className="ml-auto text-[10px] text-[var(--color-fg3)]" onClick={props.onClose}>close</button>
      </div>
      <div className="flex-1 overflow-auto">
        {q.isLoading && <div className="p-3 text-[11px] text-[var(--color-fg3)]">loading {props.file}…</div>}
        {q.error && (
          <div className="p-3 text-[11px] text-[var(--color-err)] font-mono">{(q.error as Error).message}</div>
        )}
        {data != null && oversized && (
          <div className="p-3 text-[11px] text-[var(--color-warn)] font-mono">
            file too large to preview ({(new Blob([data]).size / (1024 * 1024)).toFixed(1)} MB)
          </div>
        )}
        {data != null && !oversized && binary && (
          <div className="p-3 text-[11px] text-[var(--color-warn)] font-mono">binary file — not shown</div>
        )}
        {item && (
          <CodeView
            className="h-full w-full overflow-y-auto"
            items={[item]}
            options={{ theme: { dark: "pierre-dark", light: "pierre-light" }, themeType: "dark", overflow: "scroll" }}
          />
        )}
      </div>
    </div>
  );
}

// ── conflict view (UnresolvedFile — outside CodeView) ─────────────────────

function ConflictView(props: { repoPath: string; file: string }) {
  const conflict = useQuery<{ raw: string; conflicts: number }>({
    queryKey: ["git:conflict", props.repoPath, props.file],
    queryFn: () => window.hive.gitConflictedFile(props.repoPath, props.file),
  });
  if (conflict.isLoading) return <div className="px-3 py-2 text-[10px]">loading {props.file}…</div>;
  if (!conflict.data) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const UF = UnresolvedFile as any;
  return (
    <UF
      file={{
        name: props.file,
        contents: conflict.data.raw,
        cacheKey: `${props.repoPath}:CONFLICT:${props.file}:${conflict.data.conflicts}`,
      }}
      options={{ theme: { dark: "pierre-dark", light: "pierre-light" }, diffStyle: "split" }}
      onResolved={(resolved: string) => {
        void window.hive.gitWriteResolved(props.repoPath, props.file, resolved);
      }}
    />
  );
}

