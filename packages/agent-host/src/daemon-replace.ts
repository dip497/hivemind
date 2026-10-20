/**
 * Stopping a machine's daemon, and moving its sessions to a new daemon when the one running speaks
 * another protocol: every agent finishes the turn it is in, is put to sleep (its conversation and
 * screen kept), the old daemon stops, and each is woken in the new one. A daemon of the same
 * protocol is never replaced.
 */
import net from "node:net";
import type { Duplex } from "node:stream";
import { type ClientMsg, type ServerMsg, type SessionInfo, frame, makeLineDecoder } from "./pty-protocol.js";

/** Putting one of these to sleep would end its turn: it is working, or asking the person. */
const MID_TURN = new Set(["working", "waiting"]);
const ANSWER_MS = 30_000;

interface Line {
  send(m: ClientMsg): void;
  /** The first message `pick` takes, or a rejection when the daemon goes or `ms` passes. */
  ask<T>(m: ClientMsg | null, pick: (m: ServerMsg) => T | undefined, ms?: number): Promise<T>;
  listen(fn: (m: ServerMsg) => void): void;
  closed: Promise<void>;
  end(): void;
}

function line(s: Duplex): Line {
  const listeners = new Set<(m: ServerMsg) => void>();
  s.on("data", makeLineDecoder((text) => {
    let m: ServerMsg;
    try { m = JSON.parse(text) as ServerMsg; } catch { return; }
    for (const fn of [...listeners]) fn(m);
  }));
  s.on("error", () => { /* surfaced as close */ });
  const closed = new Promise<void>((resolve) => s.once("close", () => resolve()));
  const send = (m: ClientMsg) => { s.write(frame(m)); };
  return {
    send,
    ask: (m, pick, ms = ANSWER_MS) => new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); listeners.delete(hear); };
      const timer = setTimeout(() => { done(); reject(new Error("the terminal daemon did not answer")); }, ms);
      timer.unref?.();
      const hear = (msg: ServerMsg) => { const v = pick(msg); if (v !== undefined) { done(); resolve(v); } };
      listeners.add(hear);
      void closed.then(() => { done(); reject(new Error("the terminal daemon went away")); });
      if (m) send(m);
    }),
    listen: (fn) => { listeners.add(fn); },
    closed,
    end: () => { s.destroy(); },
  };
}

/** A connection to the daemon listening on the socket `sock`. */
export function socketAt(sock: string): () => Promise<Duplex> {
  return () => new Promise((resolve, reject) => {
    const s = net.connect(sock);
    s.once("error", reject);
    s.once("connect", () => { s.removeListener("error", reject); resolve(s); });
  });
}

/** The protocol of the daemon `connect` reaches: null when none answers, 0 when it names none. */
export async function daemonProtocol(connect: () => Promise<Duplex>, timeoutMs = 1000): Promise<number | null> {
  let s: Duplex;
  try { s = await connect(); } catch { return null; }
  const l = line(s);
  try {
    return await l.ask({ t: "ping", reqId: "protocol" }, (m) => (m.t === "pong" ? m.protocol ?? 0 : undefined), timeoutMs);
  } catch {
    return null;
  } finally {
    l.end();
  }
}

/** The sessions of the daemon `connect` reaches; none when no daemon answers, and none is started. */
export async function daemonSessions(connect: () => Promise<Duplex>, timeoutMs = 2000): Promise<SessionInfo[]> {
  let s: Duplex;
  try { s = await connect(); } catch { return []; }
  const l = line(s);
  try {
    return await l.ask({ t: "list", reqId: "sessions", detail: true }, (m) => (m.t === "sessions" ? m.detail ?? [] : undefined), timeoutMs);
  } catch {
    return [];
  } finally {
    l.end();
  }
}

/** Ask the daemon on `l` to stop, and wait until it has: it saves every session's screen first. */
async function shutDown(l: Line, ms: number): Promise<boolean> {
  l.send({ t: "shutdown" });
  return Promise.race([l.closed.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), ms).unref?.())]);
}

/** Stop the daemon `connect` reaches, as `hive daemon stop` does: its sessions end, their screens
 *  saved, and the next daemon brings them back. False when no daemon answers; throws when it is
 *  still running after `ms`. */
export async function stopDaemon(connect: () => Promise<Duplex>, ms = 10_000): Promise<boolean> {
  let s: Duplex;
  try { s = await connect(); } catch { return false; }
  const l = line(s);
  try {
    if (!(await shutDown(l, ms))) throw new Error(`the terminal daemon is still running after ${Math.round(ms / 1000)}s`);
    return true;
  } finally {
    l.end();
  }
}

/** What a stopped daemon was running: the sessions put to sleep for the next one to wake, and
 *  those it could not put to sleep, which ended with it and come back from their saved screens. */
export interface Retired {
  asleep: SessionInfo[];
  ended: string[];
}

/** Put every running session of the daemon `connect` reaches to sleep once no agent is mid-turn,
 *  then stop that daemon. `waiting` hears the sessions it waits on, and [] once it waits on none; `now` ends
 *  the wait, ending those turns. */
export async function retireDaemon(connect: () => Promise<Duplex>, o: { waiting: (ids: string[]) => void; now: Promise<void> }): Promise<Retired> {
  const l = line(await connect());
  try {
    const states = new Map<string, string>();
    const bare = (id: string) => id.replace(/^hm:/, "");
    let changed = () => {};
    l.listen((m) => {
      if (m.t !== "event" || m.topic !== "agent.status") return;
      const { tileId, status } = m.data as { tileId: string; status: { state: string } };
      states.set(bare(tileId), status.state);
      changed();
    });
    l.send({ t: "hello", caps: ["events"] });
    const list = await l.ask({ t: "list", reqId: "retire", detail: true }, (m) => (m.t === "sessions" ? m.detail ?? [] : undefined));
    const running = list.filter((s) => s.state === "live");
    let cut = false;
    void o.now.then(() => { cut = true; changed(); });
    const midTurn = () => (cut ? [] : running.filter((s) => MID_TURN.has(states.get(bare(s.id)) ?? "")).map((s) => s.id));
    for (let busy = midTurn(); busy.length; busy = midTurn()) {
      o.waiting(busy);
      await new Promise<void>((resolve) => { changed = resolve; });
    }
    o.waiting([]);
    const asleep: SessionInfo[] = [];
    const ended: string[] = [];
    await Promise.all(running.map(async (s) => {
      const r = await l.ask({ t: "sleep", reqId: `sleep:${s.id}`, id: s.id }, (m) => (m.t === "slept" && m.id === s.id ? m : undefined)).catch(() => null);
      if (r && !r.error) asleep.push(s); else ended.push(s.id);
    }));
    await shutDown(l, ANSWER_MS);
    return { asleep, ended };
  } finally {
    l.end();
  }
}

/** Wake each of `sessions` in the daemon `s` is connected to, as it was put to sleep: the ids woken. */
export async function wakeSessions(s: Duplex, sessions: readonly SessionInfo[]): Promise<string[]> {
  const l = line(s);
  try {
    const woke = await Promise.all(sessions.map(async (x) => {
      const spec = { cwd: x.cwd, cmd: x.cmd, args: x.args, cols: x.cols, rows: x.rows };
      const r = await l.ask({ t: "attach", reqId: `wake:${x.id}`, id: x.id, spec, wake: true },
        (m) => (m.t === "attached" && m.reqId === `wake:${x.id}` ? m : undefined)).catch(() => null);
      if (!r || r.pid <= 0) return null;
      l.send({ t: "detach", id: x.id });
      return x.id;
    }));
    return woke.filter((id): id is string => id !== null);
  } finally {
    l.end();
  }
}
