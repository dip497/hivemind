/**
 * The renderer's protocol 1.3 services: one event hub fed by the status bus and main's hook
 * pushes, the activity and presence stores main updates, and the LinkServices a community view's
 * host link reads. Started once; it runs whatever view is active.
 */
import type { ActivityLevel, ShareOutcome, ViewPresence } from "@hivemind/view-sdk/protocol";
import { subscribeStatus } from "../agent-status-bus";
import { AGENT_TILE_KIND } from "../tile-kinds";
import { ViewEventHub } from "./view-events";
import type { LinkServices } from "./views/community/host-link";

export const viewEvents = new ViewEventHub({
  ledger: (lines) => window.hive.viewLedgerAppend(lines),
  isAgentKind: (k) => k === AGENT_TILE_KIND,
});

class ActivityStore {
  private levels = new Map<string, ActivityLevel>();
  private subs = new Set<(c: Record<string, ActivityLevel>) => void>();
  private owners = new Map<object, string[]>();
  private queued = false;
  private lastKey = "";

  level(id: string): ActivityLevel { return this.levels.get(id) ?? 0; }

  subscribe(cb: (c: Record<string, ActivityLevel>) => void): () => void {
    this.subs.add(cb);
    return () => { this.subs.delete(cb); };
  }

  watch(owner: object, ids: string[]): void {
    if (ids.length) this.owners.set(owner, ids); else this.owners.delete(owner);
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      const all = new Set([...this.owners.values()].flat());
      // main restarts a re-watched tile from quiet, so a stale level must not linger here
      for (const id of this.levels.keys()) if (!all.has(id)) this.levels.delete(id);
      const ids = [...all].sort();
      const key = ids.join("\n");
      if (key === this.lastKey) return;
      this.lastKey = key;
      window.hive.ptyActivityWatch(ids);
    });
  }

  apply(changed: Record<string, ActivityLevel>): void {
    for (const [id, l] of Object.entries(changed)) this.levels.set(id, l);
    for (const cb of this.subs) cb(changed);
  }
}

class PresenceStore {
  private cur: ViewPresence | null = null;
  private subs = new Set<(p: ViewPresence) => void>();

  set(p: ViewPresence): void {
    this.cur = p;
    for (const cb of this.subs) cb(p);
  }

  subscribe(cb: (p: ViewPresence) => void): () => void {
    this.subs.add(cb);
    if (this.cur) cb(this.cur);
    return () => { this.subs.delete(cb); };
  }
}

export const viewActivity = new ActivityStore();
export const viewPresence = new PresenceStore();

let started = false;
export function startViewHost(): void {
  if (started) return;
  started = true;
  subscribeStatus((e) => viewEvents.onStatus(e));
  window.hive.onHcpTurn(({ tileId }) => viewEvents.onHookTurn(tileId));
  window.hive.onHcpSubagent((e) => viewEvents.onSubagents(e.tileId, e.active ?? (e.busy ? 1 : 0)));
  window.hive.viewLedgerSnapshot().then((s) => viewEvents.seed(s), () => {});
  window.addEventListener("beforeunload", () => viewEvents.flushLedger());
  window.hive.onPtyActivity((levels) => viewActivity.apply(levels));
  window.hive.onPresence((p) => viewPresence.set(p));
  window.hive.presenceNow().then((p) => viewPresence.set(p), () => {});
}

/** What a community view's host link may read. `share` shows the host's confirm. */
export function viewLinkServices(opts: { layoutKey: () => string | null; share: (png: ArrayBuffer, suggestedName?: string) => Promise<ShareOutcome> }): LinkServices {
  return {
    sinceOf: (id) => { const s = viewEvents.sinceOf(id); return s ? { since: s.since, exact: s.exact } : undefined; },
    events: { subscribe: (l) => viewEvents.subscribe(l), replay: (since, accept, viewId) => viewEvents.replay(since, accept, viewId) },
    activity: viewActivity,
    presence: viewPresence,
    history: async (day) => {
      const key = opts.layoutKey();
      if (!key) throw new Error("this workspace keeps no history");
      return window.hive.viewHistory(key, day);
    },
    share: opts.share,
  };
}
