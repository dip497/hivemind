/**
 * The renderer's protocol 1.3 services: one event hub fed by the status bus and the host's
 * session statuses, the activity and presence stores main updates, and the LinkServices a community view's
 * host link reads. Started once; it runs whatever view is active.
 */
import type { ActivityLevel, ShareOutcome, TurnOutcome, ViewAgent, ViewParticipant, ViewPresence } from "@hivemind/view-sdk/protocol";
import type { Participant } from "@hivemind/workspace-host/presence";
import { canListSessions, defaultAgent, spawnableAgents, agentById as catalogAgentById } from "@hivemind/agents";
import type { LinkServices } from "@hivemind/view-host/link";
import { viewAgentStatus } from "@hivemind/view-host/status";
import { subscribeHostedStatus, subscribeStatus } from "../agent-status-bus";
import { agentMissing } from "../agent-plugins";
import { AGENT_TILE_KIND } from "../tile-kinds";
import { watchPeopleHere } from "../multiplayer/presence";
import { colorOf } from "../multiplayer/people";
import { ViewEventHub } from "./view-events";
import type { HcpStatusEvent } from "../../../shared/ipc";

const TURN_ENDS = new Set(["done", "failed", "interrupted", "limited"]);

/** What a session's status change means for views: a turn its hooks ended, a new subagent count. */
export function feedHostedStatus(hub: Pick<ViewEventHub, "onHookTurn" | "onSubagents">, last: Map<string, { state: string; subagents: number }>, e: HcpStatusEvent): void {
  const prev = last.get(e.tileId);
  const { state, subagents, source } = e.status;
  last.set(e.tileId, { state, subagents: subagents.length });
  if (source === "hooks" && TURN_ENDS.has(state) && prev && !TURN_ENDS.has(prev.state)) hub.onHookTurn(e.tileId, state as TurnOutcome);
  if ((prev?.subagents ?? 0) !== subagents.length) hub.onSubagents(e.tileId, subagents.length);
}

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
  const hosted = new Map<string, { state: string; subagents: number }>();
  window.hive.onHcpStatus((e) => feedHostedStatus(viewEvents, hosted, e));
  window.hive.viewLedgerSnapshot().then((s) => viewEvents.seed(s), () => {});
  window.addEventListener("beforeunload", () => viewEvents.flushLedger());
  window.hive.onPtyActivity((levels) => viewActivity.apply(levels));
  window.hive.onPresence((p) => viewPresence.set(p));
  window.hive.presenceNow().then((p) => viewPresence.set(p), () => {});
}

/** The agents a view may start: installed, enabled, and what each supports. */
export function viewAgents(): ViewAgent[] {
  const dflt = defaultAgent()?.id;
  return spawnableAgents().filter((d) => !agentMissing(d.id)).map((d) => ({
    id: d.id, label: d.label, default: d.id === dflt, turns: d.caps.turnSignal, resumes: !!d.session?.resume, sessions: canListSessions(d),
  }));
}

/** Someone else in the workspace as a view is told of them: pointing at what their pointer is over. */
const viewParticipant = (p: Participant): ViewParticipant => ({
  id: p.id, person: p.person, name: p.name, color: colorOf(p), cursor: p.over ? { tileId: p.over } : null, selection: p.selection,
});

const coded = (code: "UNSUPPORTED" | "BAD_REQUEST", message: string) => Object.assign(new Error(message), { code });

/** What a community view's host link may read. `share` and `confirmPrompt` show the host's confirm. */
export function viewLinkServices(opts: {
  layoutKey: () => string | null;
  /** The workspace the view shows, or null (a transient one). */
  repo: () => string | null;
  share: (png: ArrayBuffer, suggestedName?: string) => Promise<ShareOutcome>;
  /** The local folder a frame is bound to, or null (none, or on another machine). */
  frameFolder: (frameId: string) => string | null;
  isAgentTile: (tileId: string) => boolean;
  confirmPrompt: LinkServices["confirmPrompt"];
}): LinkServices {
  return {
    agentStatus: (tileId, cb) => subscribeHostedStatus(tileId, (s) => cb(viewAgentStatus(s))),
    agents: viewAgents,
    sessions: async (agent, frameId) => {
      const def = catalogAgentById(agent);
      if (!def || !canListSessions(def)) throw coded("UNSUPPORTED", `${def?.label ?? agent} sessions cannot be listed`);
      const cwd = opts.frameFolder(frameId);
      if (!cwd) throw coded("UNSUPPORTED", "this frame has no folder on this machine");
      return window.hive.viewSessions(def.id, cwd);
    },
    confirmPrompt: opts.confirmPrompt,
    sendPrompt: async (tileId, text) => {
      if (!opts.isAgentTile(tileId)) throw coded("BAD_REQUEST", "only an agent tile takes a prompt");
      await window.hive.viewPrompt(tileId, text);
    },
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
    participants: {
      subscribe: (cb) => {
        const repo = opts.repo();
        if (!repo) { cb([]); return () => {}; }
        return watchPeopleHere(repo, (people) => cb(people.map(viewParticipant)));
      },
    },
  };
}
