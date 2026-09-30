/**
 * Terminals on a workspace's host (the workspace API's `terminal.*`). Each client connected is a
 * viewer of the sessions it shows (`SessionRelay`, R5): a session is started once, by the first
 * client to open it, and every client that shows it is sent its output (`terminal.data`) and its
 * exit (`terminal.exit`). A client that goes lets go of the sessions it showed, and a session
 * nobody shows any more is let go of (a daemon keeps it running). How a session runs, in a daemon,
 * in this process or over ssh, is the host's (`SessionBackend`). Electron-free: main and the
 * dev-bridge each build one over their own backend.
 *
 * A keystroke, a resize, flow control and whether a client shows a session are notices. While
 * several clients show a session, the one that typed last sizes it (the last to type wins, until
 * R4 gives a terminal one keyboard at a time). A pause is a short lease: see PAUSE_MAX_MS.
 *
 * Starting a session is the intent of whoever opens it, unless the host asked for it itself (a
 * control-plane spawn) or the client only shows one the host holds; ending one is the intent of
 * whoever closes it, unless it had already ended (a close that follows another's).
 */
import path from "node:path";
import { SessionRelay, type ReadScreen, type SessionRelayOptions, type Viewer } from "@hivemind/agent-host/session-relay";
import type { Intents } from "@hivemind/workspace-host/intents";
import { fields, flag, text, texts, whole, written } from "@hivemind/workspace-api/protocol";
import { emit, named, type Connection, type Domain } from "@hivemind/workspace-api/server";
import type { TerminalOpts } from "@hivemind/workspace-api/terminals";
import { toBareId } from "../../shared/tile-id.js";

/** Where a session's output and exit go, as its backend runs it. */
export interface SessionOutput {
  /** `replay`: a redraw of output already seen, not new output. */
  data(data: string, replay?: boolean): void;
  exit(code: number, signal?: number): void;
}

/** How the host runs a session. */
export interface SessionBackend {
  /** Start `opts`' session, or attach to the one the host holds, its output and exit to `out`.
   *  The host's own checks and additions happen here: it throws to refuse. */
  start(opts: TerminalOpts, out: SessionOutput): Promise<{ pid: number }>;
  write(tile: string, data: string, paste?: boolean): void;
  /** Whether a keystroke's echo comes straight back (a session on this machine), so skips the
   *  batching. */
  echoes(tile: string): boolean;
  resize(tile: string, cols: number, rows: number): void;
  pause(tile: string): void;
  resume(tile: string): void;
  /** End the session for good, and the host's own teardown for it. */
  kill(tile: string): void;
  /** Nobody shows it any more: a daemon keeps it; a session in this process ends. */
  detach(tile: string): void;
  /** The host's screen of it, read in order with its output; null when it keeps none. */
  screen(tile: string): ReadScreen | null;
}

export interface TerminalsOptions {
  backend: SessionBackend;
  intents: Pick<Intents, "perform">;
  relay: SessionRelayOptions;
  /** Whether the host asked for this session itself (a control-plane spawn), so starting it is
   *  not the opener's intent. Asked once per start. */
  askedByHost?(bareTile: string): boolean;
  /** The terminals whose activity a client wants. */
  watchActivity?(tiles: string[]): void;
  /** An end that failed, which no client is told of. */
  onError?(message: string): void;
}

/** A pause is a short lease, not a latch: a session paused when its program exits would lose
 *  its last bytes (node-pty drops a paused socket's output 200 ms after the exit), so every pause
 *  ends on its own after this long, and a client still behind asks again with each batch. */
export const PAUSE_MAX_MS = 120;
/** Sessions ended are remembered so a close that follows is not an intent; ids never repeat. */
const ENDED_KEPT = 512;

type TerminalMethod = "terminal.open";
type TerminalNotice =
  | "terminal.write" | "terminal.show" | "terminal.resize" | "terminal.flow"
  | "terminal.close" | "terminal.detach" | "terminal.watchActivity";

export class Terminals {
  readonly domain: Domain<TerminalMethod, TerminalNotice>;
  private readonly relay: SessionRelay;
  private readonly viewers = new WeakMap<Connection, Viewer>();
  /** The client that last typed into each session. */
  private readonly typers = new Map<string, Connection>();
  private readonly pauses = new Map<string, ReturnType<typeof setTimeout>>();
  /** Sessions ended here, the latest last. */
  private readonly ended = new Set<string>();

  constructor(private readonly opts: TerminalsOptions) {
    this.relay = new SessionRelay(opts.relay);
    const tileOf = (v: unknown) => text(v, "tile");
    this.domain = {
      answers: {
        "terminal.open": (from, opts) => this.open(optsOf(opts), from),
      },
      effects: {},
      notices: {
        "terminal.write": (from, tile, data, paste) => this.write(tileOf(tile), written(data, "data"), flag(paste, "paste"), from),
        "terminal.show": (from, tile, shown) => {
          const t = tileOf(tile);
          this.relay.show(t, this.viewerOf(from), flag(shown, "shown") === true, opts.backend.screen(t));
        },
        "terminal.resize": (from, tile, cols, rows) => this.resize(tileOf(tile), whole(cols, "cols", 1), whole(rows, "rows", 1), from),
        "terminal.flow": (_, tile, paused) => this.flow(tileOf(tile), flag(paused, "paused") === true),
        "terminal.close": (from, tile) => this.close(tileOf(tile), from),
        "terminal.detach": (from, tile) => {
          const t = tileOf(tile);
          if (this.relay.leave(t, this.viewerOf(from)) === 0) this.letGo(t);
        },
        "terminal.watchActivity": (_, tiles) => opts.watchActivity?.(texts(tiles, "tiles").slice(0, 1024)),
      },
      gone: (connection) => {
        const viewer = this.viewers.get(connection);
        if (!viewer) return;
        for (const tile of this.relay.leaveAll(viewer)) this.letGo(tile);
        for (const [tile, typer] of this.typers) if (typer === connection) this.typers.delete(tile);
      },
    };
  }

  /** End a session for good, as the host asks (the control plane closing its tile). */
  end(tile: string): void {
    const bare = toBareId(tile);
    this.ended.delete(bare);
    this.ended.add(bare);
    if (this.ended.size > ENDED_KEPT) this.ended.delete(this.ended.values().next().value!);
    this.drop(tile);
    this.opts.backend.kill(tile);
  }

  private open(opts: TerminalOpts, from: Connection): Promise<{ pid: number; joined: boolean }> {
    const tile = opts.tileId;
    const bare = toBareId(tile);
    const out: SessionOutput = {
      data: (data) => this.relay.push(tile, data),
      exit: (code, signal) => this.relay.exit(tile, { code, signal }),
    };
    const run = () => this.opts.backend.start(opts, out);
    const start = () => opts.attachOnly || this.opts.askedByHost?.(bare)
      ? run()
      : this.opts.intents.perform(from.actor, { verb: "terminal.open", target: bare, detail: named(path.basename(opts.cmd)) }, run);
    return this.relay.open(tile, this.viewerOf(from), start, () => this.opts.backend.screen(tile));
  }

  private write(tile: string, data: string, paste: boolean | undefined, from: Connection): void {
    this.typers.set(tile, from);
    if (this.opts.backend.echoes(tile)) this.relay.markInput(tile);
    this.opts.backend.write(tile, data, paste);
  }

  private resize(tile: string, cols: number, rows: number, from: Connection): void {
    const typer = this.typers.get(tile);
    if (typer !== undefined && typer !== from && this.relay.count(tile) > 1) return;
    this.opts.backend.resize(tile, cols, rows);
  }

  private flow(tile: string, paused: boolean): void {
    const lease = this.pauses.get(tile);
    if (lease) { clearTimeout(lease); this.pauses.delete(tile); }
    if (!paused) return this.opts.backend.resume(tile);
    this.opts.backend.pause(tile);
    this.pauses.set(tile, setTimeout(() => {
      this.pauses.delete(tile);
      this.opts.backend.resume(tile);
    }, PAUSE_MAX_MS));
  }

  /** A client closed the terminal. After another's end (another client's, the control plane's)
   *  it follows that end, which is no intent of its own. */
  private close(tile: string, from: Connection): void {
    const bare = toBareId(tile);
    if (this.ended.has(bare)) return this.end(tile);
    void this.opts.intents.perform(from.actor, { verb: "terminal.close", target: bare }, () => this.end(tile))
      .catch((e: unknown) => this.opts.onError?.(`terminal.close ${bare}: ${e instanceof Error ? e.message : String(e)}`));
  }

  /** Nobody shows the session: let go of it. */
  private letGo(tile: string): void {
    this.drop(tile);
    this.opts.backend.detach(tile);
  }

  private drop(tile: string): void {
    this.relay.forget(tile);
    this.typers.delete(tile);
    const lease = this.pauses.get(tile);
    if (lease) { clearTimeout(lease); this.pauses.delete(tile); }
  }

  /** A client, as a viewer of the sessions it shows. */
  private viewerOf(connection: Connection): Viewer {
    let viewer = this.viewers.get(connection);
    if (!viewer) {
      viewer = {
        data: (tile, data) => emit(connection, "terminal.data", tile, data),
        exit: (tile, info) => emit(connection, "terminal.exit", tile, info),
        alive: () => !connection.closed.aborted,
      };
      this.viewers.set(connection, viewer);
    }
    return viewer;
  }
}

/** What `terminal.open` is asked, checked. */
function optsOf(value: unknown): TerminalOpts {
  const o = fields(value, "opts");
  const env = o.env == null ? undefined : fields(o.env, "opts.env");
  if (env) for (const [k, v] of Object.entries(env)) written(v, `opts.env.${k}`);
  return {
    tileId: text(o.tileId, "opts.tileId"),
    cwd: text(o.cwd, "opts.cwd"),
    cmd: written(o.cmd, "opts.cmd"),
    ...(o.args == null ? {} : { args: texts(o.args, "opts.args") }),
    cols: whole(o.cols, "opts.cols", 1),
    rows: whole(o.rows, "opts.rows", 1),
    ...(env ? { env: env as Record<string, string> } : {}),
    ...(o.initialPrompt == null ? {} : { initialPrompt: written(o.initialPrompt, "opts.initialPrompt") }),
    ...(o.attachOnly == null ? {} : { attachOnly: flag(o.attachOnly, "opts.attachOnly") }),
    ...(o.liveOnly == null ? {} : { liveOnly: flag(o.liveOnly, "opts.liveOnly") }),
  };
}
