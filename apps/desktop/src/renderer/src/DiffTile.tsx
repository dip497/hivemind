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
import { GripVertical, Play } from "lucide-react";
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
import type { DiffScope, GitFileEntry, GitStatusSnapshot } from "../../shared/ipc";
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
import { latestClaude } from "./claude-bus";
import { DiffReviewPanel } from "./DiffReviewPanel";
import { normalizeComments, newCid, type ReviewComment } from "./diff-comments";

interface Props {
  repoPath: string;
  initialMode?: "working" | "branch";
  initialBase?: string;
  onClose?: () => void;
}

type Mode = "working" | "branch";
type Layout = "split" | "unified";
type Overflow = "scroll" | "wrap";

const COMMENTS_KEY_PREFIX = "hivemind:comments:";
const VIEWED_KEY_PREFIX = "hivemind:viewed:";

/** Per-file header height (px). Shared between the rendered <DiffHeader> and
 *  CodeView's `itemMetrics.diffHeaderHeight` so virtualization + sticky math
 *  match the actual DOM. */
const HEADER_H = 34;

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function DiffTile({ repoPath, initialMode = "working", initialBase = "origin/main", onClose }: Props) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [staged, setStaged] = useState(false);
  const [layout, setLayout] = useState<Layout>("split");
  const [overflow, setOverflow] = useState<Overflow>("scroll");
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [search, setSearch] = useState("");

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
  const [viewed, setViewed] = useState<Set<string>>(
    () => new Set(loadJson<string[]>(VIEWED_KEY_PREFIX + repoPath, [])),
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [composer, setComposer] = useState<
    { file: string; startLine: number; endLine: number; side: AnnotationSide } | null
  >(null);

  const codeViewRef = useRef<CodeViewHandle<ReviewComment>>(null);

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

  // ── git:file cache invalidation on fs change (owned here, not in queries.ts) ──
  const qc = useQueryClient();
  useEffect(() => {
    const unsub = window.hive.onFsChanged(repoPath, ({ paths }) => {
      qc.invalidateQueries({
        predicate: (q) =>
          q.queryKey[0] === "git:file" &&
          q.queryKey[1] === repoPath &&
          paths.some(
            (p) => p === `${repoPath}/${q.queryKey[2]}` || p.endsWith(`/${q.queryKey[2]}`),
          ),
      });
    });
    return unsub;
  }, [qc, repoPath]);

  // ── build CodeView items per mode ───────────────────────────────────────
  const workingItems = useWorkingItems(repoPath, mode === "working" ? status?.files ?? [] : [], staged);
  const branchScope: DiffScope = useMemo(() => ({ kind: "branch", base: initialBase }), [initialBase]);
  const branch = useBranchItems(repoPath, branchScope, mode === "branch");

  const baseItems = mode === "working" ? workingItems.items : branch.items;

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
      expandUnchanged: true,
      collapsedContextThreshold: 12,
      expansionLineCount: 60,
      lineDiffType: "char",
      maxLineDiffLength: 2000,
      hunkSeparators: "line-info-basic",
      enableLineSelection: true,
      enableGutterUtility: mode === "working",
      tokenizeMaxLength: 100_000,
      // MUST match DiffHeader's rendered height — CodeView reserves this many
      // px for the header slot and uses it for sticky-header positioning
      // (CodeView.js getStickyHeaderOffset). Mismatch ⇒ clipped / overlapping
      // rows, which is why the diff looked "incomplete" before.
      itemMetrics: { diffHeaderHeight: HEADER_H },
      layout: { gap: 10, paddingTop: 8, paddingBottom: 8 },
      onGutterUtilityClick: (range, context) => {
        // Comments work in BOTH working- and branch-diff modes. The gutter "+"
        // carries the CURRENT line selection range, so dragging across several
        // lines then clicking + comments on the whole range (not one line).
        if (context.item.type !== "diff") return;
        const side: AnnotationSide = range.side ?? range.endSide ?? "additions";
        const startLine = Math.min(range.start, range.end);
        const endLine = Math.max(range.start, range.end);
        setComposer({ file: context.item.fileDiff.name, startLine, endLine, side });
      },
    }),
    [layout, overflow],
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
    [status, collapsed, viewed, mode, repoPath, toggleCollapsed, toggleViewed, stageMut, unstageMut, discardMut],
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

  // Send arbitrary review text to claude — spawn a tile first if none is live
  // (otherwise the bus event vanishes). Shared by batch + per-thread sends.
  const sendToClaude = useCallback((msg: string) => {
    if (!latestClaude()) {
      window.dispatchEvent(new CustomEvent("hivemind:spawn-claude"));
      setTimeout(() => window.dispatchEvent(new CustomEvent<string>("hivemind:send-to-claude", { detail: msg })), 2500);
    } else {
      window.dispatchEvent(new CustomEvent<string>("hivemind:send-to-claude", { detail: msg }));
    }
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

  const loading = mode === "working" ? workingItems.isLoading : branch.isLoading;
  const modeError = mode === "branch" ? branch.error : workingItems.error;

  return (
    <div
      className="flex flex-col h-full bg-[var(--color-bg2)] border border-[var(--color-line)] rounded-xl overflow-hidden"
      style={PIERRE_CSS_VARS}
    >
      {/* tile chrome */}
      <div className="tile-drag-handle h-8 flex items-center gap-2 px-2.5 bg-[var(--color-bg3)] border-b border-[var(--color-line)] text-[11px] font-mono text-[var(--color-fg2)] cursor-grab active:cursor-grabbing">
        <GripVertical aria-hidden size={13} className="text-[var(--color-fg3)] -ml-1 shrink-0" />
        <span className="font-semibold text-[var(--color-fg)]">Diff</span>
        <span aria-hidden className="text-[var(--color-line2)]">·</span>
        <span className="text-[var(--color-fg2)]">{repoPath.split("/").slice(-1)[0]}</span>

        <div className="nodrag ml-2.5 inline-flex rounded-md overflow-hidden bg-[var(--color-bg)] border border-[var(--color-line2)]">
          <button
            className={`px-2.5 py-0.5 text-[10.5px] font-mono transition-colors ${
              mode === "working"
                ? "bg-[var(--color-bg4)] text-[var(--color-accent)] font-semibold"
                : "text-[var(--color-fg3)] hover:text-[var(--color-fg2)]"
            }`}
            onClick={() => setMode("working")}
          >
            working
          </button>
          <button
            className={`px-2.5 py-0.5 text-[10.5px] font-mono transition-colors ${
              mode === "branch"
                ? "bg-[var(--color-bg4)] text-[var(--color-accent)] font-semibold"
                : "text-[var(--color-fg3)] hover:text-[var(--color-fg2)]"
            }`}
            onClick={() => setMode("branch")}
            title={`compare branch to ${initialBase}`}
          >
            branch
          </button>
        </div>

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

        <div className="nodrag ml-1.5 inline-flex items-center gap-1 px-1 py-0.5 rounded bg-[var(--color-bg)] border border-[var(--color-line2)]">
          <button
            className={`px-1.5 text-[10px] font-mono rounded transition-colors ${
              layout === "split" ? "text-[var(--color-accent)] bg-[var(--color-bg4)]" : "text-[var(--color-fg3)] hover:text-[var(--color-fg2)]"
            }`}
            onClick={() => setLayout("split")}
            title="split layout"
          >
            split
          </button>
          <button
            className={`px-1.5 text-[10px] font-mono rounded transition-colors ${
              layout === "unified" ? "text-[var(--color-accent)] bg-[var(--color-bg4)]" : "text-[var(--color-fg3)] hover:text-[var(--color-fg2)]"
            }`}
            onClick={() => setLayout("unified")}
            title="unified layout"
          >
            unified
          </button>
          <span aria-hidden className="text-[var(--color-line2)]">|</span>
          <button
            className={`px-1.5 text-[10px] font-mono rounded transition-colors ${
              overflow === "wrap" ? "text-[var(--color-accent)] bg-[var(--color-bg4)]" : "text-[var(--color-fg3)] hover:text-[var(--color-fg2)]"
            }`}
            onClick={() => setOverflow((o) => (o === "scroll" ? "wrap" : "scroll"))}
            title="toggle long-line wrap"
          >
            wrap
          </button>
        </div>

        {/* in-diff search — line-level matches, scroll + highlight, ↑/↓ nav */}
        <div className="nodrag ml-1.5 inline-flex items-center gap-1 bg-[var(--color-bg)] border border-[var(--color-line2)] rounded px-1.5 py-0.5">
          <input
            className="w-28 bg-transparent text-[10px] font-mono text-[var(--color-fg)] outline-none placeholder:text-[var(--color-fg3)]"
            placeholder="search diff…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                gotoMatch(matchIdx + (e.shiftKey ? -1 : 1));
              }
              if (e.key === "Escape") setSearch("");
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
          <aside className="nodrag w-[210px] shrink-0 flex flex-col border-r border-[var(--color-line)] bg-[var(--color-bg2)] overflow-hidden">
            <div className="h-7 shrink-0 flex items-center gap-1.5 px-2.5 border-b border-[var(--color-line2)] text-[10px] uppercase tracking-wider font-semibold text-[var(--color-fg3)]">
              Files
              <span className="ml-auto font-mono tabular-nums text-[var(--color-fg3)]">{viewed.size}/{fileRows.length}</span>
            </div>
            <div className="flex-1 overflow-y-auto py-1">
              {fileRows.map((r) => {
                const isViewed = viewed.has(r.file);
                const slash = r.file.lastIndexOf("/");
                const name = slash === -1 ? r.file : r.file.slice(slash + 1);
                const dir = slash === -1 ? "" : r.file.slice(0, slash);
                return (
                  <div
                    key={r.id}
                    onClick={() => jumpToFile(r.id)}
                    title={r.file}
                    className="group flex items-center gap-1.5 px-2 py-1 cursor-pointer hover:bg-[var(--color-bg3)]"
                  >
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleViewed(r.file); }}
                      title={isViewed ? "Mark not reviewed" : "Mark reviewed"}
                      aria-label={isViewed ? `Mark ${name} not reviewed` : `Mark ${name} reviewed`}
                      className="shrink-0 size-3.5 grid place-items-center rounded-sm border cursor-pointer"
                      style={{ background: isViewed ? "var(--color-ok)" : "transparent", borderColor: isViewed ? "var(--color-ok)" : "var(--color-line2)" }}
                    >
                      {isViewed && <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden><path d="M2 5L4 7L8 3" stroke="var(--color-bg)" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className={`truncate text-[11.5px] leading-tight ${isViewed ? "text-[var(--color-fg3)] line-through" : "text-[var(--color-fg)]"}`}>{name}</div>
                      {dir && <div className="truncate text-[9px] text-[var(--color-fg3)] font-mono leading-tight">{dir}</div>}
                    </div>
                    <span className="shrink-0 font-mono text-[9px] tabular-nums">
                      <span className="text-[var(--color-ok)]">+{r.adds}</span>{" "}
                      <span className="text-[var(--color-err)]">−{r.dels}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </aside>
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
              {mode === "working" ? "✓ working tree clean" : "✓ no commits on this branch beyond base"}
            </div>
          )}

          {!activeFile && !modeError && !loading && items.length > 0 && (
            <div className="flex-1 min-h-0">
              <CodeView<ReviewComment>
                ref={codeViewRef}
                className="h-full w-full overflow-y-auto"
                items={items}
                options={options}
                renderCustomHeader={renderCustomHeader}
                renderAnnotation={renderAnnotation}
              />
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
            className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded text-white bg-[var(--color-brand)] hover:opacity-90 text-[10.5px] font-medium"
            title="Send all review comments to claude (spawns one if none is running)"
          >
            <Play size={9} fill="currentColor" strokeWidth={0} aria-hidden />
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

      {composer && (
        <Composer composer={composer} onSubmit={submitComposer} onCancel={() => setComposer(null)} />
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
      className={`flex items-center gap-2 px-2.5 w-full text-[11px] font-mono bg-[var(--color-bg3)] border-b border-[var(--color-line)] ${
        props.viewed ? "opacity-55" : ""
      }`}
      style={{ height: HEADER_H }}
    >
      <button
        title={props.collapsed ? "expand" : "collapse"}
        onClick={(e) => {
          e.stopPropagation();
          props.onToggleCollapsed();
        }}
        className="text-[var(--color-fg3)] hover:text-[var(--color-fg)] w-3 text-[9px]"
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
            fontSize: 9,
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
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] transition-colors ${
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
          className="px-1.5 py-0.5 rounded border border-[var(--color-line2)] text-[var(--color-fg2)] text-[10px]"
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
            className="px-1.5 py-0.5 rounded border border-[var(--color-line2)] text-[var(--color-err)] text-[10px]"
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

// ── inline comment composer ───────────────────────────────────────────────

function Composer({
  composer,
  onSubmit,
  onCancel,
}: {
  composer: { file: string; startLine: number; endLine: number; side: AnnotationSide };
  onSubmit: (body: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const range = composer.startLine === composer.endLine
    ? `${composer.startLine}`
    : `${composer.startLine}-${composer.endLine}`;
  return (
    <div className="border-t border-[var(--color-line)] bg-[var(--color-bg3)] p-2 flex items-center gap-2">
      <span className="text-[10px] font-mono text-[var(--color-fg3)] shrink-0">
        {composer.file}:{range} ({composer.side})
      </span>
      <input
        autoFocus
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit(body);
          if (e.key === "Escape") onCancel();
        }}
        placeholder="comment ↵ send · esc cancel"
        className="flex-1 bg-[var(--color-bg)] border border-[var(--color-line2)] rounded px-2 py-1 text-[11px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
      />
      <button className="text-[10px] font-mono text-[var(--color-accent)]" onClick={() => onSubmit(body)}>send</button>
      <button className="text-[10px] font-mono text-[var(--color-fg3)]" onClick={onCancel}>cancel</button>
    </div>
  );
}
