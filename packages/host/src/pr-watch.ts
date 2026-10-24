/**
 * The PR watcher (design jira-sync §11.4): every 3 minutes, one `gh api graphql` call reads every
 * open or draft PR of the issues of the workspaces this host follows (those `IssueWatch` watches);
 * a merged PR moves its issue by `local.onPrMerged` and offers the cleanup `config.yaml` asks for,
 * a PR closed unmerged moves it by `local.onPrClosed` with a note and a notification, and changes
 * requested or failing checks are badges on the issue's `pr` only.
 *
 * It costs nothing while no followed issue has an open PR: no timer runs. Which issues have one is
 * learnt from one listing of a workspace when it starts being followed, then kept from
 * `issue.changed` (one file read for a change that touched `pr`, none for any other). A pass is one
 * `gh` process per GitHub host, the issues it changed read and written, nothing else.
 * Electron-free: the app and `hive host` each run one.
 */
import path from "node:path";
import { applyPrStates, cleanupWork, fetchPrStates, followsPr, type PrChange } from "@hivemind/core/pr";
import { commentOnIssue, listIssues, readConfig, readIssue } from "@hivemind/core/storage";
import type { PrRef } from "@hivemind/core/types";
import type { IssueChange } from "@hivemind/workspace-api/methods";
import { Repeating } from "./scheduler.js";

export const PR_WATCH_MS = 3 * 60_000;
/** A workspace followed with open PRs already is read this soon: what merged while the app was shut. */
const FIRST_PASS_MS = 10_000;

export interface PrWatchOptions {
  /** Tell the person (an OS notification in the app); `hive host` has none and passes nothing. */
  notify?(title: string, body: string): void;
  log?(message: string): void;
}

interface Followed {
  count: number;
  /** The issues with an open or draft PR, by id. */
  open: Map<string, PrRef>;
}

export class PrWatch {
  private readonly roots = new Map<string, Followed>();
  private readonly beat: Repeating;
  private lastError = "";

  constructor(private readonly o: PrWatchOptions = {}) {
    this.beat = new Repeating(() => this.pass(), PR_WATCH_MS, (e) => this.failed(e));
  }

  /** True while a pass is scheduled: some followed issue has an open PR. */
  get running(): boolean {
    return this.beat.started;
  }

  /** The workspace whose `.hivemind` is `root` is followed until `until` aborts. */
  follow(root: string, until: AbortSignal): void {
    if (until.aborted) return;
    let f = this.roots.get(root);
    if (!f) {
      f = { count: 0, open: new Map() };
      this.roots.set(root, f);
      const mine = f;
      void listIssues(root).then(
        (all) => {
          if (this.roots.get(root) !== mine) return;
          for (const i of all) if (followsPr(i)) mine.open.set(i.id, i.pr!);
          this.reconsider(FIRST_PASS_MS);
        },
        () => {},
      );
    }
    f.count++;
    const e = f;
    until.addEventListener("abort", () => {
      if (--e.count > 0 || this.roots.get(root) !== e) return;
      this.roots.delete(root);
      this.reconsider();
    }, { once: true });
  }

  /** An issue of a followed workspace changed (`issue.changed`). */
  changed(change: IssueChange): void {
    const f = this.roots.get(change.root);
    if (!f) return;
    if (change.change === "deleted") {
      if (f.open.delete(change.id)) this.reconsider();
      return;
    }
    if (change.change !== "created" && !change.fields.includes("pr")) return;
    void readIssue(change.root, change.id).then(
      (issue) => {
        if (followsPr(issue)) f.open.set(issue.id, issue.pr!);
        else f.open.delete(issue.id);
        this.reconsider();
      },
      () => {},
    );
  }

  /** Start the beat when an open PR is followed, stop it when none is. */
  private reconsider(firstMs = PR_WATCH_MS): void {
    const any = [...this.roots.values()].some((f) => f.open.size > 0);
    if (any) this.beat.start(firstMs);
    else this.beat.stop();
  }

  /** One pass over every followed open PR now (what the beat runs). */
  async pass(): Promise<PrChange[]> {
    const roots = [...this.roots.entries()].filter(([, f]) => f.open.size > 0);
    if (!roots.length) return [];
    const seen = await fetchPrStates(roots.flatMap(([, f]) => [...f.open.values()]), path.dirname(roots[0]![0]));
    this.lastError = "";
    const all: PrChange[] = [];
    for (const [root, f] of roots) {
      const changes = await applyPrStates(root, [...f.open.keys()].map((id) => ({ id })), seen);
      for (const c of changes) {
        if (followsPr(c)) f.open.set(c.id, c.pr);
        else f.open.delete(c.id);
        await this.after(root, c).catch((e) => this.o.log?.(`[pr-watch] ${c.id}: ${(e as Error).message}`));
      }
      all.push(...changes);
    }
    this.reconsider();
    return all;
  }

  /** What follows a merge or a close beside the move: the cleanup asked for, the person told. */
  private async after(root: string, c: PrChange): Promise<void> {
    const name = `${c.pr.repo}#${c.pr.number}`;
    if (c.event === "closed") {
      this.o.notify?.(`${c.id}: PR closed without merging`, `${name} was closed; ${c.id} moved to ${c.movedTo ?? "in progress"}.`);
      return;
    }
    if (c.event !== "merged") return;
    const cleanup = (await readConfig(root)).cleanup ?? "ask";
    if (cleanup === "auto") {
      await cleanupWork(root, c.id, "hive");
    } else if (cleanup === "ask") {
      await commentOnIssue(root, c.id, `PR ${name} merged: remove its worktree and local branch with \`hive pr cleanup ${c.id}\``, "hive");
      this.o.notify?.(`${c.id}: PR merged`, `${name} merged. Remove its worktree with \`hive pr cleanup ${c.id}\`.`);
    }
  }

  private failed(e: unknown): void {
    const msg = (e as Error)?.message ?? String(e);
    if (msg !== this.lastError) this.o.log?.(`[pr-watch] ${msg}`);
    this.lastError = msg;
  }

  close(): void {
    this.beat.stop();
    this.roots.clear();
  }
}
