/**
 * A program's handle on one workspace through the drive socket: any method by name, typed where
 * the workspace API names it, and the common jobs (agents, frames, terminals) with the workspace's
 * folder filled in.
 */
import { ApiError } from "@hivemind/workspace-api/protocol";
import type { Event, EventParams, Method, Notice, NoticeParams, Params, Result } from "@hivemind/workspace-api/methods";
import type { AgentAnswer, StartAgent } from "@hivemind/workspace-api/agents";
import type { FrameClose, FrameSpec } from "@hivemind/workspace-api/frames";
import { openConnection, type CallOptions, type Connection, type Identity } from "./connection.js";
import { defaultToken, defaultWorkspace, driveSocketPath } from "./places.js";

export interface ConnectOptions {
  /** Who this is (default: `HCP_TOKEN`, `HIVE_DRIVE_TOKEN`, else the person's token on this machine). */
  token?: string;
  /** The workspace's folder, for a grant that reaches several (default: `HIVE_WORKSPACE`). */
  workspace?: string;
  /** The drive socket (default: `HIVE_DRIVE_SOCK`, else the app's on this machine). */
  socket?: string;
}

/** How long an `agent.read` call may take past the wait it asks for. */
const READ_MARGIN_MS = 10_000;

/** Connect to the drive socket and say hello: the client, once the host says who this is. */
export async function connect(options: ConnectOptions = {}): Promise<HiveClient> {
  const workspace = options.workspace ?? defaultWorkspace();
  const connection = await openConnection(options.socket ?? driveSocketPath(), { token: options.token ?? defaultToken(), workspace });
  return new HiveClient(connection, workspace);
}

export class HiveClient {
  /** Who the host says this is. */
  readonly as: Identity;
  /** The workspace API version the host speaks. */
  readonly api: string;
  /** The workspace's folder: the one a grant or an agent drives, else the one named on connect. */
  readonly workspace: string | null;
  /** Resolves when the connection closes, from either end. */
  readonly closed: Promise<void>;

  constructor(private readonly connection: Connection, named?: string) {
    this.as = connection.as;
    this.api = connection.api;
    this.closed = connection.closed;
    this.workspace = connection.as === "person" ? named ?? null : connection.as.workspace;
  }

  /** Call any method; its answer, or an `ApiError` with the host's code. */
  call<M extends Method>(method: M, params: Params<M>, options?: CallOptions): Promise<Result<M>>;
  call(method: string, params?: unknown[], options?: CallOptions): Promise<unknown>;
  call(method: string, params: unknown[] = [], options?: CallOptions): Promise<unknown> {
    return this.connection.call(method, params, options);
  }

  /** Tell the host something it does not answer (a keystroke, a resize). */
  notice<N extends Notice>(method: N, params: NoticeParams<N>): void;
  notice(method: string, params?: unknown[]): void;
  notice(method: string, params: unknown[] = []): void {
    this.connection.notice(method, params);
  }

  /** Hear `event` until the returned function is called. */
  on<E extends Event>(event: E, listener: (...params: EventParams<E>) => void): () => void;
  on(event: string, listener: (...params: unknown[]) => void): () => void;
  on(event: string, listener: (...params: never[]) => void): () => void {
    return this.connection.on(event, listener as (...params: unknown[]) => void);
  }

  close(): void {
    this.connection.close();
  }

  private folder(): string {
    if (this.workspace === null) throw new ApiError("BAD_REQUEST", "name the workspace: connect({ workspace: \"<its folder>\" }) or HIVE_WORKSPACE");
    return this.workspace;
  }

  readonly agents = {
    /** The workspace's agents as they are now, and the feed's position (`seq`). */
    list: () => this.call("agent.list", [this.folder()]),
    /** Each change and event after `seq`; null when the host no longer has them all: list again. */
    since: (seq: number) => this.call("agent.since", [this.folder(), seq]),
    /** Start an agent, as the person does at their desktop: its tile. */
    start: (start: StartAgent) => this.call("agent.start", [this.folder(), start]),
    /** Its reply at the end of its next turn, waiting up to `timeoutMs` (0: what is there now). */
    read: (tile: string, { timeoutMs = 120_000 }: { timeoutMs?: number } = {}) =>
      this.call("agent.read", [tile, timeoutMs], { timeoutMs: timeoutMs + READ_MARGIN_MS }),
    /** A message for it, typed in as its next prompt once it is at its prompt. */
    send: (tile: string, text: string) => this.call("agent.send", [tile, text]),
    /** Answer what it waits on, the wait that began at `since` (its `waiting.since`). */
    answer: (tile: string, since: number, answer: AgentAnswer) => this.call("agent.answer", [tile, since, answer]),
    /** The last `lines` lines it printed. */
    output: (tile: string, lines?: number) => this.call("agent.output", lines === undefined ? [tile] : [tile, lines]),
    interrupt: (tile: string) => this.call("agent.interrupt", [tile]),
    close: (tile: string) => this.call("agent.close", [tile]),
  };

  readonly frames = {
    /** A frame bound to a folder of the workspace, or to a worktree on a branch; made when there is none. */
    open: (spec: FrameSpec) => this.call("frame.open", [this.folder(), spec]),
    close: (frame: string, options?: FrameClose) => this.call("frame.close", options ? [this.folder(), frame, options] : [this.folder(), frame]),
  };

  readonly terminals = {
    /** Type into a terminal (`paste`: hand it over as one block); needs the role `terminals`. */
    write: (tile: string, data: string, { paste }: { paste?: boolean } = {}) =>
      this.notice("terminal.write", paste === undefined ? [tile, data] : [tile, data, paste]),
    /** End its session for good; needs the role `agents`. */
    close: (tile: string) => this.notice("terminal.close", [tile]),
  };
}
