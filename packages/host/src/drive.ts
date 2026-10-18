/**
 * The drive socket (spec/workspace-api.md "Drive socket"): the workspace API for programs on this
 * machine, `hive ctl` among them. A connection's first line says who it is: the install's token
 * is the person, answered as a window of theirs is; a grant's token is a program, served one
 * workspace like a guest, at its grant's role, and closed when the grant is taken back or runs
 * out; an agent's tile's token is that agent, served the workspace its tile is in at the role
 * `agents`, while its tile is there. Lines of JSON both ways: calls, notices and events as the workspace API's stream carries
 * them. 0600, a named pipe on Windows. Electron-free.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { servePeer } from "@hivemind/workspace-api/peers";
import type { Connection, WorkspaceServer } from "@hivemind/workspace-api/server";
import { ApiError, type ErrorCode, type EventMessage } from "@hivemind/workspace-api/protocol";
import { holderOf } from "@hivemind/agent-host/hooks/token";
import { listenExclusive } from "@hivemind/agent-host/socket-claim";
import { toBareId } from "@hivemind/workspace-api/tile-id";
import type { Actor } from "@hivemind/workspace-host/intents";
import { takeLines } from "./control/protocol.js";
import type { Grants } from "./grants.js";

/** The workspace API version the drive socket speaks. */
export const DRIVE_API = "0.32";
/** How long a connection may take to say who it is. */
const HELLO_WITHIN_MS = 10_000;
/** What may wait unread for a connection before it is closed: a program that stopped reading. */
const UNREAD_MAX = 16 * 1024 * 1024;

export interface DriveOptions {
  server: Pick<WorkspaceServer, "connect" | "answer" | "notice">;
  /** The install's token: whoever holds it is the person. */
  installToken(): string;
  grants: Grants;
  /** The workspaces here, by their folder. */
  repos(): string[];
  /** The workspace a tile is in, by its folder: null when it is in none here. */
  workspaceOf(tile: string): string | null;
  /** What the control plane calls a tile. */
  nameOf(tile: string): string;
  /** The folders of the workspace at `repo` besides it: its frames' worktrees. */
  places?(repo: string): string[];
  /** The workspace's id, once it has one. */
  workspaceId?(repo: string): string | null;
  onWarn?(message: string): void;
}

export interface DriveServer {
  /** Whether this process serves the socket: false when another app or host on the machine does. */
  serving: Promise<boolean>;
  close(): void;
}

type Hello = { token?: unknown; workspace?: unknown };

/** A folder as it is on disk, links followed; as given when it is not there. */
function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export function serveDrive(sockPath: string, o: DriveOptions): DriveServer {
  /** Each program's open sockets, by its grant. */
  const byGrant = new Map<string, Set<net.Socket>>();
  const offRevoked = o.grants.onRevoked((id) => {
    for (const socket of byGrant.get(id) ?? []) socket.destroy();
  });

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    const write = (line: string): void => {
      if (socket.destroyed) return;
      socket.write(`${line}\n`);
      if (socket.writableLength > UNREAD_MAX) socket.destroy();
    };
    let refused = false;
    // Said why, and closed both ways once said: nothing it sends after is read.
    const refuse = (code: string, message: string): void => {
      refused = true;
      write(JSON.stringify({ error: { code, message } }));
      socket.end(() => socket.destroy());
    };
    const listeners = new Set<(text: string) => void>();
    let closedResolve!: () => void;
    const closed = new Promise<void>((resolve) => (closedResolve = resolve));
    let helloed = false;
    let buf = "";
    const helloTimer = setTimeout(() => { if (!helloed) refuse("BAD_REQUEST", "say hello first: {\"hello\": {\"token\": …}}"); }, HELLO_WITHIN_MS);

    socket.on("data", (chunk: string) => {
      if (refused) return;
      buf += chunk;
      let lines: string[];
      try {
        ({ lines, rest: buf } = takeLines(buf));
      } catch {
        socket.destroy();
        return;
      }
      for (const line of lines) {
        if (!line.trim()) continue;
        if (helloed) {
          for (const l of listeners) l(line);
          continue;
        }
        helloed = true;
        clearTimeout(helloTimer);
        let hello: Hello | undefined;
        try {
          hello = (JSON.parse(line) as { hello?: Hello }).hello;
        } catch { /* refused below */ }
        if (!hello) return refuse("BAD_REQUEST", "the first line is {\"hello\": {\"token\": …, \"workspace\"?: …}}");
        welcome(hello);
      }
    });
    socket.on("close", () => { clearTimeout(helloTimer); closedResolve(); });
    socket.on("error", () => { /* gone; close follows */ });

    const channel = {
      send: write,
      on: (listener: (text: string) => void) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      closed,
    };

    function welcome(hello: Hello): void {
      const holder = holderOf(o.installToken(), hello.token);
      if (holder && "person" in holder) return asPerson();
      if (holder) return asAgent(toBareId(holder.tile), hello);
      const grant = o.grants.holder(hello.token);
      if (!grant) return refuse("FORBIDDEN", "that token lets nothing drive here: make a grant with `hive grant create`");
      // A grant that reaches one workspace needs it named no more than an agent does.
      const named = typeof hello.workspace === "string" && hello.workspace ? hello.workspace : grant.repos.length === 1 ? grant.repos[0]! : null;
      if (!named) return refuse("BAD_REQUEST", "name the workspace: {\"hello\": {\"token\": …, \"workspace\": \"<its folder>\"}}");
      const asked = real(named);
      if (!grant.repos.includes(asked)) return refuse("FORBIDDEN", `grant ${grant.name} does not reach ${named}`);
      const repo = o.repos().find((r) => real(r) === asked);
      if (!repo) return refuse("BAD_REQUEST", `no workspace is open at ${named}: open it in the app first`);
      let sockets = byGrant.get(grant.id);
      if (!sockets) byGrant.set(grant.id, (sockets = new Set()));
      sockets.add(socket);
      socket.on("close", () => { sockets!.delete(socket); if (sockets!.size === 0) byGrant.delete(grant.id); });
      if (grant.expires !== null) {
        // A timer waits at most 2^31-1 ms (about 24.8 days); a longer one fires at once.
        const expires = grant.expires;
        let ends: ReturnType<typeof setTimeout>;
        const wait = () => {
          const left = expires - Date.now();
          ends = left > 0 ? setTimeout(wait, Math.min(left, 2 ** 31 - 1)) : setTimeout(() => socket.destroy(), 0);
        };
        wait();
        socket.on("close", () => clearTimeout(ends));
      }
      o.grants.used(grant.id);
      write(JSON.stringify({ hello: { api: DRIVE_API, as: { client: grant.name, role: grant.role, workspace: repo } } }));
      serve(repo, { kind: "peer", person: `client:${grant.id}`, device: `client:${grant.id}`, access: grant.role, client: grant.name }, () => o.grants.live(grant.id));
    }

    // An agent drives the workspace its tile is in, and starts, and supervises, as itself.
    function asAgent(tile: string, hello: Hello): void {
      const repo = o.workspaceOf(tile);
      if (repo === null) return refuse("FORBIDDEN", "that agent's tile is in no workspace here");
      if (hello.workspace != null && real(String(hello.workspace)) !== real(repo)) return refuse("FORBIDDEN", `an agent drives the workspace its tile is in, ${repo}`);
      write(JSON.stringify({ hello: { api: DRIVE_API, as: { agent: tile, role: "agents", workspace: repo } } }));
      serve(repo, { kind: "peer", person: tile, device: tile, access: "agents", client: o.nameOf(tile), tile }, () => o.workspaceOf(tile) === repo);
    }

    function serve(repo: string, actor: Extract<Actor, { kind: "peer" }>, allows: () => boolean): void {
      servePeer(o.server, channel, {
        actor,
        workspace: o.workspaceId?.(repo) ?? repo,
        repo,
        url: repo,
        holds: (tile) => o.workspaceOf(toBareId(tile)) === repo,
        places: () => o.places?.(repo) ?? [],
        allows,
      });
    }

    function asPerson(): void {
      const gone = new AbortController();
      void closed.then(() => gone.abort());
      const connection: Connection = {
        actor: { kind: "person" },
        send: (event: EventMessage) => write(JSON.stringify(event)),
        closed: gone.signal,
      };
      o.server.connect(connection);
      write(JSON.stringify({ hello: { api: DRIVE_API, as: "person" } }));
      listeners.add((text) => {
        let m: { id?: unknown; method?: unknown; params?: unknown };
        try {
          m = JSON.parse(text) as typeof m;
        } catch {
          return;
        }
        if (typeof m.id !== "number") return o.server.notice(m.method, m.params ?? [], connection);
        const id = m.id;
        void o.server.answer(m.method, m.params ?? [], connection).then((answer) => write(JSON.stringify({ id, ...answer })));
      });
    }
  });

  // The app and `hive host` on one machine: whichever came first serves it, and the other says so.
  let mine = false;
  const serving = listenExclusive(server, sockPath).then((r) => {
    if (r === "taken") {
      o.onWarn?.(`programs drive this machine through another app or host already (${sockPath})`);
      return false;
    }
    mine = true;
    try { fs.chmodSync(sockPath, 0o600); } catch { /* a named pipe */ }
    return true;
  }, (e: Error) => {
    o.onWarn?.(`drive socket: ${e.message}`);
    return false;
  });
  return {
    serving,
    close: () => {
      offRevoked();
      try { server.close(); } catch { /* closed */ }
      if (mine) try { fs.unlinkSync(sockPath); } catch { /* gone */ }
    },
  };
}

/** `method` answered on the drive socket at `sockPath` as whoever `token` is: what another
 *  process on this machine, the one serving it, answers. */
export function askDrive(sockPath: string, token: string, method: string, params: unknown[], timeoutMs = 10_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(sockPath);
    socket.setEncoding("utf8");
    let settled = false;
    const done = (fail: ApiError | null, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (fail) reject(fail);
      else resolve(value);
    };
    const nobody = () => done(new ApiError("UNAVAILABLE", "nothing serves programs on this machine now: start the app or `hive host` again"));
    const timer = setTimeout(nobody, timeoutMs);
    socket.on("connect", () => socket.write(`${JSON.stringify({ hello: { token } })}\n`));
    socket.on("error", nobody);
    socket.on("close", nobody);
    let buf = "";
    socket.on("data", (chunk: string) => {
      buf += chunk;
      for (let nl; (nl = buf.indexOf("\n")) >= 0; ) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let m: { hello?: unknown; id?: unknown; result?: unknown; error?: { code?: string; message?: string } };
        try {
          m = JSON.parse(line) as typeof m;
        } catch {
          continue;
        }
        if (m.hello) socket.write(`${JSON.stringify({ id: 1, method, params })}\n`);
        else if (m.error && m.id === undefined) done(new ApiError((m.error.code ?? "FAILED") as ErrorCode, m.error.message ?? "refused"));
        else if (m.id === 1) done(m.error ? new ApiError((m.error.code ?? "FAILED") as ErrorCode, m.error.message ?? "refused") : null, m.result);
      }
    });
  });
}
