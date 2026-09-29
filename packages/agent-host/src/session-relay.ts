/**
 * A session's output, to every viewer that shows it (docs/design/multiplayer-2026-09-28.md, R5):
 * the host holds one attach per session and fans its bytes out, so two windows (later, two
 * devices) show one terminal live. Output is coalesced per session once (PtyOutputBuffer), and
 * each batch goes to every viewer that wants it.
 *
 * A viewer that joins a session others already watch is sent the screen as the host keeps it,
 * then live bytes. A viewer none of whose views shows the session is sent nothing for it while
 * the host keeps its screen, and the screen again when it shows it. An exit reaches every viewer.
 *
 * A session is started once, however many viewers open it at once: the first starts it, the rest
 * wait for that start and join. The one that started it gives it its first task.
 */
import { PtyOutputBuffer } from "./pty-output-buffer.js";

/** One place a session shows: a window, later a device. */
export interface Viewer {
  /** Output: a batch, or a screen (after `screenPrefix`) that replaces what it shows. */
  data(tileId: string, data: string): void;
  exit(tileId: string, info: { code: number; signal?: number }): void;
  /** False once it is gone (a window closed). */
  alive(): boolean;
}

/** The host's screen for a session, read in order with its output: `cb` runs where every later
 *  batch carries bytes the screen does not show. False when the host keeps none. */
export type ReadScreen = (cb: (screen: string | null) => void) => boolean;

interface Watch {
  /** Not shown by any of its views: sent nothing while the host keeps the screen. */
  unseen: boolean;
  /** Its screen has been asked for and not yet sent. */
  awaiting: boolean;
}

export interface SessionRelayOptions {
  /** Every batch, once, whoever watches (the control plane's recorder). */
  record(tileId: string, data: string): void;
  /** Sent before a screen, so it replaces what the viewer shows. */
  screenPrefix: string;
  /** Whether every viewer is hidden: batches then wait longer. */
  hidden?: () => boolean;
}

export class SessionRelay {
  private readonly viewers = new Map<string, Map<Viewer, Watch>>();
  /** Sessions running, with the pid they run as and the viewer that started them. */
  private readonly running = new Map<string, { pid: number; starter: Viewer }>();
  /** Starts not yet answered. */
  private readonly starting = new Map<string, Promise<{ pid: number }>>();
  private readonly out: PtyOutputBuffer;

  constructor(private readonly opts: SessionRelayOptions) {
    this.out = new PtyOutputBuffer((tileId, data) => this.send(tileId, data), { hidden: opts.hidden });
  }

  /** Viewers of `tileId`. */
  count(tileId: string): number {
    return this.viewers.get(tileId)?.size ?? 0;
  }

  /**
   * `viewer` shows `tileId`. The first to open it starts it with `start` and watches it from its
   * first byte; one that opens it while it starts waits for that start; one that opens it once it
   * runs joins it, the host's screen (`screen`) first. `joined`: another viewer started it, and
   * gave it its first task. A start that fails, or finds no session (pid -1), leaves no viewer.
   */
  async open(tileId: string, viewer: Viewer, start: () => Promise<{ pid: number }>, screen: () => ReadScreen | null): Promise<{ pid: number; joined: boolean }> {
    for (let wait = this.starting.get(tileId); wait; wait = this.starting.get(tileId)) await wait.catch(() => undefined);
    const run = this.running.get(tileId);
    if (run) {
      const read = screen();
      if (read) this.join(tileId, viewer, read);
      else this.add(tileId, viewer);
      return { pid: run.pid, joined: run.starter !== viewer };
    }
    this.add(tileId, viewer);
    const started = start();
    this.starting.set(tileId, started);
    try {
      const { pid } = await started;
      if (pid === -1) this.leave(tileId, viewer);
      else this.running.set(tileId, { pid, starter: viewer });
      return { pid, joined: false };
    } catch (e) {
      this.leave(tileId, viewer);
      throw e;
    } finally {
      if (this.starting.get(tileId) === started) this.starting.delete(tileId);
    }
  }

  /** `viewer` shows `tileId` from now on, from the session's own start or an attach that brought
   *  its screen: live bytes only. */
  add(tileId: string, viewer: Viewer): void {
    this.watches(tileId).set(viewer, { unseen: false, awaiting: false });
  }

  /** `viewer` joins a session others already watch: the host's screen first, then live bytes.
   *  False when the host keeps no screen; it then gets live bytes only. */
  join(tileId: string, viewer: Viewer, screen: ReadScreen): boolean {
    const watch: Watch = { unseen: true, awaiting: true };
    this.watches(tileId).set(viewer, watch);
    return this.showScreen(tileId, viewer, watch, screen);
  }

  /** `viewer` lets go of `tileId`. How many still watch it. */
  leave(tileId: string, viewer: Viewer): number {
    const watches = this.viewers.get(tileId);
    watches?.delete(viewer);
    if (watches?.size === 0) this.viewers.delete(tileId);
    return this.count(tileId);
  }

  /** `viewer` is gone (its window closed): it leaves every session. Those nobody watches now. */
  leaveAll(viewer: Viewer): string[] {
    const unwatched: string[] = [];
    for (const [tileId, watches] of this.viewers) {
      if (!watches.delete(viewer)) continue;
      if (watches.size === 0) { this.viewers.delete(tileId); unwatched.push(tileId); }
    }
    return unwatched;
  }

  /** Whether any of `viewer`'s views shows `tileId`. Hidden, it is sent nothing while the host
   *  keeps the screen (`screen`); shown again, it is sent the screen, then live bytes. */
  show(tileId: string, viewer: Viewer, shown: boolean, screen: ReadScreen | null): void {
    const watch = this.viewers.get(tileId)?.get(viewer);
    if (!watch) return;
    if (!shown) {
      watch.awaiting = false;
      if (screen) watch.unseen = true;
      return;
    }
    if (!watch.unseen || watch.awaiting || !screen) return;
    watch.awaiting = true;
    this.showScreen(tileId, viewer, watch, screen);
  }

  /** Session output, coalesced. */
  push(tileId: string, data: string): void {
    this.out.push(tileId, data);
  }

  /** A person typed into `tileId`: its echo skips the batching. */
  markInput(tileId: string): void {
    this.out.markInput(tileId);
  }

  /** The session ended: what is pending, then the exit, to every viewer. */
  exit(tileId: string, info: { code: number; signal?: number }): void {
    this.out.flush(tileId);
    this.out.forget(tileId);
    for (const viewer of this.viewers.get(tileId)?.keys() ?? []) {
      if (viewer.alive()) viewer.exit(tileId, info);
    }
    this.viewers.delete(tileId);
    this.running.delete(tileId);
  }

  /** Forget `tileId` without a word to its viewers (the tile closed). */
  forget(tileId: string): void {
    this.out.forget(tileId);
    this.viewers.delete(tileId);
    this.running.delete(tileId);
  }

  private watches(tileId: string): Map<Viewer, Watch> {
    let watches = this.viewers.get(tileId);
    if (!watches) this.viewers.set(tileId, (watches = new Map()));
    return watches;
  }

  private showScreen(tileId: string, viewer: Viewer, watch: Watch, screen: ReadScreen): boolean {
    const asked = screen((replay) => {
      // Hidden again, or gone, meanwhile.
      if (!watch.awaiting || this.viewers.get(tileId)?.get(viewer) !== watch) return;
      watch.awaiting = false;
      // What is pending now is older than this screen: it goes to the others first.
      this.out.flush(tileId);
      watch.unseen = false;
      if (replay !== null && viewer.alive()) viewer.data(tileId, this.opts.screenPrefix + replay);
    });
    if (!asked) { watch.awaiting = false; watch.unseen = false; }
    return asked;
  }

  private send(tileId: string, data: string): void {
    this.opts.record(tileId, data);
    for (const [viewer, watch] of this.viewers.get(tileId) ?? []) {
      if (!watch.unseen && viewer.alive()) viewer.data(tileId, data);
    }
  }
}
