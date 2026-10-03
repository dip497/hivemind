/**
 * Telling the person's phones what happened while they were away (M5, spec/push.md): an agent in
 * a workspace this device holds that begins waiting on them, finishes or fails is told to each
 * phone that gave this device a push subscription, encrypted to that phone (web-push.ts) and
 * posted to its endpoint. Whatever carries it reads nothing of it. Electron-free.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { InputKind } from "@hivemind/agents";
import type { JoinQuestion } from "@hivemind/workspace-api/people";
import { toBareId } from "@hivemind/workspace-api/tile-id";
import type { Changes } from "@hivemind/workspace-host/doc-sync";
import { idOf, signWith, type Seed } from "@hivemind/workspace-host/identity";
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
  /** A permission the device can allow or deny (`needs`, 0.4): the phone may offer Allow / Deny. */
  decide?: true;
}

/** What a phone is told when one of the person's devices is back: it started, or woke. */
export interface Back {
  v: 1;
  t: "back";
  /** The device: its id, and what it is called. */
  device: string;
  name: string;
  since: number;
}

/** What a phone is told when someone asks to join a workspace of the person's while none of their
 *  windows is there to ask (0.5): Allow / Deny answers it (`people.answer`). */
export interface Join {
  v: 1;
  t: "join";
  /** The workspace: its id, and its name. */
  workspace: string;
  name: string;
  /** The question, as `people.answer` names it. */
  req: number;
  /** Who asks, as they said, and the role their link gives. */
  who: string;
  role: string;
  since: number;
}

type Status = WaitingStatus["status"];

/** How much of an agent's name, and of its workspace's, a notice carries, in characters: a task
 *  can be a whole prompt, and a notice must fit what Apple's push service carries (spec/push.md). */
export const AGENT_MAX = 200;

/** The first `AGENT_MAX` characters of `name`. */
const short = (name: string): string => [...name].slice(0, AGENT_MAX).join("");

/** What an agent's status changing from `before` to `status` tells the phones: that it began
 *  waiting on the person, finished, or failed; null for anything else, and for an agent first seen
 *  now (its status brought back as this device starts, say). */
export function toldOf(before: Status | undefined, status: Status): Notice["t"] | null {
  if (!before) return null;
  if (waitsOnThePerson(status)) return waitsOnThePerson(before) && before.since === status.since ? null : "needs";
  if (status.state !== "done" && status.state !== "failed") return null;
  return before.state === status.state ? null : status.state === "done" ? "finished" : "failed";
}

/** The notice `t` of `change`, for the agent of `held` it is; null while it is on none of them. A
 *  permission is one it can decide when `decides` says so of the agent's tile. */
function noticeFor(t: Notice["t"], { tileId, status }: WaitingStatus, held: HeldBoard[], decides: (tile: string) => boolean): Notice | null {
  const at = agentOf(held, tileId, status.title);
  if (!at) return null;
  const decide = t === "needs" && status.kind === "permission" && decides(at.tile);
  return { v: 1, t, ...at, name: short(at.name), agent: short(at.agent), ...(t === "needs" ? { kind: status.kind } : {}), since: status.since, ...(decide ? { decide } : {}) };
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
    const kept = Object.fromEntries(all.map(({ device, ...sub }) => [device, sub]));
    fs.writeFileSync(tmp, `${JSON.stringify(kept, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

export interface PushOptions {
  /** This device: its id, and what it is called. */
  me(): { device: string; name: string };
  /** The workspaces held here, with their boards, and each change to them. */
  boards(): HeldBoard[];
  /** Whether a permission the agent of `tile` asks can be allowed or denied from here (its agent
   *  says which of its keys do). */
  decides(tile: string): boolean;
  changes: Changes;
  subscriptions: PushSubscriptions;
  /** Post `body` to `endpoint`, signed when `sign`: the status the push service answered. */
  post(endpoint: string, body: Buffer, urgency: "high" | "normal", sign: boolean): Promise<number>;
  onWarn?(message: string): void;
}

/** How long a push service keeps a notice for a phone it cannot reach: a day. */
const TTL_S = 24 * 3600;

/** Who posts `body` to `endpoint` at `at`: the device whose key `device` is, its signature over
 *  the phone's handle (the last segment of the endpoint's path), the time and the body's hash
 *  (spec/push.md 0.3, "Sending"). */
function sender(device: Seed, endpoint: string, at: number, body: Buffer): string {
  const handle = new URL(endpoint).pathname.split("/").filter(Boolean).pop() ?? "";
  const signed = Buffer.concat([Buffer.from(`hive/push-notice/1\n${handle}\n${at}\n`), createHash("sha256").update(body).digest()]);
  return `${idOf(device)} ${at} ${Buffer.from(signWith(device, signed)).toString("hex")}`;
}

/** Post a notice the way Web Push takes it (RFC 8030): encrypted, kept a day; signed by this
 *  device, whose key `device` is, for a push server that tells the phone only what the devices it
 *  named sign (a subscription that says `sign`). Never where a redirect points. */
export async function postNotice(endpoint: string, body: Buffer, urgency: "high" | "normal", device: Seed | null): Promise<number> {
  const res = await fetch(endpoint, {
    method: "POST",
    redirect: "error",
    headers: {
      TTL: String(TTL_S), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", Urgency: urgency,
      ...(device ? { "Hive-Sender": sender(device, endpoint, Date.now(), body) } : {}),
    },
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
    const pushNotices = () => this.placed();
    o.changes(pushNotices);
  }

  changed(change: WaitingStatus): void {
    const tile = toBareId(change.tileId);
    const t = toldOf(this.before.get(tile), change.status);
    const { state, kind, since } = change.status;
    if (state === "exited") this.before.delete(tile);
    else this.before.set(tile, { state, ...(kind ? { kind } : {}), since });
    this.unplaced.delete(tile);
    if (!t) return;
    const notice = noticeFor(t, change, this.o.boards(), (tile) => this.o.decides(tile));
    if (notice) this.tell(notice);
    else this.unplaced.set(tile, { t, change });
  }

  /** This device is back (it started, or woke): each phone is told, and shows it when it found
   *  this device away. */
  back(): void {
    const { device, name } = this.o.me();
    this.send({ v: 1, t: "back", device, name: short(name), since: Date.now() }, "normal");
  }

  /** Someone asks to join `workspace` (its id; `question` names it): each phone is told, urgently.
   *  Whether there was any phone to tell. */
  asked(workspace: string, question: JoinQuestion): boolean {
    if (this.o.subscriptions.list().length === 0) return false;
    const who = short(question.profile.name || "someone");
    this.send({ v: 1, t: "join", workspace, name: short(question.workspace), req: question.req, who, role: question.role, since: Date.now() }, "high");
    return true;
  }

  /** The boards changed: each agent now on one is told of. */
  private placed(): void {
    if (this.unplaced.size === 0) return;
    const held = this.o.boards();
    for (const [tile, { t, change }] of this.unplaced) {
      const notice = noticeFor(t, change, held, (tile) => this.o.decides(tile));
      if (!notice) continue;
      this.unplaced.delete(tile);
      this.tell(notice);
    }
  }

  /** Tell the phones `notice`, urgently when it waits on them. */
  private tell(notice: Notice): void {
    this.send(notice, notice.t === "needs" ? "high" : "normal");
  }

  /** Post `message` to each phone subscribed, encrypted to it. */
  private send(message: Notice | Back | Join, urgency: "high" | "normal"): void {
    const plaintext = Buffer.from(JSON.stringify(message));
    for (const sub of this.o.subscriptions.list()) {
      // A subscription the push service no longer knows is dropped (RFC 8030 §7.3).
      void this.o.post(sub.endpoint, encrypt(plaintext, sub), urgency, sub.sign === true).then(
        (status) => { if (status === 404 || status === 410) this.o.subscriptions.remove(sub.device); },
        (e: unknown) => this.o.onWarn?.(`push to ${sub.device.slice(0, 8)}…: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
  }
}
