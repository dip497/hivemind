/**
 * fff's half of finding (code-search.ts), in a process of its own: its file search and grep run on
 * the calling thread for up to the grep's time budget, which on the app's main process held every
 * window. Its native library crashes a worker thread as the thread ends, so this is a process.
 * Started by `code-search.ts` with the folder fff keeps the person's picks in; speaks `ToSearch` /
 * `FromSearch` over the IPC channel and ends when that channel closes.
 */
import path from "node:path";
// Type imports only: run from source, a child gets no loader that maps `./x.js` to `./x.ts`.
import type { FindFilesPage, FoundFile, FoundLine, GrepPage } from "@hivemind/workspace-api/code";
import type { FromSearch, ToSearch } from "./code-search.js";

const IDLE_MS = 10 * 60_000;
const GREP_PAGE = 200;
const GREP_BUDGET_MS = 1500;
/** How long a question waits on a repo's first scan; still scanning after it, git answers this one. */
const SCAN_WAIT_MS = 3000;

type Fff = typeof import("@ff-labs/fff-node");
type Finder = import("@ff-labs/fff-node").FileFinderApi;

const stateDir = process.argv[2] || null;
const fff: Promise<Fff | null> = import("@ff-labs/fff-node").then((m) => (m.binaryExists() ? m : null)).catch(() => null);

interface Open { finder: Finder; ready: Promise<unknown>; scanned: boolean; idle: ReturnType<typeof setTimeout> }
const open = new Map<string, Promise<Open | null>>();

/** The repo's index, made on first use and closed when unasked for `IDLE_MS`. */
async function finderFor(repo: string): Promise<Open | null> {
  let o = open.get(repo);
  if (!o) {
    o = (async () => {
      const m = await fff;
      if (!m) return null;
      const made = m.FileFinder.create({
        basePath: repo,
        ...(stateDir ? { frecencyDbPath: path.join(stateDir, "fff-frecency"), historyDbPath: path.join(stateDir, "fff-history") } : {}),
      });
      if (!made.ok) return null;
      return { finder: made.value, ready: made.value.waitForScan(SCAN_WAIT_MS), scanned: false, idle: setTimeout(() => {}, 0) };
    })().catch(() => null);
    open.set(repo, o);
  }
  const got = await o;
  if (got) {
    clearTimeout(got.idle);
    got.idle = setTimeout(() => void closeFinder(repo), IDLE_MS);
    await got.ready;
    if (!got.scanned && got.finder.isScanning()) return null;
    got.scanned = true;
  } else open.delete(repo);
  return got;
}

async function closeFinder(repo: string): Promise<void> {
  const o = open.get(repo);
  if (!o) return;
  open.delete(repo);
  const got = await o;
  if (got) { clearTimeout(got.idle); got.finder.destroy(); }
}

async function findFiles(repo: string, query: string, limit: number): Promise<FindFilesPage | null> {
  const f = await finderFor(repo);
  const r = f?.finder.fileSearch(query, { pageSize: limit });
  if (!r?.ok) return null;
  return {
    files: r.value.items.slice(0, limit).map((i): FoundFile => ({ path: i.relativePath, ...(i.gitStatus && i.gitStatus !== "clean" ? { git: i.gitStatus } : {}) })),
    engine: "fff",
  };
}

async function grep(repo: string, query: string, opts: Extract<ToSearch, { t: "grep" }>["opts"]): Promise<GrepPage | null> {
  const f = await finderFor(repo);
  if (!f) return null;
  // A cursor is a file offset in fff's order, in the shape its own `nextCursor` has.
  const cursor = opts.cursor ? ({ __brand: "GrepCursor", _offset: opts.cursor } as unknown as import("@ff-labs/fff-node").GrepCursor) : null;
  const r = f.finder.grep(query, { mode: opts.mode ?? "plain", pageSize: GREP_PAGE, smartCase: !opts.caseSensitive, timeBudgetMs: GREP_BUDGET_MS, maxMatchesPerFile: 50, cursor });
  if (!r.ok) return null;
  return {
    lines: r.value.items.map((i): FoundLine => ({ path: i.relativePath, line: i.lineNumber, col: i.col, text: i.lineContent.slice(0, 400), ranges: i.matchRanges })),
    next: r.value.nextCursor ? r.value.nextCursor._offset : null,
    files: r.value.totalFilesSearched,
    engine: "fff",
    ...(r.value.regexFallbackError ? { note: r.value.regexFallbackError } : {}),
  };
}

async function answer(m: ToSearch): Promise<unknown> {
  switch (m.t) {
    case "files": return findFiles(m.repo, m.query, m.limit);
    case "grep": return grep(m.repo, m.query, m.opts);
    case "picked": {
      const f = await finderFor(m.repo);
      if (f && m.query) f.finder.trackQuery(m.query, path.join(m.repo, m.file));
      return null;
    }
  }
}

process.on("message", (m: ToSearch) => {
  void answer(m).then(
    (result) => process.send?.({ id: m.id, result } satisfies FromSearch),
    (e: unknown) => process.send?.({ id: m.id, error: e instanceof Error ? e.message : String(e) } satisfies FromSearch),
  );
});
process.on("disconnect", () => process.exit(0));
