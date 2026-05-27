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
  const raw = await rawGit(repoPath, [
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

  // Detect merge/rebase by checking .git filesystem markers.
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

export async function gitListFiles(repoPath: string): Promise<string[]> {
  // tracked + untracked, respecting .gitignore. Deduped, sorted, NUL-safe.
  const raw = await rawGit(repoPath, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  const seen = new Set<string>();
  for (const p of raw.split("\0")) {
    if (p) seen.add(p);
  }
  return Array.from(seen).sort();
}

export async function gitDiff(
  repoPath: string,
  scope: DiffScope,
  file?: string
): Promise<DiffPayload> {
  const args = ["diff", "--no-color", "--no-ext-diff"];
  if (scope.kind === "working") {
    if (scope.staged) args.push("--staged");
    else args.push("HEAD");
  } else if (scope.kind === "branch") {
    const base = scope.base ?? "origin/main";
    args.push(`${base}...HEAD`);
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
        ? `branch-${scope.base ?? "origin/main"}`
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
  await repo(repoPath).add(files);
}
export async function gitUnstage(repoPath: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  await repo(repoPath).reset(["HEAD", "--", ...files]);
}
export async function gitDiscard(repoPath: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  // Restore working tree to HEAD for tracked files; remove untracked files.
  await repo(repoPath).checkout(["--", ...files]).catch(() => {
    /* untracked files; fall through */
  });
  for (const f of files) {
    try {
      await fs.rm(path.join(repoPath, f), { force: true });
    } catch {
      /* may have been resolved by checkout already */
    }
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
  const raw = await fs.readFile(path.join(repoPath, file), "utf8");
  const conflicts = raw.split("\n").filter((l) => CONFLICT_RE.test(l + "\n")).length;
  return { raw, conflicts };
}

export async function gitWriteResolved(
  repoPath: string,
  file: string,
  contents: string
): Promise<void> {
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
