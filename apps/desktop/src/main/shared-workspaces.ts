/**
 * Workspaces shared with this person, open here (M1; design §4.2 B–C, F): each one's host dialled
 * over hive-net, its document kept in a replica (`sharedStore`, named `hive://<id>`) in sync, and
 * its host's workspace API for everything else a window asks about it. A window's call is routed
 * by what it names: the workspace (or a path in it), or a tile the replica holds.
 *
 * The connection comes back by itself: when it drops, or the host cannot be reached, it is dialled
 * again, sooner at first and then every 15 s, while the window keeps showing the replica (edits
 * made meanwhile go to the host when it is back). When the workspace moves to another of its
 * owner's devices (M3), the host says where, and it is dialled there at once. It ends when this
 * person leaves, or the host removes them; what is kept then is the last copy, which may no
 * longer be written.
 *
 * In someone else's workspace, the sessions this person placed in frames of theirs on this machine
 * (M4) are shown to its host over this connection (`machine-share.ts`), for everyone there to
 * watch: the host never dials this machine, and starts, types or sizes nothing here.
 */
import type { Access, AccessLists } from "@hivemind/workspace-host/access";
import { mayEdit, replicate, type Moved } from "@hivemind/workspace-host/doc-sync";
import { refusedEdit } from "@hivemind/workspace-host/edit-rules";
import type { CoreLayout } from "@hivemind/workspace-doc/shapes";
import { followList } from "@hivemind/workspace-host/list-sync";
import type { Link } from "@hivemind/workspace-host/hive-net";
import { peerTransport, workspaceUrl } from "@hivemind/workspace-api/peers";
import type { ClientTransport } from "@hivemind/workspace-api/client";
import type { Answer, EventMessage } from "@hivemind/workspace-api/protocol";
import type { Elsewhere } from "./workspace-ipc.js";
import { streamOf } from "@hivemind/host/peer-links";
import { onWorkspaceChange, sharedStore } from "./workspace-store-ipc.js";
import { machineIdentity } from "./identity.js";
import path from "node:path";
import { app } from "electron";
import { parseDeviceUri } from "@hivemind/core/remote-uri";
import { MachinePlaces, type Placed } from "@hivemind/host/machine-places";
import { SHOWN_WAIT_MS, serveMachine, type Grant } from "@hivemind/host/machine-share";
import { handOffFrom } from "@hivemind/host/hand-off";
import type { HandedOff } from "@hivemind/workspace-api/git";
import { defaultShellFor } from "@hivemind/agent-host/shell-spec";
import type { Duplex } from "node:stream";
import { toBareId } from "@hivemind/workspace-api/tile-id";

/** Where the connection to a workspace's host is. */
export type SharedState = "connecting" | "connected" | "reconnecting" | "offline" | "left" | "removed";

export interface SharedStatus {
  state: SharedState;
  /** What the host last gave this person. */
  access: Access;
}

/** How a workspace is reached, and what is heard from it. */
export interface Reach {
  dial(): Promise<Link>;
  /** Its host's events, for the windows. */
  publish(event: EventMessage): void;
  /** Its connection changed, or the host gave another role. */
  told(workspace: string, status: SharedStatus): void;
  /** It is hosted elsewhere now: keep where, so the next dial goes there. Whether it is followed
   *  (a notice that does not hold up is not). */
  moved?(notice: Moved): Promise<boolean>;
  /** Where the person keeps their workspaces' lists: welcomed as the owner's, the list is kept in
   *  step with the host's (M3), which sends it to the owner's devices alone. */
  lists?: Pick<AccessLists, "follow">;
  /** This machine's PTY daemon, where the sessions this person placed here run (M4): a new
   *  connection to it. None: nothing here is shown to the host. */
  daemon?(): Promise<Duplex>;
}

interface Open {
  status: SharedStatus;
  api: ClientTransport | null;
  link: Link | null;
  retry: ReturnType<typeof setTimeout> | null;
  tries: number;
}

const open = new Map<string, Open>();
/** The next dial after `tries` failed ones: 0.5 s, 1 s, 2 s … then every 15 s. */
const backoff = (tries: number): number => Math.min(15_000, 500 * 2 ** tries);

/** The tile an event is about, by its first word: the tile, its session (`hm:<tile>`), or what
 *  names it (`{tileId}`). */
const tileNamed = (params: unknown[]): string | null => {
  const [first] = params;
  const id = typeof first === "string" ? first : (first as { tileId?: unknown } | null)?.tileId;
  return typeof id === "string" ? toBareId(id) : null;
};

/** The workspace id a `hive://` name is of, or null. */
const idOf = (v: unknown): string | null => {
  if (typeof v !== "string" || !v.startsWith("hive://")) return null;
  return v.slice("hive://".length).split("/")[0] || null;
};

/**
 * Keep this person connected to the host of `workspace`, where they were last given `access`,
 * unless they are already. Resolves after the first try, connected or not: the window shows the
 * replica either way.
 */
export async function openShared(workspace: string, access: Access, reach: Reach): Promise<void> {
  if (open.has(workspace)) return;
  const repo = workspaceUrl(workspace);
  const entry: Open = { status: { state: "connecting", access }, api: null, link: null, retry: null, tries: 0 };
  open.set(workspace, entry);
  const set = (state: SharedState, given = entry.status.access): void => {
    entry.status = { state, access: given };
    reach.told(workspace, entry.status);
  };
  const again = (state: SharedState): void => {
    set(state);
    entry.retry = setTimeout(() => void connect(), backoff(entry.tries++));
  };
  const connect = async (): Promise<void> => {
    entry.retry = null;
    let link: Link;
    try {
      link = await reach.dial();
    } catch {
      if (open.get(workspace) === entry) again("offline");
      return;
    }
    if (open.get(workspace) !== entry) return link.close("left");
    entry.link = link;
    entry.api = peerTransport(streamOf(link, "api"));
    // A tile in a frame of this person's on this machine runs here, whoever put it there: what is
    // said of it (a task for it, its keyboard, its size) is this machine's, never its host's (M4).
    entry.api.events((event) => {
      const tile = tileNamed(event.params);
      if (tile && guestIn(workspace) && (placesHere().placed(workspace, tile) || onThisMachine(repo, tile))) return;
      reach.publish(event);
    });
    let following: Promise<boolean> = Promise.resolve(false);
    let stopList = (): void => {};
    let stopMachine = (): void => {};
    const stop = replicate(sharedStore(), repo, streamOf(link, "sync"), {
      workspace,
      changes: onWorkspaceChange,
      onWelcome: (given) => {
        entry.tries = 0;
        set("connected", given);
        // Welcomed as the owner's: the list is kept in step with the host's (M3).
        stopList();
        if (given === "owner" && reach.lists) stopList = followList(reach.lists, workspace, streamOf(link, "list"), (why) => console.warn(`[shared] ${workspace}: ${why}`));
        // As a guest: what this person placed on this machine is shown to the host, to watch (M4).
        stopMachine();
        stopMachine = given !== "owner" && reach.daemon ? serveMachine(streamOf(link, "machine"), {
          daemon: reach.daemon,
          shows: (session) => placesHere().placed(workspace, toBareId(session)) !== null,
          runs: (session) => othersRun(workspace, toBareId(session)),
          grant: () => placesHere().grant(workspace),
          granted: (listener) => placesHere().onGrant((changed) => { if (changed === workspace) listener(); }),
          onWarn: (m) => console.warn(`[shared] ${workspace}: ${m}`),
        }) : () => {};
      },
      onMoved: (notice) => {
        following = (reach.moved?.(notice) ?? Promise.resolve(false)).catch((e: unknown) => {
          console.warn(`[shared] ${workspace}: not followed: ${e instanceof Error ? e.message : String(e)}`);
          return false;
        });
      },
      onFailed: (why) => console.warn(`[shared] ${workspace}: ${why}`),
    });
    void link.closed.then(async (why) => {
      stop();
      stopList();
      stopMachine();
      entry.link = null;
      entry.api = null;
      if (open.get(workspace) !== entry) return;
      // Taken off the list, or refused at the door: nothing comes of dialling again.
      if (/removed|not admitted/.test(why)) {
        open.delete(workspace);
        return set("removed");
      }
      // Moved: where it is now is kept by then, and dialled at once. (Told by a notice that did not
      // hold up, it is dialled again as after any drop, not at once.)
      if (/\bmoved\b/.test(why) && (await following)) {
        if (open.get(workspace) !== entry) return;
        entry.tries = 0;
        set("reconnecting");
        return void connect();
      }
      again("reconnecting");
    });
  };
  await connect();
}

/** Stop being connected to `workspace`'s host: this person left it. */
export function leaveShared(workspace: string): void {
  const entry = open.get(workspace);
  if (!entry) return;
  open.delete(workspace);
  if (entry.retry) clearTimeout(entry.retry);
  entry.link?.close("left");
}

/** `workspace` is hosted here now (M3): its connection goes, and its copy, whose tiles are the
 *  workspace's own here. */
export function forgetShared(workspace: string): void {
  leaveShared(workspace);
  sharedStore().forget(workspaceUrl(workspace));
}

/** Where the connection to `workspace`'s host is, while it is open here. */
export function sharedStatus(workspace: string): SharedStatus | null {
  return open.get(workspace)?.status ?? null;
}

/** Whether this person may change their copy of `workspace` here: while it is open, and the host
 *  last let them edit its board. A copy kept after it ended is only read. */
export function mayWriteShared(workspace: string): boolean {
  const entry = open.get(workspace);
  return !!entry && mayEdit(entry.status.access);
}

/** Why a window here may not change the layout of its copy of `workspace` from `before` to
 *  `after`, or null: what the host would not take from this person's role there (`edit-rules.ts`),
 *  which would part the copy from the host's. */
export function refusedShared(workspace: string, before: CoreLayout | null, after: CoreLayout): string | null {
  const entry = open.get(workspace);
  return entry ? refusedEdit(before, after, entry.status.access, machineIdentity().deviceId) : "not connected to this workspace's host";
}

/** A terminal a window opens in a workspace shared from elsewhere is shown, never started there,
 *  unless its host lets this person drive agents (M2): the session is the host's, and a guest's
 *  window attaches to it. */
function attaching(method: unknown, params: unknown[], access: Access): unknown[] {
  if (method !== "terminal.open" || access === "agents" || access === "owner") return params;
  const [opts, ...rest] = params;
  return [{ ...(opts as object), attachOnly: true }, ...rest];
}

/** What this machine's person placed on it in workspaces shared from elsewhere (M4). */
let places: MachinePlaces | null = null;
const placesHere = (): MachinePlaces => (places ??= new MachinePlaces({
  file: path.join(app.getPath("userData"), "placed.json"),
  device: machineIdentity().deviceId,
  onWarn: (m) => console.warn(`[placed] ${m}`),
}));

/** Hand off the branch checked out in this person's frame `uri` on this machine to the host of
 *  `workspace` (M4): what lands there. */
export async function handOffTo(workspace: string, uri: string): Promise<HandedOff> {
  const at = parseDeviceUri(uri);
  if (!at || at.device !== machineIdentity().deviceId) throw new Error("hand off: only a frame on this computer hands off from here");
  return handOffFrom(at.path, async (branch, bundle) => {
    const api = open.get(workspace)?.api;
    if (!api) throw new Error("not connected to this workspace's host");
    const answer = await api.call("git.handOff", [workspaceUrl(workspace), branch, bundle]);
    if ("error" in answer) throw new Error(answer.error.message);
    return answer.result as HandedOff;
  });
}

/** What this person lets the people in `workspace` do on this machine (M4). */
export function machineGrant(workspace: string): Grant {
  return placesHere().grant(workspace);
}

/** Let the people in `workspace` do `grant` on this machine from now on: its host is told at once,
 *  and what this machine lets through follows it. */
export function setMachineGrant(workspace: string, grant: Grant): void {
  placesHere().setGrant(workspace, grant);
}

/** A window here changed its copy `repo` from `before` to `after`: what it placed on this machine. */
export function wroteShared(repo: string, before: CoreLayout | null, after: CoreLayout): void {
  const workspace = idOf(repo);
  if (workspace) placesHere().wrote(workspace, before, after);
}

/** Whether this person is a guest in `workspace` (someone else's), not its owner at one of their
 *  own devices' workspaces hosted elsewhere: only a guest's machine runs nothing it did not place. */
const guestIn = (workspace: string | null): boolean => !!workspace && open.get(workspace)?.status.access !== "owner";

/** For a tile of someone else's workspace, what this person placed it to run on this machine
 *  (null: nobody here placed it, so nothing of it runs here); undefined for any other. */
export function placedRun(bareTile: string): Placed | null | undefined {
  const workspace = idOf(sharedStore().workspaceOf(bareTile));
  return workspace && guestIn(workspace) ? placesHere().placed(workspace, bareTile) : undefined;
}

/** Whether tile `bare` is one someone else put in a frame of this person's here, in a workspace
 *  shared from elsewhere whose people they let run agents on this machine (M4): its host starts
 *  it, with what it gives it to do, and a window here shows it once it runs. */
export function startedByOthers(bare: string): boolean {
  const workspace = idOf(sharedStore().workspaceOf(bare));
  return !!workspace && guestIn(workspace) && othersRun(workspace, bare) !== null;
}

/** The session of a tile `startedByOthers`, as `attach` (which never starts one) attaches to it
 *  once it runs: tried again a while, as its host gets to starting it. */
export async function onceStarted(attach: () => Promise<{ pid: number }>): Promise<{ pid: number }> {
  for (const until = Date.now() + SHOWN_WAIT_MS; ; await new Promise((r) => setTimeout(r, 300))) {
    const r = await attach();
    if (r.pid !== -1 || Date.now() >= until) return r;
  }
}

/** What tile `bare` of `workspace` runs on this machine when someone else put it in a frame of
 *  this person's here, as they let the people there run agents here (`MachinePlaces.othersRun`,
 *  from this machine's copy of the workspace). */
function othersRun(workspace: string, bare: string): { cwd: string; cmd: string; args: string[] } | null {
  return placesHere().othersRun(workspace, sharedStore().getCore(workspaceUrl(workspace)), bare, defaultShellFor());
}

/** The tiles of each copy here that are in a frame on this machine, made again as it changes. */
const local = new Map<string, Set<string>>();
onWorkspaceChange((change) => { if (change.repo.startsWith("hive://")) local.delete(change.repo); });
/** Whether tile `bare` of the copy `repo` is in a frame on this machine (M4): it runs here. */
function onThisMachine(repo: string, bare: string): boolean {
  let tiles = local.get(repo);
  if (!tiles) {
    const core = sharedStore().getCore(repo);
    const self = machineIdentity().deviceId;
    const here = new Set((core?.frames ?? []).filter((f) => typeof f.workspacePath === "string" && parseDeviceUri(f.workspacePath)?.device === self).map((f) => f.id));
    tiles = new Set(Object.entries(core?.frameOf ?? {}).filter(([, frame]) => here.has(frame)).map(([tile]) => tile));
    local.set(repo, tiles);
  }
  return tiles.has(bare);
}

/** The workspace a window's call is about, when it is one shared from elsewhere. A tile in a frame
 *  of this person's on this machine, in someone else's workspace, is this machine's: its calls are
 *  answered here. */
function workspaceOf(method: unknown, params: unknown): string | null {
  if (typeof method !== "string" || !Array.isArray(params)) return null;
  const [first] = params as unknown[];
  const named = idOf(first) ?? idOf((first as { cwd?: unknown } | null)?.cwd);
  if (named) return named;
  // A tile's methods name the tile (a terminal's, its session: `hm:<tile>`): it is shared from
  // elsewhere when a replica holds it.
  if (typeof first === "string" || typeof (first as { tileId?: unknown } | null)?.tileId === "string") {
    const named = (first as { tile?: unknown } | null)?.tile;
    const bare = typeof named === "string" ? named : toBareId(typeof first === "string" ? first : (first as { tileId: string }).tileId);
    const repo = sharedStore().workspaceOf(bare);
    return repo && !(guestIn(idOf(repo)) && onThisMachine(repo, bare)) ? idOf(repo) : null;
  }
  return null;
}

/** Routes a window's calls about a workspace shared from elsewhere to its host. The store's own
 *  methods stay here: the replica answers them. */
export const elsewhere: Elsewhere = {
  call(method, params): Promise<Answer> | null {
    if (typeof method === "string" && method.startsWith("store.")) return null;
    const ws = workspaceOf(method, params);
    if (!ws) return null;
    const entry = open.get(ws);
    if (!entry?.api) return Promise.resolve({ error: { code: "FAILED", message: "not connected to this workspace's host" } });
    return entry.api.call(method as string, attaching(method, params as unknown[], entry.status.access));
  },
  notice(method, params): boolean {
    if (typeof method === "string" && method.startsWith("store.")) return false;
    const ws = workspaceOf(method, params);
    if (!ws) return false;
    open.get(ws)?.api?.notice(method as string, params as unknown[]);
    return true;
  },
};
