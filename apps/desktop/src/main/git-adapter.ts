/**
 * Git adapter — simple-git wrappers + a few raw spawns where simple-git's
 * API isn't expressive enough (`status --porcelain=v2`, `worktree list --porcelain`).
 *
 * Everything is keyed by a repo absolute path; we hold one SimpleGit instance
 * per repo in a small cache so we don't re-init on every call.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { applyShellEnvToProcess } from "./shell-env.js";
import { isRemote } from "../shared/remote-uri.js";
import { runRemoteGit, readRemoteFile, writeRemoteFile } from "./remote/git.js";
import type {
  DiffPayload,
  DiffScope,
  GitFileEntry,
  GitFileStatus,
  GitStatusSnapshot,
  WorktreeCreateOpts,
  WorktreeEntry,
} from "../shared/ipc.js";

const instances = new Map<string, SimpleGit>();
function repo(p: string): SimpleGit {
  let g = instances.get(p);
  if (!g) {
    g = simpleGit(p, { binary: "git", maxConcurrentProcesses: 4 });
    instances.set(p, g);
  }
  return g;
}

/** Run `git <args>` in `repoPath`. Belt-and-suspenders PATH handling (matches
 *  superset.sh's `execGitWithShellPath`): pass `process.env` explicitly so any
 *  later mutation is visible per call, and on ENOENT re-run shell-env
 *  resolution + retry ONCE. This catches the case where Electron is launched
 *  before `applyShellEnvToProcess()` finishes (it's fire-and-forget). */
/** Per-subcommand timeout (ms). Reads complete in <1s on normal repos; we cap
 *  at 30s so a hung index lock or a slow NFS mount can't wedge the renderer's
 *  loading state forever. Long-running ops (push/fetch/clone) override via
 *  GIT_TIMEOUTS below. */
const GIT_DEFAULT_TIMEOUT_MS = 30_000;
const GIT_TIMEOUTS: Record<string, number> = {
  push: 5 * 60_000,
  fetch: 5 * 60_000,
  clone: 10 * 60_000,
  diff: 60_000, // large diffs on big repos take a beat
};

async function rawGit(repoPath: string, args: string[]): Promise<string> {
  const timeoutMs = GIT_TIMEOUTS[args[0] ?? ""] ?? GIT_DEFAULT_TIMEOUT_MS;
  // Remote repo (ssh:// uri): run git over ssh exec instead of a local spawn.
  // Every porcelain op built on rawGit (status, ls-files, diff, show, rev-parse,
  // commit, push, branch, worktree…) becomes remote-capable for free.
  if (isRemote(repoPath)) return runRemoteGit(repoPath, args, timeoutMs);
  try {
    return await spawnGit(repoPath, args, timeoutMs);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw e;
    // PATH probably hadn't been patched yet — force a sync await + retry once.
    await applyShellEnvToProcess();
    return spawnGit(repoPath, args, timeoutMs);
  }
}

function spawnGit(repoPath: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("git", args, { cwd: repoPath, env: process.env });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // SIGTERM first; if git is stuck in a network call or holding an index
      // lock it should respond. Fallback SIGKILL after a short grace.
      try { p.kill("SIGTERM"); } catch { /* already exited */ }
      setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* gone */ } }, 2000);
    }, timeoutMs);
    p.stdout.on("data", (d) => out.push(d as Buffer));
    p.stderr.on("data", (d) => err.push(d as Buffer));
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`git ${args.join(" ")} timed out after ${timeoutMs}ms`));
        return;
      }
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else
        reject(
          new Error(`git ${args.join(" ")} → exit ${code}: ${Buffer.concat(err).toString("utf8")}`),
        );
    });
  });
}

/** Of `paths` (repo-relative), the subset that a `.gitignore` rule matches —
 *  even when the file is TRACKED. Plain `git status`/`diff` surface a file that
 *  was committed and only LATER added to `.gitignore`, because `.gitignore`
 *  never un-tracks; and plain `git check-ignore` reports a tracked path as NOT
 *  ignored. `--no-index` applies the ignore rules regardless of the index, which
 *  is what lets us hide such files from the diff / file tree. NUL-delimited I/O
 *  so paths with spaces/newlines are safe. Best-effort: any failure (git
 *  missing, exit 128) yields an empty set — we never hide MORE than git says. */
async function ignoredPaths(repoPath: string, paths: string[]): Promise<Set<string>> {
  const ignored = new Set<string>();
  if (paths.length === 0) return ignored;
  const out = await new Promise<string>((resolve) => {
    // exit 0 = some ignored, 1 = none, 128 = error — all fine; we only read stdout.
    const p = spawn("git", ["check-ignore", "--no-index", "-z", "--stdin"], {
      cwd: repoPath,
      env: process.env,
    });
    const chunks: Buffer[] = [];
    p.stdout.on("data", (d) => chunks.push(d as Buffer));
    p.on("error", () => resolve("")); // git not found → hide nothing
    p.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    p.stdin.on("error", () => { /* EPIPE if git exits before we finish writing */ });
    p.stdin.end(paths.join("\0"));
  });
  for (const m of out.split("\0")) if (m) ignored.add(m);
  return ignored;
}

// ── status (porcelain v2 parser) ───────────────────────────────────────

const XY_TO_STATUS: Record<string, GitFileStatus> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  U: "conflicted",
  T: "modified", // type change
  "!": "ignored",
  "?": "untracked",
};

export async function gitStatus(repoPath: string): Promise<GitStatusSnapshot> {
  const snap: GitStatusSnapshot = {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
    conflictedFiles: [],
    isMerging: false,
    isRebasing: false,
    head: "",
  };

  let raw: string;
  try {
    raw = await rawGit(repoPath, [
      "status",
      "--porcelain=v2",
      "--branch",
      "--untracked-files=normal",
      // Explicit: gitignored files MUST NOT appear in DiffTile / FileTreeTile.
      // `--ignored=no` is the default but stating it locks the behavior against
      // future flag drift. Note: a file that was tracked BEFORE being added to
      // .gitignore still surfaces — git only skips gitignored UNtracked files.
      // To hide such files use `git rm --cached <path> && commit`.
      "--ignored=no",
    ]);
  } catch (e) {
    // Non-git folder → no status (the file tree still works via the ls-files
    // fallback). Git decorations simply don't show. Other errors propagate.
    if (/not a git repository/i.test((e as Error).message)) return snap;
    throw e;
  }

  for (const line of raw.split("\n")) {
    if (!line) continue;
    if (line.startsWith("# ")) {
      // # branch.oid <sha> | # branch.head <branch> | # branch.upstream <name> | # branch.ab +N -N
      const [, key, ...rest] = line.split(" ");
      const val = rest.join(" ");
      if (key === "branch.oid") snap.head = val;
      else if (key === "branch.head") snap.branch = val === "(detached)" ? null : val;
      else if (key === "branch.upstream") snap.upstream = val;
      else if (key === "branch.ab") {
        const m = /\+(\d+) -(\d+)/.exec(val);
        if (m) {
          snap.ahead = Number(m[1]);
          snap.behind = Number(m[2]);
        }
      }
      continue;
    }
    if (line[0] === "1") {
      // 1 XY sub mode-H mode-I mode-W hash-H hash-I path
      const parts = line.split(" ");
      const xy = parts[1] ?? "..";
      const filePath = parts.slice(8).join(" ");
      snap.files.push(makeEntry(filePath, xy));
    } else if (line[0] === "2") {
      // 2 XY sub mode-H mode-I mode-W hash-H hash-I X<score> path<TAB>origPath
      const parts = line.split(" ");
      const xy = parts[1] ?? "..";
      const tail = parts.slice(9).join(" ");
      const [filePath, origPath] = tail.split("\t");
      const entry = makeEntry(filePath ?? "", xy);
      entry.origPath = origPath;
      snap.files.push(entry);
    } else if (line[0] === "u") {
      // u XY sub mode-1 mode-2 mode-3 mode-W hash-1 hash-2 hash-3 path
      const parts = line.split(" ");
      const filePath = parts.slice(10).join(" ");
      snap.files.push({
        path: filePath,
        status: "conflicted",
        staged: false,
        unstaged: true,
      });
      snap.conflictedFiles.push(filePath);
    } else if (line[0] === "?") {
      snap.files.push({
        path: line.slice(2),
        status: "untracked",
        staged: false,
        unstaged: true,
      });
    } else if (line[0] === "!") {
      snap.files.push({
        path: line.slice(2),
        status: "ignored",
        staged: false,
        unstaged: false,
      });
    }
  }

  // Detect merge/rebase by checking .git filesystem markers. Local only — a
  // remote repo's .git isn't on this host's FS (MVP: no merge/rebase banner
  // for remote frames; the status itself is correct).
  if (!isRemote(repoPath)) {
    const gitDir = path.join(repoPath, ".git");
    try {
      await fs.stat(path.join(gitDir, "MERGE_HEAD"));
      snap.isMerging = true;
    } catch {
      /* not merging */
    }
    try {
      await fs.stat(path.join(gitDir, "rebase-merge"));
      snap.isRebasing = true;
    } catch {
      try {
        await fs.stat(path.join(gitDir, "rebase-apply"));
        snap.isRebasing = true;
      } catch {
        /* not rebasing */
      }
    }
  }

  // Drop TRACKED files that match a .gitignore rule. `--ignored=no` above
  // already hides untracked-ignored files; this hides the leftover case — a
  // file committed before being gitignored, which git still surfaces because
  // .gitignore can't untrack. Now the diff respects .gitignore for those too.
  const ignored = await ignoredPaths(repoPath, snap.files.map((f) => f.path));
  if (ignored.size) {
    snap.files = snap.files.filter((f) => !ignored.has(f.path));
    snap.conflictedFiles = snap.conflictedFiles.filter((p) => !ignored.has(p));
  }
  return snap;
}

function makeEntry(filePath: string, xy: string): GitFileEntry {
  const X = xy[0] ?? ".";
  const Y = xy[1] ?? ".";
  const status: GitFileStatus = XY_TO_STATUS[X !== "." ? X : Y] ?? "modified";
  return {
    path: filePath,
    status,
    staged: X !== "." && X !== "?",
    unstaged: Y !== ".",
  };
}

// ── diff ───────────────────────────────────────────────────────────────

// Dirs never worth walking in the non-git fallback (heavy / noise).
const WALK_IGNORE = new Set([
  ".git", "node_modules", ".next", "dist", "build", "out", ".turbo", ".cache",
  "target", ".venv", "venv", "__pycache__", ".idea", ".gradle", "vendor",
]);
const WALK_MAX = 5000;

/** Recursive directory listing for a NON-git folder — relative POSIX paths,
 *  skipping heavy/ignored dirs and dotfolders, bounded so a huge tree can't
 *  hang the UI. Local FS only. */
async function walkDir(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    if (out.length >= WALK_MAX) return;
    let entries: import("node:fs").Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (out.length >= WALK_MAX) return;
      const name = e.name;
      const childRel = rel ? `${rel}/${name}` : name;
      if (e.isDirectory()) {
        if (WALK_IGNORE.has(name) || name.startsWith(".")) continue;
        await walk(path.join(dir, name), childRel);
      } else if (e.isFile()) {
        out.push(childRel);
      }
    }
  };
  await walk(root, "");
  return out.sort();
}

export async function gitListFiles(repoPath: string): Promise<string[]> {
  // tracked + untracked, respecting .gitignore. Deduped, sorted, NUL-safe.
  let raw: string;
  try {
    raw = await rawGit(repoPath, [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ]);
  } catch (e) {
    // Not a git repo (or git missing) → plain directory walk so the editor /
    // file tree still works on any folder. Remote non-git falls through to the
    // error (the fs walk is local-only). Git status/diff just stay empty.
    if (!isRemote(repoPath) && /not a git repository/i.test((e as Error).message)) {
      return walkDir(repoPath);
    }
    throw e;
  }
  const seen = new Set<string>();
  for (const p of raw.split("\0")) {
    if (p) seen.add(p);
  }
  // `--exclude-standard` already drops untracked-ignored files; this also drops
  // TRACKED files that match .gitignore (committed before being ignored), so the
  // file tree respects .gitignore the same way the diff now does.
  const all = Array.from(seen);
  const ignored = await ignoredPaths(repoPath, all);
  return all.filter((p) => !ignored.has(p)).sort();
}

/** True if `ref` resolves to a commit in this repo. Non-throwing. */
async function refExists(repoPath: string, ref: string): Promise<boolean> {
  try {
    await rawGit(repoPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the base ref for a branch-diff. NO fallback guessing (main/master/
 *  upstream cascades return the wrong base in real repos — see SO 28666357).
 *  Resolution order, each AUTHORITATIVE:
 *    1. an explicit user-chosen base (only if it actually exists), else
 *    2. the remote's recorded default branch via `origin/HEAD` — the canonical,
 *       network-free source (`git symbolic-ref --short refs/remotes/origin/HEAD`).
 *  Returns null when neither resolves (no remote, or origin/HEAD not set — fix
 *  with `git remote set-head origin -a`). Caller renders an empty diff, never
 *  crashes and never diffs against a guessed/wrong base. */
async function resolveBranchBase(repoPath: string, requested?: string): Promise<string | null> {
  const r = requested?.trim();
  if (r && (await refExists(repoPath, r))) return r;
  try {
    const head = (await rawGit(repoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).trim();
    if (head && (await refExists(repoPath, head))) return head; // e.g. "origin/main"
  } catch { /* origin/HEAD not set / no remote */ }
  return null;
}

export async function gitDiff(
  repoPath: string,
  scope: DiffScope,
  file?: string
): Promise<DiffPayload> {
  const args = ["diff", "--no-color", "--no-ext-diff"];
  let branchBase: string | null = null;
  if (scope.kind === "working") {
    if (scope.staged) args.push("--staged");
    else args.push("HEAD");
  } else if (scope.kind === "branch") {
    branchBase = await resolveBranchBase(repoPath, scope.base);
    if (!branchBase) {
      // No authoritative base ref — return an empty diff instead of letting
      // `git diff bad-ref...HEAD` exit 128 and bubble a raw error. (No guessed
      // main/master fallback by design.)
      const head = (await rawGit(repoPath, ["rev-parse", "HEAD"])).trim();
      return { patch: "", cacheKey: `${repoPath}:${head}:branch-none${file ? `:${file}` : ""}` };
    }
    args.push(`${branchBase}...HEAD`);
  } else if (scope.kind === "commit") {
    args.push(`${scope.sha}^!`);
  }
  if (file) args.push("--", file);

  const patch = await rawGit(repoPath, args);

  // Cache key: HEAD sha + scope + file. Pierre's worker AST cache uses this.
  const head = (await rawGit(repoPath, ["rev-parse", "HEAD"])).trim();
  const scopeKey =
    scope.kind === "working"
      ? `working${scope.staged ? "-staged" : ""}`
      : scope.kind === "branch"
        ? `branch-${branchBase ?? scope.base ?? "origin/main"}`
        : `commit-${scope.sha}`;
  const cacheKey = `${repoPath}:${head}:${scopeKey}${file ? `:${file}` : ""}`;
  return { patch, cacheKey };
}

export async function gitFileContents(
  repoPath: string,
  file: string,
  rev: "HEAD" | "INDEX" | "WORKING"
): Promise<string> {
  if (rev === "WORKING") {
    try {
      if (isRemote(repoPath)) return await readRemoteFile(repoPath, file);
      return await fs.readFile(path.join(repoPath, file), "utf8");
    } catch {
      return "";
    }
  }
  const spec = rev === "HEAD" ? "HEAD" : ":0";
  try {
    return await rawGit(repoPath, ["show", `${spec}:${file}`]);
  } catch {
    return "";
  }
}

// ── stage / discard / commit / push ────────────────────────────────────

export async function gitStage(repoPath: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  // Remote has no simple-git; route through rawGit (which is remote-aware).
  if (isRemote(repoPath)) { await rawGit(repoPath, ["add", "--", ...files]); return; }
  await repo(repoPath).add(files);
}
export async function gitUnstage(repoPath: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  if (isRemote(repoPath)) { await rawGit(repoPath, ["reset", "HEAD", "--", ...files]); return; }
  await repo(repoPath).reset(["HEAD", "--", ...files]);
}
export async function gitDiscard(repoPath: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  // Classify each path: a TRACKED file is RESTORED to HEAD; an UNTRACKED file is
  // REMOVED. The old code ran one batch `checkout`, swallowed its error, then
  // `fs.rm`'d EVERY file — so a tracked file batched with an untracked one (the
  // batch checkout errors on the untracked path, was swallowed) got DELETED
  // instead of restored: "discard my edits" became data loss. Separate them.
  const tracked: string[] = [];
  const untracked: string[] = [];
  for (const f of files) {
    // `git ls-files --error-unmatch` exits non-zero for an untracked path.
    const isTracked = await rawGit(repoPath, ["ls-files", "--error-unmatch", "--", f])
      .then(() => true)
      .catch(() => false);
    (isTracked ? tracked : untracked).push(f);
  }
  if (tracked.length > 0) {
    // Restore tracked files; let a real failure (e.g. index.lock) propagate
    // instead of swallowing it and then rm'ing the file.
    if (isRemote(repoPath)) await rawGit(repoPath, ["checkout", "--", ...tracked]);
    else await repo(repoPath).checkout(["--", ...tracked]);
  }
  if (untracked.length > 0 && isRemote(repoPath)) {
    // Remote untracked removal via `git clean -f` (no local fs access).
    await rawGit(repoPath, ["clean", "-f", "--", ...untracked]);
    return;
  }
  for (const f of untracked) {
    await fs.rm(path.join(repoPath, f), { force: true, recursive: true }).catch(() => {
      /* best-effort: untracked file may already be gone */
    });
  }
}
export async function gitCommit(
  repoPath: string,
  message: string,
  allowEmpty = false
): Promise<{ sha: string }> {
  const args = ["commit", "-m", message];
  if (allowEmpty) args.push("--allow-empty");
  await rawGit(repoPath, args);
  const sha = (await rawGit(repoPath, ["rev-parse", "HEAD"])).trim();
  return { sha };
}
export async function gitPush(repoPath: string, setUpstream = false): Promise<void> {
  const args = ["push"];
  if (setUpstream) {
    const branch = (await rawGit(repoPath, ["branch", "--show-current"])).trim();
    args.push("-u", "origin", branch);
  }
  await rawGit(repoPath, args);
}

// ── conflict helpers ───────────────────────────────────────────────────

const CONFLICT_RE = /^<{7} /m;

export async function gitConflictedFile(
  repoPath: string,
  file: string
): Promise<{ raw: string; conflicts: number }> {
  const raw = isRemote(repoPath)
    ? await readRemoteFile(repoPath, file)
    : await fs.readFile(path.join(repoPath, file), "utf8");
  const conflicts = raw.split("\n").filter((l) => CONFLICT_RE.test(l + "\n")).length;
  return { raw, conflicts };
}

export async function gitWriteResolved(
  repoPath: string,
  file: string,
  contents: string
): Promise<void> {
  if (isRemote(repoPath)) { await writeRemoteFile(repoPath, file, contents); return; }
  await fs.writeFile(path.join(repoPath, file), contents, "utf8");
}

// ── worktree adapter ───────────────────────────────────────────────────

export async function worktreeList(repoPath: string): Promise<WorktreeEntry[]> {
  const raw = await rawGit(repoPath, ["worktree", "list", "--porcelain"]);
  const out: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};
  for (const line of raw.split("\n")) {
    if (!line) {
      if (current.path) {
        out.push({
          path: current.path,
          branch: current.branch ?? null,
          head: current.head ?? "",
          locked: current.locked ?? false,
          prunable: current.prunable ?? false,
          bare: current.bare ?? false,
        });
        current = {};
      }
      continue;
    }
    if (line.startsWith("worktree ")) current.path = line.slice(9);
    else if (line.startsWith("HEAD ")) current.head = line.slice(5);
    else if (line.startsWith("branch ")) current.branch = line.slice(7).replace("refs/heads/", "");
    else if (line === "detached") current.branch = null;
    else if (line === "bare") current.bare = true;
    else if (line.startsWith("locked")) current.locked = true;
    else if (line.startsWith("prunable")) current.prunable = true;
  }
  if (current.path) {
    out.push({
      path: current.path,
      branch: current.branch ?? null,
      head: current.head ?? "",
      locked: current.locked ?? false,
      prunable: current.prunable ?? false,
      bare: current.bare ?? false,
    });
  }
  return out;
}

const WORKTREE_INCLUDE_FILE = ".worktreeinclude";

export async function worktreeCreate(
  repoPath: string,
  opts: WorktreeCreateOpts
): Promise<{ path: string; branch: string }> {
  // Validate renderer-supplied args — they reach `git` as positionals/values.
  // A bad branch name can't shell-inject (spawn is execFile-style) but CAN be a
  // git ARG injection, and an absolute/`..` path or a leading-dash sparse entry
  // escapes the repo / is read as a flag. Reject all of those.
  if (
    !opts.branch ||
    !/^[A-Za-z0-9._/-]+$/.test(opts.branch) ||
    opts.branch.startsWith("-") ||
    opts.branch.includes("..")
  ) {
    throw new Error(`invalid branch name: ${JSON.stringify(opts.branch)}`);
  }
  if (opts.path !== undefined && (path.isAbsolute(opts.path) || opts.path.split(/[/\\]/).includes(".."))) {
    throw new Error("worktree path must be relative to the repo and contain no '..'");
  }
  const assertSafeList = (xs: string[] | undefined, label: string) => {
    for (const x of xs ?? []) {
      if (x.startsWith("-") || path.isAbsolute(x) || x.split(/[/\\]/).includes("..")) {
        throw new Error(`invalid ${label} entry: ${JSON.stringify(x)}`);
      }
    }
  };
  assertSafeList(opts.sparse, "sparse");
  assertSafeList(opts.includeFiles, "includeFiles");

  // Submodule guard — git worktree does NOT support submodules.
  try {
    const sm = await fs.readFile(path.join(repoPath, ".gitmodules"), "utf8");
    if (sm.trim().length > 0) {
      throw new Error("repo has submodules; git worktree does not support superprojects with submodules");
    }
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") throw e;
  }

  // Default location: ../<repo-name>-worktrees/<branch-slug>
  const repoName = path.basename(repoPath);
  const wtDir = opts.path
    ? path.resolve(repoPath, opts.path)
    : path.join(path.dirname(repoPath), `${repoName}-worktrees`, slugify(opts.branch));

  // Branch exclusivity: refuse if branch is already checked out in another worktree.
  const existing = await worktreeList(repoPath);
  for (const wt of existing) {
    if (wt.branch === opts.branch) {
      throw new Error(`branch ${opts.branch} is already checked out at ${wt.path}`);
    }
  }

  // Ensure branch ref exists; create if missing.
  const branches = await rawGit(repoPath, ["branch", "--list", opts.branch]);
  const branchExists = branches.split("\n").some((l) => l.trim().replace(/^\* /, "") === opts.branch);
  const args = ["worktree", "add"];
  if (opts.partial !== false) args.push("--no-checkout");
  if (!branchExists) args.push("-b", opts.branch);
  args.push(wtDir);
  if (branchExists) args.push(opts.branch);
  await rawGit(repoPath, args);

  // Apply sparse-checkout cone + partial-clone post-fetch if requested.
  if (opts.sparse && opts.sparse.length > 0) {
    await rawGit(wtDir, ["sparse-checkout", "init", "--cone"]);
    await rawGit(wtDir, ["sparse-checkout", "set", ...opts.sparse]);
  }
  if (opts.partial !== false) {
    // Convert to partial clone by fetching with blob:none filter.
    await rawGit(wtDir, ["fetch", "--filter=blob:none", "origin"]).catch(() => {
      /* may not have origin */
    });
    await rawGit(wtDir, ["checkout"]);
  }

  // Copy .worktreeinclude files (e.g. .env) from main worktree.
  const includes = opts.includeFiles ?? (await readWorktreeIncludes(repoPath));
  for (const rel of includes) {
    const src = path.join(repoPath, rel);
    const dst = path.join(wtDir, rel);
    try {
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.copyFile(src, dst);
    } catch {
      /* source may not exist; skip silently */
    }
  }

  return { path: wtDir, branch: opts.branch };
}

async function readWorktreeIncludes(repoPath: string): Promise<string[]> {
  try {
    const text = await fs.readFile(path.join(repoPath, WORKTREE_INCLUDE_FILE), "utf8");
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
  } catch {
    return [];
  }
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

export async function worktreeRemove(
  repoPath: string,
  worktreePath: string,
  force = false
): Promise<void> {
  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push(worktreePath);
  await rawGit(repoPath, args);
}

export async function worktreePrune(repoPath: string): Promise<{ removed: string[] }> {
  // First list to know what's prunable, then prune.
  const before = await worktreeList(repoPath);
  await rawGit(repoPath, ["worktree", "prune"]);
  const after = await worktreeList(repoPath);
  const afterSet = new Set(after.map((w) => w.path));
  const removed = before.filter((w) => !afterSet.has(w.path)).map((w) => w.path);
  return { removed };
}
