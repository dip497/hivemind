/**
 * Terminals on a workspace's host (the workspace API's `terminal.*`). Each client connected is a
 * viewer of the sessions it shows (`SessionRelay`, R5): a session is started once, by the first
 * client to open it, and every client that shows it is sent its output (`terminal.data`) and its
 * exit (`terminal.exit`). A client that goes lets go of the sessions it showed, and a session
 * nobody shows any more is let go of (a daemon keeps it running). How a session runs, in a daemon,
 * in this process or over ssh, is the host's (`SessionBackend`). Electron-free: main and the
 * dev-bridge each build one over their own backend.
 *
 * A keystroke, a resize, flow control and whether a client shows a session are notices. Who may
 * type is the terminal's keyboard's (`keyboard.ts`, M2): the host's windows until it is given to
 * a guest, and then the guest's alone. Among the host's windows the one that typed last sizes a
 * session; a guest holding its keyboard sizes it. Every client is told a session's size when it
 * changes, so one whose own differs draws it at that size. A pause is a short lease: see
 * PAUSE_MAX_MS. Whoever types is named to the others showing the session (`terminal.typing`,
 * R4), and a guest's typing is marked in the audit log once a burst (never what was typed). A
 * session on a participant's machine (M4) is typed into and sized there, by its person
 * (`machineOf`): nobody here types into it, and its size is the one that machine says.
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
import type { TerminalOpts, Typist } from "@hivemind/workspace-api/terminals";
import type { EventParams } from "@hivemind/workspace-api/methods";
import { toBareId } from "@hivemind/workspace-api/tile-id";
import { Keyboards, isHost } from "./keyboard.js";

/** Where a session's output and exit go, as its backend runs it. */
export interface SessionOutput {
  /** `replay`: a redraw of output already seen, not new output. */
  data(data: string, replay?: boolean): void;
  exit(code: number, signal?: number): void;
  /** Its size, as where it runs says it: a session on a participant's machine (M4) is sized there. */
  size?(cols: number, rows: number): void;
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
  /** Tell every client (who holds a keyboard, a session's size). */
  publish?<E extends "terminal.keyboard" | "terminal.size">(event: E, ...params: EventParams<E>): void;
  /** Who is at a client, for the keyboard's holder and whoever asks for it. */
  who?(connection: Connection): { person: string; name: string };
  /** Whose machine a session runs on, when it is a participant's (M4): its person types into it
   *  there and sizes it, and nobody here types into it until they lend its keyboard. Null: it runs
   *  where the host runs it. Asked as it opens. */
  machineOf?(opts: TerminalOpts): TerminalMachine | null;
}

/** A participant's machine a session runs on (M4): whose it is, and whether they lend its keyboard
 *  now (they grant typing there). */
export interface TerminalMachine {
  who: Typist;
  lends(): boolean;
}

/** A pause is a short lease, not a latch: a session paused when its program exits would lose
 *  its last bytes (node-pty drops a paused socket's output 200 ms after the exit), so every pause
 *  ends on its own after this long, and a client still behind asks again with each batch. */
export const PAUSE_MAX_MS = 120;
/** Sessions ended are remembered so a close that follows is not an intent; ids never repeat. */
const ENDED_KEPT = 512;
/** While someone keeps typing into a session, the others are told again this often. */
export const TYPING_EVERY_MS = 1000;
/** A guest's typing into a session is marked in the audit log again after this long without it. */
export const TYPED_BURST_MS = 60_000;

type TerminalMethod = "terminal.open";
type TerminalNotice =
  | "terminal.write" | "terminal.show" | "terminal.resize" | "terminal.flow"
  | "terminal.close" | "terminal.detach" | "terminal.watchActivity"
  | "terminal.keyboard.ask" | "terminal.keyboard.give" | "terminal.keyboard.take";

export class Terminals {
  readonly domain: Domain<TerminalMethod, TerminalNotice>;
  private readonly relay: SessionRelay;
  private readonly viewers = new WeakMap<Connection, Viewer>();
  /** The client that last typed into each session. */
  private readonly typers = new Map<string, Connection>();
  /** Who the others were last told types into each session, and when. */
  private readonly typing = new Map<string, { by: Connection; at: number }>();
  /** When each guest last typed into each session, for the audit log's marks. */
  private readonly typed = new WeakMap<Connection, Map<string, number>>();
  private readonly pauses = new Map<string, ReturnType<typeof setTimeout>>();
  /** Sessions ended here, the latest last. */
  private readonly ended = new Set<string>();
  /** The clients that opened each session. */
  private readonly openers = new Map<string, Set<Connection>>();
  /** Each session's size, as last given: whoever opens it is told. */
  private readonly sizes = new Map<string, { cols: number; rows: number }>();
  /** The sessions that run on a participant's machine (M4), and whose it is. */
  private readonly machines = new Map<string, TerminalMachine>();
  private readonly keyboards: Keyboards;

  constructor(private readonly opts: TerminalsOptions) {
    this.relay = new SessionRelay(opts.relay);
    this.keyboards = new Keyboards({
      publish: (event, ...params) => opts.publish?.(event, ...params),
      tell: (to, event, ...params) => emit(to, event, ...params),
      who: (c) => opts.who?.(c) ?? { person: "", name: "" },
      hostWindows: (tile) => [...(this.openers.get(tile) ?? [])].filter((c) => isHost(c) && !c.closed.aborted),
      elsewhere: (tile) => {
        const machine = this.machines.get(tile);
        return machine ? { who: machine.who, lends: machine.lends() } : null;
      },
    });
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
        "terminal.keyboard.ask": (from, tile) => this.keyboards.ask(tileOf(tile), from),
        "terminal.keyboard.give": (from, tile, to) => this.keyboards.give(tileOf(tile), from, text(to, "to")),
        "terminal.keyboard.take": (from, tile) => this.keyboards.take(tileOf(tile), from),
      },
      gone: (connection) => {
        this.keyboards.gone(connection);
        for (const opened of this.openers.values()) opened.delete(connection);
        const viewer = this.viewers.get(connection);
        if (!viewer) return;
        for (const tile of this.relay.leaveAll(viewer)) this.letGo(tile);
        for (const [tile, typer] of this.typers) if (typer === connection) this.typers.delete(tile);
        for (const [tile, told] of this.typing) if (told.by === connection) this.typing.delete(tile);
      },
    };
  }

  /**
   * Start a session the host asked for itself (a control-plane spawn on a host with no window),
   * watched by the host from its first byte: its output is recorded whoever shows it, it runs on
   * while nobody does, and a client that opens it joins it. `watch` hears its output, a batch at a
   * time, and its end.
   */
  async own(opts: TerminalOpts, watch: { data(data: string): void; exit(): void }): Promise<{ pid: number }> {
    const tile = opts.tileId;
    const out = this.outputOf(tile);
    const host: Viewer = { data: (_, data) => watch.data(data), exit: () => watch.exit(), alive: () => true };
    if (!this.sizes.has(tile)) this.sizes.set(tile, { cols: opts.cols, rows: opts.rows });
    const { pid } = await this.relay.open(tile, host, () => this.opts.backend.start(opts, out), () => this.opts.backend.screen(tile));
    return { pid };
  }

  /** The participant `who` (`peer:<device>`) lends their machine's keyboards, or keeps them, from
   *  now on (M4): whoever holds one there gives it up, and everyone is told who holds each now. */
  machineChanged(who: string): void {
    for (const [tile, machine] of this.machines) {
      if (machine.who.id !== who) continue;
      this.keyboards.forget(tile);
      this.opts.publish?.("terminal.keyboard", tile, this.keyboards.holder(tile));
    }
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
    const out = this.outputOf(tile);
    const run = () => this.opts.backend.start(opts, out);
    const start = () => opts.attachOnly || this.opts.askedByHost?.(bare)
      ? run()
      : this.opts.intents.perform(from.actor, { verb: "terminal.open", target: bare, detail: named(path.basename(opts.cmd)) }, run);
    let opened = this.openers.get(tile);
    if (!opened) this.openers.set(tile, (opened = new Set()));
    opened.add(from);
    // On a participant's machine, its keyboard and its size are theirs.
    const machine = this.machines.get(tile) ?? this.opts.machineOf?.(opts) ?? null;
    if (machine) this.machines.set(tile, machine);
    // A session the host starts takes the size it is opened at, until someone sizes it.
    else if (!this.sizes.has(tile) && isHost(from) && !opts.attachOnly) this.sizes.set(tile, { cols: opts.cols, rows: opts.rows });
    // Whoever opens it is told who holds its keyboard (null: the host), which it may have missed
    // while away, and its size.
    const holder = this.keyboards.holder(tile);
    emit(from, "terminal.keyboard", tile, holder);
    const size = this.sizes.get(tile);
    if (size) emit(from, "terminal.size", tile, size.cols, size.rows);
    const shown = this.relay.open(tile, this.viewerOf(from), start, () => this.opts.backend.screen(tile));
    if (!machine) return shown;
    // Whether its machine lends its keyboard is known once it runs (one a window has just placed
    // is in its workspace here only then): told again, if that changes who holds it.
    return shown.then((r) => {
      const now = this.keyboards.holder(tile);
      if (now?.id !== holder?.id && !from.closed.aborted) emit(from, "terminal.keyboard", tile, now);
      return r;
    });
  }

  /** Where a session's output, exit and size go: to every client that shows it. */
  private outputOf(tile: string): SessionOutput {
    return {
      data: (data) => this.relay.push(tile, data),
      exit: (code, signal) => this.relay.exit(tile, { code, signal }),
      size: (cols, rows) => {
        const was = this.sizes.get(tile);
        if (was?.cols === cols && was.rows === rows) return;
        this.sizes.set(tile, { cols, rows });
        this.opts.publish?.("terminal.size", tile, cols, rows);
      },
    };
  }

  private write(tile: string, data: string, paste: boolean | undefined, from: Connection): void {
    if (!this.keyboards.mayType(tile, from)) return;
    this.keyboards.typed(tile, from);
    // Among the host's windows, the last to type sizes the session; a guest does while they hold
    // its keyboard.
    if (isHost(from)) this.typers.set(tile, from);
    this.attribute(tile, from);
    if (this.opts.backend.echoes(tile)) this.relay.markInput(tile);
    this.opts.backend.write(tile, data, paste);
  }

  /** `from` types into `tile`: the others showing it are told who (again only after
   *  TYPING_EVERY_MS while the same one types on), and a guest's typing is marked in the audit
   *  log once a burst. */
  private attribute(tile: string, from: Connection): void {
    const now = Date.now();
    const told = this.typing.get(tile);
    if (told?.by !== from || now - told.at >= TYPING_EVERY_MS) {
      this.typing.set(tile, { by: from, at: now });
      const by = this.keyboards.typist(from);
      for (const c of this.openers.get(tile) ?? []) if (c !== from && !c.closed.aborted) emit(c, "terminal.typing", tile, by);
    }
    if (isHost(from)) return;
    let typed = this.typed.get(from);
    if (!typed) this.typed.set(from, (typed = new Map()));
    const last = typed.get(tile);
    typed.set(tile, now);
    if (last !== undefined && now - last < TYPED_BURST_MS) return;
    void this.opts.intents.perform(from.actor, { verb: "terminal.write", target: toBareId(tile) }, () => undefined)
      .catch((e: unknown) => this.opts.onError?.(`terminal.write ${toBareId(tile)}: ${e instanceof Error ? e.message : String(e)}`));
  }

  private resize(tile: string, cols: number, rows: number, from: Connection): void {
    const sizes = this.keyboards.sizes(tile, from);
    if (sizes === false) return;
    if (sizes === "host") {
      const typer = this.typers.get(tile);
      if (typer !== undefined && typer !== from && this.relay.count(tile) > 1) return;
    }
    this.opts.backend.resize(tile, cols, rows);
    this.sizes.set(tile, { cols, rows });
    this.opts.publish?.("terminal.size", tile, cols, rows);
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
    this.typing.delete(tile);
    this.openers.delete(tile);
    this.sizes.delete(tile);
    this.keyboards.forget(tile);
    this.machines.delete(tile);
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
    ...(o.tile == null ? {} : { tile: text(o.tile, "opts.tile") }),
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
