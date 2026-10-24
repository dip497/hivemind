/**
 * Every write to a workspace's issues, told as `issue.changed` (design jira-sync §12.1): from the
 * app's window, a peer, an agent's `hive` or the person's own, which all end as a file under
 * `.hivemind/issues` or `.hivemind/mirror`. The CLI writes those files itself, so the event comes
 * from watching them, not from the host's issue calls.
 *
 * A workspace is watched while something follows it (a window that shows it, a service or guest
 * connected to it), once however many do. Each file is parsed when it changes and compared with
 * the copy kept of it, which is read again only when its mtime or size moved: an event costs one
 * file's read, never the folder's. `.hivemind/sync/` (a sync's own bookkeeping) is never watched.
 * Electron-free: the app and `hive host` each run one.
 */
import fs from "node:fs";
import path from "node:path";
import { parseIssueFile } from "@hivemind/core/storage";
import type { Issue } from "@hivemind/core/types";
import type { IssueChange } from "@hivemind/workspace-api/methods";

/** The folders under `.hivemind` that hold issue files. */
const WATCHED = ["issues", "mirror"] as const;
/** A write is told once it has been still this long. */
const SETTLE_MS = 150;

interface Kept {
  mtimeMs: number;
  size: number;
  issue: Issue;
}

/** The fields that differ between two copies of an issue: its frontmatter's keys, and its body's
 *  sections by name. */
export function changedFields(before: Issue | null, after: Issue): string[] {
  const flat = (i: Issue | null): Record<string, unknown> => {
    if (!i) return {};
    // How a section's lines were laid out is the file's, not a field: it moves with every row.
    const { path: _p, raw: _r, sections: { acceptanceLayout: _a, activityLayout: _l, ...sections }, ...front } = i;
    return { ...front, ...sections };
  };
  const a = flat(before);
  const b = flat(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

/** One `.hivemind` folder, watched. */
class Watched {
  private readonly kept = new Map<string, Kept>();
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private top: fs.FSWatcher | null = null;
  private readonly pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Until the first reading of every file is done, changes wait. */
  private ready: Promise<void>;
  private closed = false;

  constructor(readonly root: string, private readonly told: (change: IssueChange) => void) {
    this.ready = this.start();
  }

  private async start(): Promise<void> {
    try {
      // The folder itself, for an `issues/` or `mirror/` made after: a sync's first mirror.
      this.top = fs.watch(this.root, (_e, name) => { if (name && (WATCHED as readonly string[]).includes(String(name))) this.watchTree(path.join(this.root, String(name)), true); });
      this.top.on("error", () => {});
    } catch {
      return; // no .hivemind: nothing to watch until it is set up and followed again
    }
    for (const sub of WATCHED) this.watchTree(path.join(this.root, sub), false);
    for (const sub of WATCHED) await this.readAll(path.join(this.root, sub));
  }

  /**
   * Watch `dir` and every folder under it, each with a watcher of its own. Not `recursive`: on
   * Linux, Node's recursive watch also watches each file by its inode, so a file replaced by an
   * atomic write (ingest's temp file + rename) keeps the old inode's watch, and every later write to
   * it went untold. A folder's own watch tells of any change to the files in it, whatever their
   * inode. A folder made later is watched when its parent tells of it; one removed lets go.
   * `made`: it was made after the start, so what it holds already is new.
   */
  private watchTree(dir: string, made: boolean): void {
    if (this.closed || this.watchers.has(dir)) return;
    try {
      const w = fs.watch(dir, (_e, name) => {
        if (!name) return;
        const at = path.join(dir, String(name));
        if (!String(name).endsWith(".md")) {
          void fs.promises.stat(at).then((st) => { if (st.isDirectory()) this.watchTree(at, true); }, () => this.unwatch(at));
        }
        this.changed(at);
      });
      w.on("error", () => this.unwatch(dir));
      this.watchers.set(dir, w);
    } catch {
      return; // not there yet, or gone again
    }
    let subs: string[] = [];
    try {
      subs = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name));
    } catch { /* gone again */ }
    for (const sub of subs) this.watchTree(sub, made);
    if (made) void this.ready.then(() => this.readAll(dir, true));
  }

  /** Let go of the watchers of `dir` and every folder under it: it is gone. */
  private unwatch(dir: string): void {
    for (const [d, w] of this.watchers) {
      if (d === dir || d.startsWith(dir + path.sep)) {
        w.close();
        this.watchers.delete(d);
      }
    }
  }

  /** Keep a copy of every issue under `dir`; `tell`: each one not kept yet is told as made. */
  private async readAll(dir: string, tell = false): Promise<void> {
    let names: string[];
    try {
      names = (await fs.promises.readdir(dir, { recursive: true })).map(String);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      const file = path.join(dir, name);
      if (tell) this.changed(file);
      else await this.read(file);
    }
  }

  private changed(file: string): void {
    if (this.closed) return;
    this.pending.add(file);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), SETTLE_MS);
  }

  private async flush(): Promise<void> {
    this.timer = null;
    await this.ready;
    const files = [...this.pending];
    this.pending.clear();
    for (const file of files) {
      if (this.closed) return;
      // A folder gone (a parent issue's, or a whole mirror) takes its files with it.
      const under = [...this.kept.keys()].filter((k) => k === file || k.startsWith(file + path.sep));
      if (!file.endsWith(".md")) {
        for (const k of under) if (!fs.existsSync(k)) this.gone(k);
        continue;
      }
      const before = this.kept.get(file) ?? null;
      const now = await this.read(file);
      if (now === "gone") {
        if (before) this.gone(file);
        continue;
      }
      if (now === "same" || now === "unreadable") continue;
      const fields = changedFields(before?.issue ?? null, now);
      if (before && fields.length === 0) continue;
      this.told({ id: now.id, root: this.root, change: before ? "updated" : "created", fields, by: now.sections.activity.at(-1)?.who ?? null });
    }
  }

  private gone(file: string): void {
    const was = this.kept.get(file);
    this.kept.delete(file);
    if (was) this.told({ id: was.issue.id, root: this.root, change: "deleted", fields: [], by: null });
  }

  /** The issue in `file` as it is now, kept: "same" when its mtime and size did not move, and
   *  "unreadable" when it is half written or not an issue (the copy kept stays). */
  private async read(file: string): Promise<Issue | "same" | "gone" | "unreadable"> {
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(file);
    } catch {
      return "gone";
    }
    if (!st.isFile()) return "unreadable";
    const kept = this.kept.get(file);
    if (kept && kept.mtimeMs === st.mtimeMs && kept.size === st.size) return "same";
    let issue: Issue;
    try {
      issue = parseIssueFile(file, await fs.promises.readFile(file, "utf8"));
    } catch {
      return "unreadable";
    }
    this.kept.set(file, { mtimeMs: st.mtimeMs, size: st.size, issue });
    return issue;
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.top?.close();
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    this.kept.clear();
    this.pending.clear();
  }
}

export interface IssueWatchOptions {
  /** Tell every client `issue.changed` for the workspace at `repo`. */
  publish(repo: string, change: IssueChange): void;
  /** Also told, once per change, and of each `.hivemind` folder while it is watched (`until`
   *  aborts when it stops): what follows issues beside the clients (the PR watcher). */
  watching?: { follow(root: string, until: AbortSignal): void; changed(change: IssueChange): void };
}

export class IssueWatch {
  private readonly watched = new Map<string, { watch: Watched; repos: Map<string, number>; stop: AbortController }>();

  constructor(private readonly o: IssueWatchOptions) {}

  /** The workspace at `repo`, whose issues are in `root` (its `.hivemind`, or a parent's), is
   *  followed until `until` aborts. */
  follow(repo: string, root: string, until: AbortSignal): void {
    if (until.aborted) return;
    let entry = this.watched.get(root);
    if (!entry) {
      const repos = new Map<string, number>();
      const watch = new Watched(root, (change) => {
        this.o.watching?.changed(change);
        for (const r of repos.keys()) this.o.publish(r, change);
      });
      const stop = new AbortController();
      this.watched.set(root, (entry = { watch, repos, stop }));
      this.o.watching?.follow(root, stop.signal);
    }
    entry.repos.set(repo, (entry.repos.get(repo) ?? 0) + 1);
    const e = entry;
    until.addEventListener("abort", () => {
      const n = (e.repos.get(repo) ?? 1) - 1;
      if (n > 0) e.repos.set(repo, n);
      else e.repos.delete(repo);
      if (e.repos.size === 0 && this.watched.get(root) === e) {
        e.watch.close();
        e.stop.abort();
        this.watched.delete(root);
      }
    }, { once: true });
  }

  close(): void {
    for (const { watch, stop } of this.watched.values()) {
      watch.close();
      stop.abort();
    }
    this.watched.clear();
  }
}
