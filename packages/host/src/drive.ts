/**
 * The drive socket (spec/workspace-api.md "Drive socket"): the workspace API for programs on this
 * machine, `hive ctl` among them. A connection's first line says who it is: the install's token
 * is the person, answered as a window of theirs is; a grant's token is a program, served one
 * workspace like a guest, at its grant's role, and closed when the grant is taken back or runs
 * out. Lines of JSON both ways: calls, notices and events as the workspace API's stream carries
 * them. 0600, a named pipe on Windows. Electron-free.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { servePeer } from "@hivemind/workspace-api/peers";
import type { Connection, WorkspaceServer } from "@hivemind/workspace-api/server";
import type { EventMessage } from "@hivemind/workspace-api/protocol";
import { holderOf } from "@hivemind/agent-host/hooks/token";
import { listenExclusive } from "@hivemind/agent-host/socket-claim";
import { takeLines } from "./control/protocol.js";
import type { Grants } from "./grants.js";

/** The workspace API version the drive socket speaks. */
export const DRIVE_API = "0.21";
/** How long a connection may take to say who it is. */
const HELLO_WITHIN_MS = 10_000;

export interface DriveOptions {
  server: Pick<WorkspaceServer, "connect" | "answer" | "notice">;
  /** The install's token: whoever holds it is the person. */
  installToken(): string;
  grants: Grants;
  /** The workspaces here, by their folder. */
  repos(): string[];
  /** Whether a tile is in the workspace at `repo`. */
  holds(repo: string, tile: string): boolean;
  /** The folders of the workspace at `repo` besides it: its frames' worktrees. */
  places?(repo: string): string[];
  /** The workspace's id, once it has one. */
  workspaceId?(repo: string): string | null;
  onWarn?(message: string): void;
}

export interface DriveServer {
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
    const write = (line: string): void => { if (!socket.destroyed) socket.write(`${line}\n`); };
    const refuse = (code: string, message: string): void => {
      write(JSON.stringify({ error: { code, message } }));
      socket.end();
    };
    const listeners = new Set<(text: string) => void>();
    let closedResolve!: () => void;
    const closed = new Promise<void>((resolve) => (closedResolve = resolve));
    let helloed = false;
    let buf = "";
    const helloTimer = setTimeout(() => { if (!helloed) refuse("BAD_REQUEST", "say hello first: {\"hello\": {\"token\": …}}"); }, HELLO_WITHIN_MS);

    socket.on("data", (chunk: string) => {
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
      if (holder) return refuse("FORBIDDEN", "an agent drives its workspace with `hive ctl`, not on this socket");
      const grant = o.grants.holder(hello.token);
      if (!grant) return refuse("FORBIDDEN", "that token lets nothing drive here: make a grant with `hive grant create`");
      if (typeof hello.workspace !== "string" || !hello.workspace) return refuse("BAD_REQUEST", "name the workspace: {\"hello\": {\"token\": …, \"workspace\": \"<its folder>\"}}");
      const asked = real(hello.workspace);
      if (!grant.repos.includes(asked)) return refuse("FORBIDDEN", `grant ${grant.name} does not reach ${hello.workspace}`);
      const repo = o.repos().find((r) => real(r) === asked);
      if (!repo) return refuse("BAD_REQUEST", `no workspace is open at ${hello.workspace}: open it in the app first`);
      let sockets = byGrant.get(grant.id);
      if (!sockets) byGrant.set(grant.id, (sockets = new Set()));
      sockets.add(socket);
      socket.on("close", () => { sockets!.delete(socket); if (sockets!.size === 0) byGrant.delete(grant.id); });
      if (grant.expires !== null) {
        const ends = setTimeout(() => socket.destroy(), Math.max(0, grant.expires - Date.now()));
        socket.on("close", () => clearTimeout(ends));
      }
      o.grants.used(grant.id);
      write(JSON.stringify({ hello: { api: DRIVE_API, as: { client: grant.name, role: grant.role, workspace: repo } } }));
      servePeer(o.server, channel, {
        actor: { kind: "peer", person: `client:${grant.id}`, device: `client:${grant.id}`, access: grant.role, client: grant.name },
        workspace: o.workspaceId?.(repo) ?? repo,
        repo,
        url: repo,
        holds: (tile) => o.holds(repo, tile),
        places: () => o.places?.(repo) ?? [],
        allows: () => o.grants.live(grant.id),
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
  void listenExclusive(server, sockPath).then((r) => {
    if (r === "taken") return o.onWarn?.(`programs drive this machine through another app or host already (${sockPath})`);
    mine = true;
    try { fs.chmodSync(sockPath, 0o600); } catch { /* a named pipe */ }
  }, (e: Error) => o.onWarn?.(`drive socket: ${e.message}`));
  return {
    close: () => {
      offRevoked();
      try { server.close(); } catch { /* closed */ }
      if (mine) try { fs.unlinkSync(sockPath); } catch { /* gone */ }
    },
  };
}
