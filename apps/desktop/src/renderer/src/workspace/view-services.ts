/**
 * The renderer's protocol 1.3 services: one event hub fed by the status bus and the host's
 * session statuses, the activity and presence stores main updates, and the LinkServices a community view's
 * host link reads. Started once; it runs whatever view is active.
 */
import type { ActivityLevel, ShareOutcome, TurnOutcome, ViewAgent, ViewParticipant, ViewPresence } from "@hivemind/view-sdk/protocol";
import type { Participant } from "@hivemind/workspace-host/presence";
import { canListSessions, spawnableAgents, agentById as catalogAgentById } from "@hivemind/agents";
import type { LinkServices } from "@hivemind/view-host/link";
import { viewAgentStatus } from "@hivemind/view-host/status";
import { subscribeHostedStatus, subscribeStatus } from "../agent-status-bus";
import { agentMissing, agentToStart } from "../agent-plugins";
import { AGENT_TILE_KIND } from "../tile-kinds";
import { watchPeopleHere } from "../multiplayer/presence";
import { colorOf } from "../multiplayer/people";
import { ViewEventHub } from "./view-events";
import { clickWidget, pressWidget, watchViewWidgets } from "../board-objects/widget-runtime";
import { bandOver, followWidgetBand, widgetBand } from "../board-objects/widget-band";
import type { HcpStatusEvent } from "../../../shared/ipc";
import { issueService } from "./issue-service";
import { codeService } from "./code-service";
import { boardService, type BoardServiceOptions } from "./board-service";
import { followBroadcast, setBroadcastGroup } from "./broadcast-input";
import { followTileSeen } from "./tile-seen";
import { onBoardWritten, onStoreChange } from "./workspace-store-client";
import type { BoardObject } from "@hivemind/workspace-doc/shapes";

const TURN_ENDS = new Set(["done", "failed", "interrupted", "limited"]);

/** What a session's status change means for views: a turn its hooks ended, a new subagent count. */
export function feedHostedStatus(hub: Pick<ViewEventHub, "onHookStatus" | "onHookTurn" | "onSubagents">, last: Map<string, { state: string; subagents: number }>, e: HcpStatusEvent): void {
  const prev = last.get(e.tileId);
  const { state, subagents, source } = e.status;
  last.set(e.tileId, { state, subagents: subagents.length });
  if (source === "hooks") hub.onHookStatus(e.tileId);
  if (source === "hooks" && TURN_ENDS.has(state) && prev && !TURN_ENDS.has(prev.state)) hub.onHookTurn(e.tileId, state as TurnOutcome, e.status.since);
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
  const dflt = agentToStart()?.id;
  return spawnableAgents().filter((d) => !agentMissing(d.id)).map((d) => ({
    id: d.id, label: d.label, default: d.id === dflt, turns: d.caps.turnSignal, resumes: !!d.session?.resume, sessions: canListSessions(d),
  }));
}

/** Someone else in the workspace as a view is told of them: pointing at what their pointer is over. */
const viewParticipant = (p: Participant): ViewParticipant => ({
  id: p.id, person: p.person, name: p.name, color: colorOf(p), cursor: p.over ? { tileId: p.over } : null, selection: p.selection,
});

const coded = (code: "UNSUPPORTED" | "BAD_REQUEST", message: string) => Object.assign(new Error(message), { code });

/** Only these objects of a board, as stored now (null: gone). */
function boardObjects(repo: string, ids: string[]): Record<string, BoardObject | null> | null {
  try { return window.hive.workspaceObjectsWithIdsSync(repo, ids); } catch { return null; }
}

/** The ids of what changes on the board of the workspace shown: others' writes as the store says
 *  them, and this window's own. */
function boardChanges(repo: () => string | null, cb: (ids: readonly string[]) => void): () => void {
  const heard = (changed: string, ids: readonly string[] | null | undefined) => {
    const shown = repo();
    if (changed !== shown) return;
    if (ids) { cb(ids); return; }
    // Which is not known (an undo, a shallow document): every object is said changed, once.
    let all: BoardObject[] | null = null;
    try { all = window.hive.workspaceObjectsSync(shown); } catch { /* nothing to say */ }
    if (all) cb(all.map((b) => b.id));
  };
  const stopOthers = onStoreChange((c) => { if (c.part === "board") heard(c.repo, c.objects); });
  const stopOwn = onBoardWritten(heard);
  return () => { stopOthers(); stopOwn(); };
}

/** The widget cards' band (1.18) as the view in `box` has it: now, then whenever the cards are laid
 *  out again or the view's box changes size; nothing once the view stops following it. */
export function bandOverView(box: () => HTMLElement | null): NonNullable<LinkServices["widgetBand"]> {
  return {
    subscribe: (cb) => {
      const tell = () => {
        const el = box();
        if (el) cb(bandOver(widgetBand(), el.getBoundingClientRect(), window.innerWidth));
      };
      const stop = followWidgetBand(tell);
      const resized = new ResizeObserver(tell);
      const el = box();
      if (el) resized.observe(el);
      return () => { stop(); resized.disconnect(); };
    },
  };
}

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
  /** The `.hivemind` root whose issues the plugin is given (protocol 1.9), or null for none. */
  issueRoot: () => string | null;
  /** The local folder issues would be set up in, or null (none, or on another machine). */
  issueFolder: () => string | null;
  /** The box a view draws in, which the window's widget cards float over; a tool's tile has none. */
  box?: () => HTMLElement | null;
  /** The folder a frame's code is in (on this machine or another; null: the workspace's), or null for none. */
  frameRepo: (frameId: string | null) => string | null;
  /** Open a file in the frame's editor (null: any), at a line when given: the editor tile's id. */
  openFile: (frameId: string | null, path: string, at?: { line?: number; col?: number }) => Promise<string | null>;
  /** Open an address or a frame's file where a click would (protocol 1.21). */
  open: LinkServices["open"];
  /** The board of the workspace the view shows (protocol 1.20); none: the view is not offered it. */
  board?: Pick<BoardServiceOptions, "viewId" | "ask" | "frames" | "frameOf">;
  /** The session a terminal tile's keys go to, or null for a tile that is not a terminal. */
  ptyOf: (tileId: string) => string | null;
  /** This view, which owns the group it types into until it goes. */
  owner: object;
}): LinkServices {
  return {
    code: codeService(opts.frameRepo, opts.openFile),
    open: opts.open,
    ...(opts.board ? { board: boardService({ ...opts.board, repo: opts.repo, objects: boardObjects, changes: (cb) => boardChanges(opts.repo, cb) }) } : {}),
    ...(opts.box ? { widgetBand: bandOverView(opts.box) } : {}),
    issues: issueService(opts.issueRoot, opts.issueFolder),
    agentStatus: (tileId, cb) => subscribeHostedStatus(tileId, (s) => cb(viewAgentStatus(s))),
    seenOf: followTileSeen,
    // Only terminals join; a group short of two is none, so nothing is half on.
    broadcast: {
      set: (ids) => setBroadcastGroup(ids.flatMap((tile) => { const pty = opts.ptyOf(tile); return pty ? [{ tile, pty }] : []; }), opts.owner),
      follow: followBroadcast,
    },
    widgets: {
      subscribe: (cb) => {
        const repo = opts.repo();
        if (!repo) { cb([]); return () => {}; }
        return watchViewWidgets(repo, cb);
      },
      press: (id, press) => { if ("click" in press) clickWidget(id); else pressWidget(id, press.action); },
    },
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
      // The lines the hub still holds (it sends them every few seconds) go first, on the same channel,
      // so a turn that ended a moment ago is in the day a view reads now.
      viewEvents.flushLedger();
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

