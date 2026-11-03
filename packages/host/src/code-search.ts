/**
 * Finding on a workspace's host: a file by its name, a line by its text
 * (docs/design/code-tools-2026-11-02.md §3.2). The work is fff's (github.com/dmtrKovalenko/fff.nvim,
 * MIT), its Rust core loaded through `@ff-labs/fff-node`: a typo-tolerant fuzzy match ranked by
 * what the person opens often and lately and by git status, and a grep with plain, regex and fuzzy
 * modes that pages and keeps to a time budget. Measured here on this repository: indexed in 61 ms,
 * a file found in 3 ms, a grep in 60 ms. One index per repo, made on the first question and closed
 * after ten minutes without one; fff watches the tree itself, so a write costs the app nothing.
 *
 * Where fff cannot load (a platform it ships no binary for, the `hive` binary, which bun compiles
 * without it, a repo on another machine) the same questions are answered from git: its file list
 * scored by fzf (`fzf`, the fzf algorithm in JavaScript), and `git grep`. Slower, never wrong.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { Fzf } from "fzf";
import { isRemote } from "@hivemind/core/remote-uri";
import type { FoundFile, FoundLine, FindFilesPage, GrepMode, GrepPage } from "@hivemind/workspace-api/code";
import { gitListFiles } from "./git-adapter.js";
import { runRemoteGit } from "./remote/git.js";

/** What the fallback asks of git, the most it keeps, and how long an index lives unasked. */
const IDLE_MS = 10 * 60_000;
const GREP_PAGE = 200;
const GREP_BUDGET_MS = 1500;

type Fff = typeof import("@ff-labs/fff-node");
type Finder = import("@ff-labs/fff-node").FileFinderApi;

let fff: Promise<Fff | null> | null = null;
/** fff, once; null where it cannot load, and then never again in this process. */
function loadFff(): Promise<Fff | null> {
  if (process.env.HIVEMIND_FFF === "0") return Promise.resolve(null);
  fff ??= import("@ff-labs/fff-node").then((m) => (m.binaryExists() ? m : null)).catch(() => null);
  return fff;
}

interface Open { finder: Finder; ready: Promise<unknown>; idle: ReturnType<typeof setTimeout> }
const open = new Map<string, Promise<Open | null>>();

/** Where fff keeps what the person picked, per machine: a habit, not the workspace's. */
let stateDir: string | null = null;
export function setSearchStateDir(dir: string): void { stateDir = dir; }

/** The repo's index, made on first use and closed when unasked for `IDLE_MS`. */
async function finderFor(repo: string): Promise<Open | null> {
  if (isRemote(repo)) return null;
  let o = open.get(repo);
  if (!o) {
    o = (async () => {
      const m = await loadFff();
      if (!m) return null;
      const made = m.FileFinder.create({
        basePath: repo,
        ...(stateDir ? { frecencyDbPath: path.join(stateDir, "fff-frecency"), historyDbPath: path.join(stateDir, "fff-history") } : {}),
      });
      if (!made.ok) return null;
      return { finder: made.value, ready: made.value.waitForScan(10_000), idle: setTimeout(() => {}, 0) };
    })().catch(() => null);
    open.set(repo, o);
  }
  const got = await o;
  if (got) {
    clearTimeout(got.idle);
    got.idle = setTimeout(() => closeFinder(repo), IDLE_MS);
    got.idle.unref?.();
    await got.ready;
  } else open.delete(repo);
  return got;
}

/** Close a repo's index (or every one): its watcher stops and its memory goes. */
export async function closeFinder(repo?: string): Promise<void> {
  for (const [r, o] of [...open]) {
    if (repo && r !== repo) continue;
    open.delete(r);
    const got = await o;
    if (got) { clearTimeout(got.idle); got.finder.destroy(); }
  }
}

// ── a file by its name ───────────────────────────────────────────────────────

export async function findFiles(repo: string, query: string, limit = 50): Promise<FindFilesPage> {
  const f = await finderFor(repo);
  if (f) {
    const r = f.finder.fileSearch(query, { pageSize: limit });
    if (r.ok) {
      return {
        files: r.value.items.slice(0, limit).map((i): FoundFile => ({ path: i.relativePath, ...(i.gitStatus && i.gitStatus !== "clean" ? { git: i.gitStatus } : {}) })),
        engine: "fff",
      };
    }
  }
  // git's list, scored by the fzf algorithm; the best first.
  const paths = await gitListFiles(repo);
  const fzf = new Fzf(paths, { limit, casing: "smart-case" });
  return { files: (query ? fzf.find(query).map((e) => e.item) : paths.slice(0, limit)).map((p) => ({ path: p })), engine: "git" };
}

/** The person picked `file` for `query`: fff ranks it higher for that query next time. */
export async function pickedFile(repo: string, query: string, file: string): Promise<void> {
  const f = await finderFor(repo);
  if (f && query) f.finder.trackQuery(query, path.join(repo, file));
}

// ── a line by its text ───────────────────────────────────────────────────────

export interface GrepOpts { mode?: GrepMode; cursor?: number; caseSensitive?: boolean }

export async function grep(repo: string, query: string, opts: GrepOpts = {}): Promise<GrepPage> {
  const mode = opts.mode ?? "plain";
  const f = await finderFor(repo);
  if (f) {
    // A cursor is a file offset in fff's order, in the shape its own `nextCursor` has.
    const cursor = opts.cursor ? ({ __brand: "GrepCursor", _offset: opts.cursor } as unknown as import("@ff-labs/fff-node").GrepCursor) : null;
    const r = f.finder.grep(query, { mode, pageSize: GREP_PAGE, smartCase: !opts.caseSensitive, timeBudgetMs: GREP_BUDGET_MS, maxMatchesPerFile: 50, cursor });
    if (r.ok) {
      return {
        lines: r.value.items.map((i): FoundLine => ({ path: i.relativePath, line: i.lineNumber, col: i.col, text: i.lineContent.slice(0, 400), ranges: i.matchRanges })),
        next: r.value.nextCursor ? r.value.nextCursor._offset : null,
        files: r.value.totalFilesSearched,
        engine: "fff",
        ...(r.value.regexFallbackError ? { note: r.value.regexFallbackError } : {}),
      };
    }
  }
  return gitGrep(repo, query, mode, !!opts.caseSensitive);
}

/** `git grep`: tracked files, the first `GREP_PAGE` lines, no paging. Fuzzy is read as plain. */
async function gitGrep(repo: string, query: string, mode: GrepMode, caseSensitive: boolean): Promise<GrepPage> {
  const args = ["grep", "-n", "--column", "-I", "--no-color", `--max-count=50`, mode === "regex" ? "-E" : "-F"];
  if (!caseSensitive && query === query.toLowerCase()) args.push("-i");
  args.push("-e", query, "--");
  let out = "";
  try {
    out = isRemote(repo) ? await runRemoteGit(repo, args, 30_000) : await new Promise<string>((resolve, reject) =>
      execFile("git", args, { cwd: repo, maxBuffer: 32 << 20, timeout: 30_000 }, (err, stdout) => {
        // 1: nothing found.
        if (err && (err as { code?: number }).code !== 1) reject(err); else resolve(stdout);
      }));
  } catch (e) {
    if (/exit 1\b/.test((e as Error).message)) out = "";
    else throw e;
  }
  const lines: FoundLine[] = [];
  for (const row of out.split("\n")) {
    const m = /^(.*?):(\d+):(\d+):(.*)$/.exec(row);
    if (!m) continue;
    const text = m[4]!;
    const at = (caseSensitive ? text : text.toLowerCase()).indexOf(caseSensitive ? query : query.toLowerCase());
    lines.push({ path: m[1]!, line: Number(m[2]), col: Number(m[3]) - 1, text: text.slice(0, 400), ranges: mode === "plain" && at >= 0 ? [[at, at + query.length]] : [] });
    if (lines.length >= GREP_PAGE) break;
  }
  return { lines, next: null, files: null, engine: "git" };
}
