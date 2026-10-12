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
 *
 * A paced viewer (a phone, far away) acknowledges what it took. It is sent at most PACED_WINDOW
 * ahead of that; past it, nothing, until it has taken all it was sent, and then the screen in place
 * of what it missed. Nothing queues for it, and the session is never held back for it.
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

/** How far output goes ahead of a paced viewer's acknowledgements, in UTF-16 units: the screen
 *  sent in place of what it missed is not counted. */
export const PACED_WINDOW = 128 * 1024;

interface Pace {
  sent: number;
  taken: number;
  /** Where the last screen sent ends. */
  free: number;
  /** Past its window: it is sent the screen once it has taken all it was sent. */
  behind: boolean;
  screen: () => ReadScreen | null;
}

interface Watch {
  /** Not shown by any of its views: sent nothing while the host keeps the screen. */
  unseen: boolean;
  /** Its screen has been asked for and not yet sent. */
  awaiting: boolean;
  /** Output went to the others and not to it while it was unseen: shown again, it needs the
   *  screen. Nothing missed, what it shows is the screen still. */
  missed: boolean;
  pace?: Pace;
}

export interface SessionRelayOptions {
  /** Every batch, once, whoever watches (the control plane's recorder). */
  record(tileId: string, data: string): void;
  /** Sent before a screen, so it replaces what the viewer shows. */
  screenPrefix: string;
  /** Whether every viewer is hidden: batches then wait longer. */
  hidden?: () => boolean;
  /** A viewer was just sent the host's copy of the screen in place of what it showed. The program
   *  repaints only what it thinks changed, against the screen it drew; told nothing, it patches the
   *  copy wherever the two differ. */
  screenShown?(tileId: string): void;
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
  async open(tileId: string, viewer: Viewer, start: () => Promise<{ pid: number }>, screen: () => ReadScreen | null, paced = false): Promise<{ pid: number; joined: boolean }> {
    for (let wait = this.starting.get(tileId); wait; wait = this.starting.get(tileId)) await wait.catch(() => undefined);
    const pace = paced ? screen : undefined;
    const run = this.running.get(tileId);
    if (run) {
      const read = screen();
      if (read) this.join(tileId, viewer, read, pace);
      else this.add(tileId, viewer, pace);
      return { pid: run.pid, joined: run.starter !== viewer };
    }
    this.add(tileId, viewer, pace);
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
   *  its screen: live bytes only. With `paced`, the host's screen of it, it is paced. */
  add(tileId: string, viewer: Viewer, paced?: () => ReadScreen | null): void {
    this.watches(tileId).set(viewer, { unseen: false, awaiting: false, missed: false, pace: paceOf(paced) });
  }

  /** `viewer` joins a session others already watch: the host's screen first, then live bytes.
   *  False when the host keeps no screen; it then gets live bytes only. */
  join(tileId: string, viewer: Viewer, screen: ReadScreen, paced?: () => ReadScreen | null): boolean {
    const watch: Watch = { unseen: true, awaiting: true, missed: true, pace: paceOf(paced) };
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
   *  keeps the screen (`screen`); shown again, it is sent the screen if it missed output, then
   *  live bytes. */
  show(tileId: string, viewer: Viewer, shown: boolean, screen: ReadScreen | null): void {
    const watch = this.viewers.get(tileId)?.get(viewer);
    if (!watch) return;
    if (!shown) {
      watch.awaiting = false;
      if (screen) watch.unseen = true;
      return;
    }
    if (!watch.unseen || watch.awaiting || !screen) return;
    if (!watch.missed) { watch.unseen = false; return; }
    watch.awaiting = true;
    this.showScreen(tileId, viewer, watch, screen);
  }

  /** `viewer` asks for the screen again (with more of its history): sent in place of what it
   *  shows, then live bytes. */
  again(tileId: string, viewer: Viewer, screen: ReadScreen | null): void {
    const watch = this.viewers.get(tileId)?.get(viewer);
    if (!watch || watch.unseen || watch.awaiting || !screen) return;
    watch.awaiting = true;
    this.showScreen(tileId, viewer, watch, screen);
  }

  /** A paced `viewer` has taken `taken` of what it was sent, all told. Behind, and now taken all of
   *  it: the screen, in place of what it missed. */
  acked(tileId: string, viewer: Viewer, taken: number): void {
    const watch = this.viewers.get(tileId)?.get(viewer);
    const pace = watch?.pace;
    if (!watch || !pace) return;
    pace.taken = Math.max(pace.taken, Math.min(taken, pace.sent));
    if (!pace.behind || pace.taken < pace.sent || watch.awaiting) return;
    pace.behind = false;
    const read = pace.screen();
    if (!read) { watch.unseen = false; return; }
    watch.awaiting = true;
    this.showScreen(tileId, viewer, watch, read);
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
      watch.missed = false;
      if (replay !== null && viewer.alive()) {
        this.deliver(tileId, viewer, watch, this.opts.screenPrefix + replay);
        if (watch.pace) watch.pace.free = watch.pace.sent;
        this.opts.screenShown?.(tileId);
      }
    });
    if (!asked) { watch.awaiting = false; watch.unseen = false; }
    return asked;
  }

  private send(tileId: string, data: string): void {
    this.opts.record(tileId, data);
    for (const [viewer, watch] of this.viewers.get(tileId) ?? []) {
      if (watch.unseen) watch.missed = true;
      else if (!viewer.alive()) continue;
      else if (watch.pace && ahead(watch.pace, data.length)) {
        watch.pace.behind = true;
        watch.unseen = true;
        watch.missed = true;
      } else this.deliver(tileId, viewer, watch, data);
    }
  }

  private deliver(tileId: string, viewer: Viewer, watch: Watch, data: string): void {
    viewer.data(tileId, data);
    if (watch.pace) watch.pace.sent += data.length;
  }
}

function paceOf(screen: (() => ReadScreen | null) | undefined): Pace | undefined {
  return screen && { sent: 0, taken: 0, free: 0, behind: false, screen };
}

/** Whether `more` would take a paced viewer past its window: something it has not taken is out,
 *  and the host keeps a screen to send it in place of what it misses. A first batch always goes. */
function ahead(pace: Pace, more: number): boolean {
  const out = pace.sent - Math.max(pace.taken, pace.free);
  return out > 0 && out + more > PACED_WINDOW && pace.screen() !== null;
}
