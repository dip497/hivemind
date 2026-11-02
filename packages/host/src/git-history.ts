/**
 * History on a workspace's host: the log, a file's history, blame and a commit
 * (docs/design/git-history-2026-11-02.md). What makes it fast, measured on git's own repository
 * (82,668 commits):
 *
 * - First screen first: the log's first page is the current branch in git's own order, read
 *   without walking the rest (6 ms there); a file's history and every other list come a page at a
 *   time; blame takes the lines on screen (`from`/`to`) when the editor asks for them.
 * - git's commit-graph with changed-path Bloom filters, kept by `keepCommitGraph`: a file's
 *   history 695 → 164 ms, the log by date 929 → 140 ms, blame 1,400 → 988 ms.
 * - Cheap by default: no `-M -C` in blame unless asked (3× here), no `--follow` (a rename is
 *   looked up once, at the commit that added the file, as IntelliJ does).
 * - Each answer cached by what decides it (`HEAD`, the refs, a commit's oid, the text blamed), so
 *   a question is not asked of git twice; a blame of a file superseded by the next one of the
 *   same file is stopped (Zed kills a dropped blame's process the same way).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { isRemote } from "@hivemind/core/remote-uri";
import { readSettings } from "@hivemind/core/settings";
import type {
  BlameHunk, BlameOptions, BlamePayload, CommitFile, CommitInfo, FileHistoryCursor, FileHistoryEntry, FileHistoryPage, LogCommit, LogOptions, LogPage,
} from "@hivemind/workspace-api/git";
import { runRemoteGit } from "./remote/git.js";

const FIELD = "\x1f";
const RECORD = "\x1e";
const ZERO = /^0{40}$|^0{64}$/;
const TIMEOUT_MS = 60_000;
/** A page of the log by default, and the most a page may hold. */
export const LOG_PAGE = 200;
export const LOG_PAGE_MAX = 1000;
/** A page of a file's history. */
export const FILE_PAGE = 100;

class Superseded extends Error {
  constructor() { super("superseded by a newer request"); this.name = "Superseded"; }
}

/** The process of each request that a newer one of the same key replaces. */
const running = new Map<string, ChildProcess>();

/** Run git in `repo`, with `stdin` when given. A `key` names what the run answers: a newer run of
 *  the same key stops this one (its caller gets `Superseded`). A repo on another machine runs over
 *  ssh, which takes no stdin: callers fall back before asking it to. */
async function git(repo: string, args: string[], opts: { stdin?: string; key?: string } = {}): Promise<string> {
  if (isRemote(repo)) return runRemoteGit(repo, args, TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    const p = spawn("git", args, { cwd: repo, env: process.env, stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    if (opts.key) {
      running.get(opts.key)?.kill("SIGKILL");
      running.set(opts.key, p);
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let killed = false;
    const timer = setTimeout(() => { killed = true; p.kill("SIGKILL"); }, TIMEOUT_MS);
    p.stdout!.on("data", (d: Buffer) => out.push(d));
    p.stderr!.on("data", (d: Buffer) => err.push(d));
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (code, signal) => {
      clearTimeout(timer);
      const mine = opts.key ? running.get(opts.key) === p : true;
      if (opts.key && mine) running.delete(opts.key);
      if (opts.key && !mine) return reject(new Superseded());
      if (killed) return reject(new Error(`git ${args[0]} took more than ${TIMEOUT_MS / 1000} s`));
      if (code === 0) return resolve(Buffer.concat(out).toString("utf8"));
      reject(new Error(`git ${args.join(" ")} → exit ${code ?? signal}: ${Buffer.concat(err).toString("utf8").trim()}`));
    });
    if (opts.stdin !== undefined) {
      p.stdin!.on("error", () => { /* git exited before reading it all: its exit says why */ });
      p.stdin!.end(opts.stdin);
    }
  });
}

// ── the cache ────────────────────────────────────────────────────────────────

/** Answers per repo, least recently used out past this many. */
const CACHE_PER_REPO = 64;
const caches = new Map<string, Map<string, unknown>>();

async function cached<T>(repo: string, key: string, make: () => Promise<T>): Promise<T> {
  let c = caches.get(repo);
  if (!c) caches.set(repo, (c = new Map()));
  if (c.has(key)) {
    const v = c.get(key) as T;
    c.delete(key);
    c.set(key, v);
    return v;
  }
  const v = await make();
  c.set(key, v);
  if (c.size > CACHE_PER_REPO) c.delete(c.keys().next().value!);
  return v;
}

/** Forget a repo's answers: tests, and a repo whose history was rewritten under the same refs. */
export function forgetHistory(repo?: string): void {
  if (repo) caches.delete(repo);
  else caches.clear();
}

/** What `HEAD` is now; null in a repo with no commit yet. */
async function headOf(repo: string): Promise<string | null> {
  try { return (await git(repo, ["rev-parse", "--verify", "-q", "HEAD"])).trim() || null; } catch { return null; }
}

/** Every ref and what it points at, as one short key: the log by date reads all of them. */
async function refsKey(repo: string): Promise<string> {
  const refs = await git(repo, ["for-each-ref", "--format=%(objectname) %(refname)"]).catch(() => "");
  return createHash("sha1").update(refs).update((await headOf(repo)) ?? "").digest("hex");
}

// ── the log ──────────────────────────────────────────────────────────────────

const LOG_FORMAT = ["%H", "%P", "%at", "%an", "%ae", "%s", "%D"].join(FIELD) + RECORD;

function parseLog(out: string): LogCommit[] {
  const commits: LogCommit[] = [];
  for (const raw of out.split(RECORD)) {
    const rec = raw.replace(/^\n/, "");
    if (!rec) continue;
    const [oid, parents, time, author, email, subject, refs] = rec.split(FIELD);
    if (!oid) continue;
    commits.push({
      oid, parents: parents ? parents.split(" ") : [], time: Number(time) || 0, author: author ?? "", email: email ?? "", subject: subject ?? "",
      refs: refs ? refs.split(", ").filter(Boolean) : [],
    });
  }
  return commits;
}

export async function gitLog(repo: string, opts: LogOptions = {}): Promise<LogPage> {
  const limit = Math.min(LOG_PAGE_MAX, Math.max(1, Math.floor(opts.limit ?? LOG_PAGE)));
  const skip = Math.max(0, Math.floor(opts.cursor ?? 0));
  void keepCommitGraph(repo);
  const head = await headOf(repo);
  if (!head) return { commits: [], next: null };
  const identity = opts.all ? await refsKey(repo) : head;
  return cached(repo, `log:${opts.all ? "all" : "head"}:${identity}:${skip}:${limit}`, async () => {
    // One more than asked says whether there is a next page.
    const args = ["log", `--format=${LOG_FORMAT}`, `--max-count=${limit + 1}`, `--skip=${skip}`, "--decorate=short"];
    // `--all` walks every ref; tags are left out, which IntelliJ found slow with many of them.
    if (opts.all) args.push("--branches", "--remotes", "HEAD", "--date-order");
    else args.push("HEAD");
    const commits = parseLog(await git(repo, args));
    return { commits: commits.slice(0, limit), next: commits.length > limit ? skip + limit : null };
  });
}

// ── a file's history ─────────────────────────────────────────────────────────

const HISTORY_FORMAT = ["%H", "%at", "%an", "%s"].join(FIELD) + RECORD;

/** The path `file` had before `oid`, when `oid` renamed it (a copy is not followed). */
async function renamedFrom(repo: string, oid: string, file: string): Promise<string | null> {
  const out = await git(repo, ["show", "-M", "--name-status", "-z", "--format=", oid]);
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i] ?? "";
    if (status.startsWith("R") && parts[i + 2] === file) return parts[i + 1] ?? null;
    // A rename or copy names two paths, anything else one.
    if (status.startsWith("R") || status.startsWith("C")) i += 2;
    else i += 1;
  }
  return null;
}

export async function gitFileHistory(repo: string, file: string, cursor?: FileHistoryCursor): Promise<FileHistoryPage> {
  void keepCommitGraph(repo);
  const head = await headOf(repo);
  if (!head) return { entries: [], next: null };
  const at = cursor ?? { rev: "HEAD", path: file, skip: 0 };
  const rev = at.rev === "HEAD" ? head : at.rev;
  return cached(repo, `history:${rev}:${at.path}:${at.skip}`, async () => {
    const out = await git(repo, ["log", `--format=${HISTORY_FORMAT}`, `--max-count=${FILE_PAGE + 1}`, `--skip=${at.skip}`, rev, "--", at.path]);
    const rows = out.split(RECORD).map((r) => r.replace(/^\n/, "")).filter(Boolean).map((r) => r.split(FIELD));
    const entries: FileHistoryEntry[] = rows.slice(0, FILE_PAGE).map(([oid, time, author, subject]) => ({
      oid: oid!, time: Number(time) || 0, author: author ?? "", subject: subject ?? "", path: at.path,
    }));
    if (rows.length > FILE_PAGE) return { entries, next: { rev, path: at.path, skip: at.skip + FILE_PAGE } };
    // The stretch ends where the file was added under this path: was it renamed there?
    const oldest = entries[entries.length - 1];
    if (!oldest) return { entries, next: null };
    const from = await renamedFrom(repo, oldest.oid, at.path);
    if (!from) return { entries, next: null };
    oldest.renamedFrom = from;
    return { entries, next: { rev: `${oldest.oid}^`, path: from, skip: 0 } };
  });
}

// ── blame ────────────────────────────────────────────────────────────────────

/** `git blame --incremental` as runs of lines: each entry is a header (`<oid> <orig> <final>
 *  <count>`), the commit's details the first time it appears, and `filename` to close it. */
export function parseIncremental(out: string): BlameHunk[] {
  const seen = new Map<string, { author: string; time: number; summary: string }>();
  const hunks: BlameHunk[] = [];
  let current: { oid: string; start: number; lines: number } | null = null;
  let meta: { author: string; time: number; summary: string } | null = null;
  for (const line of out.split("\n")) {
    if (!current) {
      const m = /^([0-9a-f]{40,64}) \d+ (\d+) (\d+)$/.exec(line);
      if (!m) continue;
      current = { oid: m[1]!, start: Number(m[2]), lines: Number(m[3]) };
      meta = seen.get(current.oid) ?? { author: "", time: 0, summary: "" };
      continue;
    }
    if (line.startsWith("author ")) meta!.author = line.slice(7);
    else if (line.startsWith("author-time ")) meta!.time = Number(line.slice(12)) || 0;
    else if (line.startsWith("summary ")) meta!.summary = line.slice(8);
    else if (line.startsWith("filename ")) {
      seen.set(current.oid, meta!);
      const uncommitted = ZERO.test(current.oid);
      hunks.push({ oid: uncommitted ? null : current.oid, start: current.start, lines: current.lines, author: uncommitted ? "" : meta!.author, time: uncommitted ? 0 : meta!.time, summary: uncommitted ? "" : meta!.summary });
      current = null;
      meta = null;
    }
  }
  return hunks.sort((a, b) => a.start - b.start);
}

export async function gitBlame(repo: string, file: string, opts: BlameOptions = {}): Promise<BlamePayload> {
  void keepCommitGraph(repo);
  const head = await headOf(repo);
  const range = opts.from && opts.to && opts.to >= opts.from ? ["-L", `${opts.from},${opts.to}`] : [];
  const moved = opts.moved ? ["-w", "-M", "-C"] : [];
  // A file in a repo with no commit yet: every line is not committed yet.
  if (!head) {
    const lines = opts.contents !== undefined ? opts.contents.split("\n").length : 0;
    return { hunks: lines ? [{ oid: null, start: 1, lines, author: "", time: 0, summary: "" }] : [], contents: opts.contents !== undefined };
  }
  const key = `${repo}\0blame\0${file}`;
  const withText = opts.contents !== undefined && !isRemote(repo);
  const text = withText ? createHash("sha1").update(opts.contents!).digest("hex") : "";
  return cached(repo, `blame:${head}:${file}:${range.join("")}:${moved.length}:${text}`, async () => {
    const plain = ["blame", "--incremental", ...moved, ...range, "HEAD", "--", file];
    if (withText) {
      try {
        const out = await git(repo, ["blame", "--incremental", ...moved, ...range, "--contents", "-", "HEAD", "--", file], { stdin: opts.contents, key });
        return { hunks: parseIncremental(out), contents: true };
      } catch (e) {
        // git before 2.41 refuses `--contents` with a revision: the committed file is blamed.
        if (!/cannot use --contents/.test((e as Error).message)) throw e;
      }
    }
    return { hunks: parseIncremental(await git(repo, plain, { key })), contents: false };
  });
}

// ── a commit ─────────────────────────────────────────────────────────────────

const STATUS: Record<string, string> = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "typechange" };

export async function gitCommitInfo(repo: string, sha: string): Promise<CommitInfo> {
  const oid = (await git(repo, ["rev-parse", "--verify", `${sha}^{commit}`])).trim();
  // A commit does not change: once read, it is known.
  return cached(repo, `commit:${oid}`, async () => {
    const [head, names, nums] = await Promise.all([
      git(repo, ["show", "-s", `--format=${["%H", "%P", "%an", "%ae", "%at", "%cn", "%ct", "%B"].join(FIELD)}`, oid]),
      git(repo, ["show", "-M", "--name-status", "-z", "--format=", oid]),
      git(repo, ["show", "-M", "--numstat", "-z", "--format=", oid]),
    ]);
    const [, parents, author, email, time, committer, committerTime, ...message] = head.split(FIELD);
    const files: CommitFile[] = [];
    const n = names.split("\0");
    for (let i = 0; i < n.length; i++) {
      const s = n[i] ?? "";
      if (!s) continue;
      const kind = STATUS[s[0]!] ?? "modified";
      if (s[0] === "R" || s[0] === "C") { files.push({ path: n[i + 2]!, status: kind, from: n[i + 1]!, add: null, del: null }); i += 2; }
      else { files.push({ path: n[i + 1]!, status: kind, add: null, del: null }); i += 1; }
    }
    // `--numstat -z`: `add\tdel\tpath\0`, or for a rename `add\tdel\t\0from\0to\0`.
    const counts = new Map<string, [number | null, number | null]>();
    const m = nums.split("\0");
    for (let i = 0; i < m.length; i++) {
      const row = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec((m[i] ?? "").replace(/^\n/, ""));
      if (!row) continue;
      const add = row[1] === "-" ? null : Number(row[1]);
      const del = row[2] === "-" ? null : Number(row[2]);
      if (row[3]) counts.set(row[3], [add, del]);
      else { counts.set(m[i + 2] ?? "", [add, del]); i += 2; }
    }
    for (const f of files) {
      const c = counts.get(f.path);
      if (c) [f.add, f.del] = c;
    }
    return {
      oid, parents: parents ? parents.split(" ") : [], author: author ?? "", email: email ?? "", time: Number(time) || 0,
      committer: committer ?? "", committerTime: Number(committerTime) || 0, message: message.join(FIELD).trimEnd(), files,
    };
  });
}

// ── git's commit-graph, with changed-path Bloom filters ─────────────────────

/** Repos whose commit-graph was written (or is being) by this process. */
const kept = new Map<string, Promise<void>>();
const again = new Map<string, ReturnType<typeof setTimeout>>();

/** Settings ▸ Advanced ▸ Speed up history: on unless the person turned it off. */
async function commitGraphWanted(): Promise<boolean> {
  if (process.env.HIVEMIND_COMMIT_GRAPH === "0") return false;
  try { return (await readSettings()).code.commitGraph; } catch { return true; }
}

/** Write git's commit-graph with changed-path Bloom filters, incrementally (`--split`), at the
 *  lowest priority, once per repo per run of the host and again after `refresh`. What git's own
 *  `gc` writes (`gc.writeCommitGraph`), with the Bloom filters added. Not for a repo on another
 *  machine, a shallow clone, or when the setting is off. Never throws: history works without it. */
export function keepCommitGraph(repo: string, refresh = false): Promise<void> {
  if (!refresh && kept.has(repo)) return kept.get(repo)!;
  const run = (async () => {
    if (isRemote(repo) || !(await commitGraphWanted())) return;
    try {
      if ((await git(repo, ["rev-parse", "--is-shallow-repository"])).trim() === "true") return;
      const args = ["commit-graph", "write", "--reachable", "--changed-paths", "--split"];
      await new Promise<void>((resolve) => {
        const nice = process.platform !== "win32";
        const p = spawn(nice ? "nice" : "git", nice ? ["-n", "19", "git", ...args] : args, { cwd: repo, env: process.env, stdio: "ignore" });
        p.on("error", () => resolve());
        p.on("close", () => resolve());
      });
    } catch { /* not a repo, or git refused: history is slower, not wrong */ }
  })();
  kept.set(repo, run);
  return run;
}

/** After the app moved a ref (a commit, a pull): write the new commits' part of the graph, a few
 *  seconds later so a burst of commits is written once. */
export function refreshCommitGraph(repo: string): void {
  clearTimeout(again.get(repo));
  again.set(repo, setTimeout(() => { again.delete(repo); void keepCommitGraph(repo, true); }, 5_000));
}

export { Superseded };
