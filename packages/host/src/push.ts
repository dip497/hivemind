/**
 * Telling the person's phones what happened while they were away (M5, spec/push.md): an agent in
 * a workspace this device holds that begins waiting on them, finishes or fails is told to each
 * phone that gave this device a push subscription, encrypted to that phone (web-push.ts) and
 * posted to its endpoint. Whatever carries it reads nothing of it. Electron-free.
 */
import fs from "node:fs";
import path from "node:path";
import type { InputKind } from "@hivemind/agents";
import { toBareId } from "@hivemind/workspace-api/tile-id";
import type { Changes } from "@hivemind/workspace-host/doc-sync";
import { agentOf, waitsOnThePerson, type HeldBoard, type WaitingStatus } from "./needs.js";
import { encrypt, subscriptionOf, type Subscription } from "./web-push.js";

/** What a phone is told: an agent began waiting on the person, finished, or failed. */
export interface Notice {
  v: 1;
  t: "needs" | "finished" | "failed";
  workspace: string;
  name: string;
  tile: string;
  /** What the agent is called, its first `AGENT_MAX` characters. */
  agent: string;
  /** What it waits for (`needs`). */
  kind?: InputKind;
  /** When its status became what it is, ms since the epoch: with `tile`, which wait (`needs`). */
  since: number;
}

type Status = WaitingStatus["status"];

/** How much of an agent's name a notice carries, in characters: a task can be a whole prompt,
 *  and a notice is one record. */
export const AGENT_MAX = 200;

/** What an agent's status changing from `before` to `status` tells the phones: that it began
 *  waiting on the person, finished, or failed; null for anything else, and for an agent first seen
 *  now (its status brought back as this device starts, say). */
export function toldOf(before: Status | undefined, status: Status): Notice["t"] | null {
  if (!before) return null;
  if (waitsOnThePerson(status)) return waitsOnThePerson(before) && before.since === status.since ? null : "needs";
  if (status.state !== "done" && status.state !== "failed") return null;
  return before.state === status.state ? null : status.state === "done" ? "finished" : "failed";
}

/** The notice `t` of `change`, for the agent of `held` it is; null while it is on none of them. */
function noticeFor(t: Notice["t"], { tileId, status }: WaitingStatus, held: HeldBoard[]): Notice | null {
  const at = agentOf(held, tileId, status.title);
  if (!at) return null;
  const agent = [...at.agent].slice(0, AGENT_MAX).join("");
  return { v: 1, t, ...at, agent, ...(t === "needs" ? { kind: status.kind } : {}), since: status.since };
}

/** The phones subscribed here, kept in a file beside this device's keys (0600): one each. */
export class PushSubscriptions {
  constructor(private readonly file: string) {}

  list(): Array<{ device: string } & Subscription> {
    let all: unknown;
    try { all = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { return []; }
    if (!all || typeof all !== "object") return [];
    return Object.entries(all as Record<string, unknown>).flatMap(([device, s]) => {
      const sub = /^[0-9a-f]{64}$/.test(device) ? subscriptionOf(s) : null;
      return sub ? [{ device, ...sub }] : [];
    });
  }

  /** `device` is told at `sub` from now on, in place of where it was. */
  set(device: string, sub: Subscription): void {
    this.write([...this.list().filter((s) => s.device !== device), { device, ...sub }]);
  }

  /** `device` is told nothing more. */
  remove(device: string): void {
    this.write(this.list().filter((s) => s.device !== device));
  }

  private write(all: Array<{ device: string } & Subscription>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const kept = Object.fromEntries(all.map(({ device, endpoint, p256dh, auth }) => [device, { endpoint, p256dh, auth }]));
    fs.writeFileSync(tmp, `${JSON.stringify(kept, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

export interface PushOptions {
  /** The workspaces held here, with their boards, and each change to them. */
  boards(): HeldBoard[];
  changes: Changes;
  subscriptions: PushSubscriptions;
  /** Post `body` to `endpoint`: the status the push service answered. */
  post(endpoint: string, body: Buffer, urgency: "high" | "normal"): Promise<number>;
  onWarn?(message: string): void;
}

/** How long a push service keeps a notice for a phone it cannot reach: a day. */
const TTL_S = 24 * 3600;

/** Post a notice the way Web Push takes it (RFC 8030): encrypted, kept a day. */
export async function postNotice(endpoint: string, body: Buffer, urgency: "high" | "normal"): Promise<number> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { TTL: String(TTL_S), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", Urgency: urgency },
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(15_000),
  });
  return res.status;
}

/** Each status change, told to the phones when it is one they are told of. */
export class PushNotices {
  /** Each session's status as last changed, until it exits: a session started anew in its tile
   *  is first seen again. */
  private readonly before = new Map<string, Status>();
  /** What is to be told of an agent on no board here yet (a tile its window has not saved): told
   *  once the boards say where it is, unless its status changes first. */
  private readonly unplaced = new Map<string, { t: Notice["t"]; change: WaitingStatus }>();

  constructor(private readonly o: PushOptions) {
    o.changes(() => this.placed());
  }

  changed(change: WaitingStatus): void {
    const tile = toBareId(change.tileId);
    const t = toldOf(this.before.get(tile), change.status);
    const { state, kind, since } = change.status;
    if (state === "exited") this.before.delete(tile);
    else this.before.set(tile, { state, ...(kind ? { kind } : {}), since });
    this.unplaced.delete(tile);
    if (!t) return;
    const notice = noticeFor(t, change, this.o.boards());
    if (notice) this.tell(notice);
    else this.unplaced.set(tile, { t, change });
  }

  /** The boards changed: each agent now on one is told of. */
  private placed(): void {
    if (this.unplaced.size === 0) return;
    const held = this.o.boards();
    for (const [tile, { t, change }] of this.unplaced) {
      const notice = noticeFor(t, change, held);
      if (!notice) continue;
      this.unplaced.delete(tile);
      this.tell(notice);
    }
  }

  /** Post `notice` to each phone subscribed, encrypted to it. */
  private tell(notice: Notice): void {
    const plaintext = Buffer.from(JSON.stringify(notice));
    for (const sub of this.o.subscriptions.list()) {
      // A subscription the push service no longer knows is dropped (RFC 8030 §7.3).
      void this.o.post(sub.endpoint, encrypt(plaintext, sub), notice.t === "needs" ? "high" : "normal").then(
        (status) => { if (status === 404 || status === 410) this.o.subscriptions.remove(sub.device); },
        (e: unknown) => this.o.onWarn?.(`push to ${sub.device.slice(0, 8)}…: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
  }
}
