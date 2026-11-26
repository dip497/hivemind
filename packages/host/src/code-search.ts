/**
 * Finding on a workspace's host: a file by its name, a line by its text
 * (docs/design/code-tools-2026-11-02.md §3.2). The work is fff's (github.com/dmtrKovalenko/fff.nvim,
 * MIT), its Rust core loaded through `@ff-labs/fff-node`: a typo-tolerant fuzzy match ranked by
 * what the person opens often and lately and by git status, and a grep with plain, regex and fuzzy
 * modes that pages and keeps to a time budget. Measured here on this repository: indexed in 61 ms,
 * a file found in 3 ms, a grep in 60 ms. fff runs in a process of its own (code-search-process.ts),
 * as its calls hold the thread they run on: one index per repo there, closed after ten minutes without
 * a question. fff watches the tree itself, so a write costs the app nothing.
 *
 * Where fff cannot load (a platform it ships no binary for, the `hive` binary, which bun compiles
 * without it, a repo on another machine) the same questions are answered from git: its file list
 * scored by fzf (`fzf`, the fzf algorithm in JavaScript), and `git grep`. Slower, never wrong.
 */
import { execFile, fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Fzf } from "fzf";
import { isRemote } from "@hivemind/core/remote-uri";
import type { FindFilesPage, FoundLine, GrepMode, GrepPage } from "@hivemind/workspace-api/code";
import { gitListFiles } from "./git-adapter.js";
import { Superseded } from "./git-history.js";
import { runRemoteGit } from "./remote/git.js";

/** How long the fff process lives unasked, and the most the git fallback keeps. */
const IDLE_MS = 10 * 60_000;
const GREP_PAGE = 200;
/** The longest fff may take over one question, its start and a first scan's wait included: past
 *  it the process is killed, and git answers that repo until the fff process next stops idle. */
export const FFF_ANSWER_MS = 10_000;

export interface GrepOpts { mode?: GrepMode; cursor?: number; caseSensitive?: boolean }

/** What the fff process is asked (code-search-process.ts), and what it answers: null where fff could not. */
export type ToSearch =
  | { id: number; t: "files"; repo: string; query: string; limit: number }
  | { id: number; t: "grep"; repo: string; query: string; opts: GrepOpts }
  | { id: number; t: "picked"; repo: string; query: string; file: string };
export type FromSearch = { id: number; result: unknown } | { id: number; error: string };
type Question = ToSearch extends infer T ? (T extends ToSearch ? Omit<T, "id"> : never) : never;

/** Where fff keeps what the person picked, per machine: a habit, not the workspace's. */
let stateDir: string | null = null;
export function setSearchStateDir(dir: string): void { stateDir = dir; }

/** Built next to this code as .js (the app's bundle), or run from source as .ts; null in the `hive`
 *  binary, which carries neither. */
function processFile(): string | null {
  for (const name of ["./code-search-process.js", "./code-search-process.ts"]) {
    try {
      const file = fileURLToPath(new URL(name, import.meta.url));
      if (fs.existsSync(file)) return file;
    } catch { /* not a file URL */ }
  }
  return null;
}

interface Asked { q: Question; asker?: object; resolve: (v: unknown) => void; reject: (e: Error) => void; superseded?: boolean }

/**
 * The fff process: started on the first question, stopped after `IDLE_MS` without one. One question
 * at a time goes to it, so a grep still waiting when the same asker greps the same repo again is
 * dropped before fff spends its budget on it, and one already running is answered `Superseded`.
 */
class FffProcess {
  private child: ChildProcess | null = null;
  private broken = process.env.HIVEMIND_FFF === "0";
  private queue: Asked[] = [];
  private running: (Asked & { id: number; late: ReturnType<typeof setTimeout> }) | null = null;
  private nextId = 1;
  private idle?: ReturnType<typeof setTimeout>;
  /** Repos fff once took too long on: git answers them. */
  private readonly slow = new Set<string>();

  /** fff's answer; null where fff cannot answer (no process, fff did not load, a remote repo). */
  ask(q: Question, asker?: object): Promise<unknown> {
    if (this.broken || isRemote(q.repo) || this.slow.has(q.repo)) return Promise.resolve(null);
    if (q.t === "grep" && asker) {
      const same = (a: Asked) => a.q.t === "grep" && a.asker === asker && a.q.repo === q.repo;
      for (const a of this.queue.filter(same)) {
        this.queue.splice(this.queue.indexOf(a), 1);
        a.reject(new Superseded());
      }
      if (this.running && same(this.running)) this.running.superseded = true;
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ q, ...(asker ? { asker } : {}), resolve, reject });
      this.next();
    });
  }

  stop(): void {
    clearTimeout(this.idle);
    this.slow.clear();
    const child = this.child;
    this.child = null;
    if (child?.connected) child.disconnect();
  }

  private next(): void {
    while (!this.running && this.queue.length) {
      const child = this.start();
      const a = this.queue.shift()!;
      if (!child) { a.resolve(null); continue; }
      const id = this.nextId++;
      this.running = { ...a, id, late: setTimeout(() => this.late(child, id), FFF_ANSWER_MS) };
      child.send({ ...a.q, id });
    }
    this.hold(!!this.running);
  }

  /** The process keeps this one alive only while it owes an answer. */
  private hold(on: boolean): void {
    // Bun's IPC channel has no ref/unref.
    const c = this.child as (ChildProcess & { channel?: { ref?(): void; unref?(): void } }) | null;
    if (on) { c?.ref(); c?.channel?.ref?.(); } else { c?.unref(); c?.channel?.unref?.(); }
  }

  private start(): ChildProcess | null {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), IDLE_MS);
    this.idle.unref?.();
    if (this.child) return this.child;
    const file = this.broken ? null : processFile();
    if (!file) { this.broken = true; return null; }
    const child = fork(file, stateDir ? [stateDir] : [], {
      // Plain Node from the app's own binary; from source, with the loader that started this one.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      execArgv: file.endsWith(".ts") ? process.execArgv : [],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    this.child = child;
    child.on("message", (m: FromSearch) => this.answered(m));
    child.on("error", () => { this.broken = true; this.gone(child); });
    child.on("exit", () => this.gone(child));
    return child;
  }

  /** fff is stuck on the question: the process goes, and `gone` answers it from git. */
  private late(child: ChildProcess, id: number): void {
    if (this.running?.id !== id) return;
    const repo = this.running.q.repo;
    this.slow.add(repo);
    for (const a of this.queue.filter((a) => a.q.repo === repo)) {
      this.queue.splice(this.queue.indexOf(a), 1);
      a.resolve(null);
    }
    child.kill("SIGKILL");
  }

  private answered(m: FromSearch): void {
    const r = this.running;
    if (!r || r.id !== m.id) return;
    clearTimeout(r.late);
    this.running = null;
    if (r.superseded) r.reject(new Superseded());
    else if ("error" in m) r.reject(new Error(m.error));
    else r.resolve(m.result);
    this.next();
  }

  /** The process ended: what it held is answered by git, and the next question starts another. */
  private gone(child: ChildProcess): void {
    if (this.child !== child && this.child !== null) return;
    this.child = null;
    const r = this.running;
    this.running = null;
    if (r) {
      clearTimeout(r.late);
      if (r.superseded) r.reject(new Superseded()); else r.resolve(null);
    }
    this.next();
  }
}

const fff = new FffProcess();

/** Stop the fff process: its indexes, watchers and memory go with it. */
export async function closeFinder(): Promise<void> {
  fff.stop();
}

// ── a file by its name ───────────────────────────────────────────────────────

export async function findFiles(repo: string, query: string, limit = 50): Promise<FindFilesPage> {
  const page = (await fff.ask({ t: "files", repo, query, limit })) as FindFilesPage | null;
  if (page) return page;
  // git's list, scored by the fzf algorithm; the best first.
  const paths = await gitListFiles(repo);
  const fzf = new Fzf(paths, { limit, casing: "smart-case" });
  return { files: (query ? fzf.find(query).map((e) => e.item) : paths.slice(0, limit)).map((p) => ({ path: p })), engine: "git" };
}

/** The person picked `file` for `query`: fff ranks it higher for that query next time. */
export async function pickedFile(repo: string, query: string, file: string): Promise<void> {
  await fff.ask({ t: "picked", repo, query, file });
}

// ── a line by its text ───────────────────────────────────────────────────────

/** `asker`: who asks (a window's connection). Their next grep of the same repo replaces this one,
 *  which then fails with `Superseded`. */
export async function grep(repo: string, query: string, opts: GrepOpts = {}, asker?: object): Promise<GrepPage> {
  const page = (await fff.ask({ t: "grep", repo, query, opts }, asker)) as GrepPage | null;
  return page ?? gitGrep(repo, query, opts.mode ?? "plain", !!opts.caseSensitive);
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
