/**
 * chokidar watcher per repo. Coalesces filesystem events and sends each client watching the repo
 * one `file.changed` event of the workspace API at a time, so the renderer can invalidate TanStack
 * Query keys without flooding. A client watches until its connection closes. Electron-free.
 */
import chokidar, { type FSWatcher } from "chokidar";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { emit, type Connection } from "@hivemind/workspace-api/server";

/** What git ignores in `repoPath` (build output, venvs, caches), as repo-relative paths;
 *  an ignored directory is one entry. Null when git cannot say (not a repo). */
function gitIgnored(repoPath: string): Promise<Set<string> | null> {
  return new Promise((resolve) => {
    execFile("git", ["-C", repoPath, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
      { timeout: 10_000, maxBuffer: 32 << 20 }, (err, out) => {
        if (err) return resolve(null);
        resolve(new Set(out.split("\0").filter(Boolean).map((e) => e.replace(/\/$/, ""))));
      });
  });
}

/** True when `p`, or a folder above it inside the repo, is in `ignored`. */
export function underIgnored(repoPath: string, p: string, ignored: Set<string>): boolean {
  let rel = path.relative(repoPath, p);
  while (rel && !rel.startsWith("..")) {
    if (ignored.has(rel)) return true;
    const up = path.dirname(rel);
    rel = up === "." ? "" : up;
  }
  return false;
}

interface Active {
  watcher: FSWatcher;
  clients: Set<Connection>;
  flush: NodeJS.Timeout | null;
  pending: Set<string>;
}

const active = new Map<string, Active>();

/** `client` is sent the changes in `repoPath` until its connection closes. */
export function watchRepo(repoPath: string, client: Connection): void {
  if (client.closed.aborted) return;
  let entry = active.get(repoPath);
  if (entry) {
    if (!entry.clients.has(client)) {
      entry.clients.add(client);
      client.closed.addEventListener("abort", () => unwatch(repoPath, client), { once: true });
    }
    return;
  }
  // The tree itself is added once git has said what it ignores: a Rust `target/` or a
  // venv is tens of thousands of files, each an lstat at startup and an inotify watch.
  // Until then only these are watched, and only those that exist: chokidar (4.0.3) watches a
  // missing path through its parent, and a repo whose `.hivemind` was missing then never had its
  // tree watched when it was added. The tree covers the rest once added.
  let ignoredByGit: Set<string> | null = null;
  const watcher = chokidar.watch(
    [
      path.join(repoPath, ".git", "HEAD"),
      path.join(repoPath, ".git", "index"),
      path.join(repoPath, ".git", "MERGE_HEAD"),
      path.join(repoPath, ".git", "ORIG_HEAD"),
      path.join(repoPath, ".hivemind"),
    ].filter((p) => existsSync(p)),
    {
      ignored: (p: string) => {
        // .hivemind/ may be gitignored, but issue changes arrive through it.
        if (ignoredByGit && !p.includes("/.hivemind") && !p.includes("/.git/") && underIgnored(repoPath, p, ignoredByGit)) return true;
        // Inside .git/ keep only the four HEAD-ish files above; everything
        // else (objects, logs, hooks, lfs) is huge and irrelevant.
        if (p.includes("/.git/") && !/\/\.git\/(HEAD|index|MERGE_HEAD|ORIG_HEAD)$/.test(p)) return true;
        return (
          p.includes("/node_modules/") ||
          p.includes("/dist/") ||
          p.includes("/out/") ||
          p.includes("/.next/") ||
          p.includes("/.turbo/") ||
          p.includes("/.cache/") ||
          // Common dotfile-hell folders at $HOME we never want to watch.
          /\/(\.wine|\.cargo|\.rustup|\.nvm|\.npm|\.local|\.config|\.mozilla|\.steam|\.cache|\.gradle|\.m2|\.jdks|\.docker|\.rig|\.claude|\.codex|\.codeium|\.gemini)\//.test(p)
        );
      },
      followSymlinks: false,
      depth: 4,
      ignoreInitial: true,
      persistent: true,
      // ignorePermissionErrors suppresses EACCES/EPERM at the source so
      // chokidar doesn't even try to open files we can't read (.wine,
      // /proc, root-owned dotfiles in $HOME). Without it, even with our
      // `ignored` regex, chokidar stats the path BEFORE applying ignores
      // and throws — chokidar GH #1378 confirms `add` errors bubble as
      // unhandled rejections the `error` event listener can't catch.
      ignorePermissionErrors: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    }
  );
  // Without this, chokidar's underlying fs.watch throws unhandled promise
  // rejections on EACCES (permission denied) and ELOOP (symlink farms) —
  // the renderer doesn't crash but the rejections flood the main process
  // and the EventEmitter chain stalls. Swallow them.
  watcher.on("error", (err) => {
    const msg = (err as NodeJS.ErrnoException).message ?? String(err);
    if (!/EACCES|ELOOP|EPERM|ENOENT/.test(msg)) {
      console.warn("[fs-watcher]", msg);
    }
  });
  entry = {
    watcher,
    clients: new Set([client]),
    flush: null,
    pending: new Set(),
  };
  active.set(repoPath, entry);
  client.closed.addEventListener("abort", () => unwatch(repoPath, client), { once: true });

  const trigger = (p: string) => {
    entry!.pending.add(p);
    if (entry!.flush) clearTimeout(entry!.flush);
    entry!.flush = setTimeout(() => {
      const paths = Array.from(entry!.pending);
      entry!.pending.clear();
      entry!.flush = null;
      for (const client of entry!.clients) emit(client, "file.changed", repoPath, { paths });
    }, 300);
  };
  watcher.on("add", trigger).on("change", trigger).on("unlink", trigger);
  void gitIgnored(repoPath).then((ignored) => {
    if (active.get(repoPath) !== entry) return; // unwatched while git was answering
    ignoredByGit = ignored;
    watcher.add(repoPath);
  });
}

function unwatch(repoPath: string, client: Connection): void {
  const entry = active.get(repoPath);
  if (!entry) return;
  entry.clients.delete(client);
  if (entry.clients.size === 0) {
    // chokidar v3+ .close() returns a Promise that can reject with the same
    // EACCES/ELOOP/ENOENT errors that plague .add() (see chokidar #1378).
    // Catch them — by this point the entry is already removed from `active`,
    // so a failed close just leaks an underlying fs.watch handle that the OS
    // will reap on process exit anyway.
    Promise.resolve(entry.watcher.close()).catch(() => {/* best-effort */});
    if (entry.flush) clearTimeout(entry.flush);
    entry.pending.clear();
    active.delete(repoPath);
  }
}

/** Test/diagnostic helper — returns the set of repo paths currently watched. */
export function _activeRepos(): string[] {
  return Array.from(active.keys());
}
